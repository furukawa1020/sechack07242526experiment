import { randomUUID } from "node:crypto";

import { SerialPort } from "serialport";

import {
  PUFFER_DEVICE_STATES,
  type PufferDeviceState,
} from "../../shared/experiment-machine.js";
import {
  assertNormalizedLevel,
  assertRampMs,
  assertRequestId,
  DeviceCommandSupersededError,
  DeviceFaultError,
  DeviceNotConnectedError,
  DeviceProtocolError,
  DeviceTimeoutError,
  type DeflateInput,
  type DeviceAck,
  type DeviceCommandHistoryEntry,
  type DeviceCommandName,
  type DeviceStatus,
  type DeviceStatusListener,
  type InflateInput,
  type PufferDevice,
  type StopInput,
} from "./types.js";

interface SerialPortLike {
  readonly isOpen: boolean;
  open(callback: (error?: Error | null) => void): void;
  close(callback: (error?: Error | null) => void): void;
  write(data: string, callback?: (error?: Error | null) => void): boolean;
  on(event: "data", listener: (data: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
  off(event: "data", listener: (data: Buffer) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "close", listener: () => void): this;
}

export interface SerialPufferDeviceOptions {
  readonly path: string;
  readonly baudRate: number;
  readonly ackTimeoutMs: number;
  readonly stopAckTimeoutMs?: number;
  readonly defaultDeflateRampMs?: number;
  readonly maxLineBytes?: number;
  readonly now?: () => Date;
  readonly portFactory?: (options: { readonly path: string; readonly baudRate: number }) => SerialPortLike;
}

interface PendingRequest {
  readonly command: DeviceCommandName;
  readonly resolve: (ack: DeviceAck) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ProtocolCommand {
  readonly v: 1;
  readonly requestId: string;
  readonly cmd: DeviceCommandName;
  readonly level?: number;
  readonly rampMs?: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPufferDeviceState(value: unknown): value is PufferDeviceState {
  return typeof value === "string" && PUFFER_DEVICE_STATES.some((state) => state === value);
}

export class SerialPufferDevice implements PufferDevice {
  private readonly options: Required<Pick<
    SerialPufferDeviceOptions,
    "path" | "baudRate" | "ackTimeoutMs" | "stopAckTimeoutMs" | "defaultDeflateRampMs" | "maxLineBytes"
  >>;
  private readonly now: () => Date;
  private readonly portFactory: NonNullable<SerialPufferDeviceOptions["portFactory"]>;
  private readonly listeners = new Set<DeviceStatusListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ignoredRequestIds = new Set<string>();
  private readonly entries: DeviceCommandHistoryEntry[] = [];
  private port: SerialPortLike | null = null;
  private receiveBuffer = "";
  private intentionalClose = false;
  private connected = false;
  private state: PufferDeviceState = "disconnected";
  private level = 0;
  private fault: string | null = null;

  public constructor(options: SerialPufferDeviceOptions) {
    if (options.path.trim().length === 0 || /[\0\r\n]/u.test(options.path)) {
      throw new TypeError("A valid serial path is required.");
    }
    if (!Number.isInteger(options.baudRate) || options.baudRate <= 0) {
      throw new RangeError("baudRate must be a positive integer.");
    }
    if (!Number.isInteger(options.ackTimeoutMs) || options.ackTimeoutMs <= 0) {
      throw new RangeError("ackTimeoutMs must be a positive integer.");
    }
    this.options = {
      path: options.path,
      baudRate: options.baudRate,
      ackTimeoutMs: options.ackTimeoutMs,
      stopAckTimeoutMs: options.stopAckTimeoutMs ?? 500,
      defaultDeflateRampMs: options.defaultDeflateRampMs ?? 6_000,
      maxLineBytes: options.maxLineBytes ?? 16_384,
    };
    assertRampMs(this.options.defaultDeflateRampMs);
    this.now = options.now ?? (() => new Date());
    this.portFactory = options.portFactory ?? ((portOptions) => new SerialPort({
      path: portOptions.path,
      baudRate: portOptions.baudRate,
      autoOpen: false,
    }) as unknown as SerialPortLike);
  }

  public get commandHistory(): readonly DeviceCommandHistoryEntry[] {
    return Object.freeze([...this.entries]);
  }

  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.port !== null) {
      this.detachPort(this.port);
    }
    const port = this.portFactory({ path: this.options.path, baudRate: this.options.baudRate });
    this.port = port;
    this.intentionalClose = false;
    this.state = "connecting";
    this.fault = null;
    this.emitStatus();
    this.attachPort(port);

    try {
      await new Promise<void>((resolve, reject) => {
        port.open((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } catch (error) {
      this.detachPort(port);
      this.port = null;
      this.connected = false;
      this.state = "disconnected";
      this.emitStatus();
      throw new DeviceNotConnectedError(
        `Could not open serial device: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    this.connected = true;
    this.state = "idle";
    this.level = 0;
    this.emitStatus();
  }

  public async disconnect(): Promise<void> {
    const port = this.port;
    if (port === null) {
      this.connected = false;
      this.state = "disconnected";
      return;
    }

    const safetyErrors: Error[] = [];
    if (this.connected && port.isOpen) {
      try {
        await this.stop({ requestId: randomUUID() });
      } catch (error) {
        safetyErrors.push(error instanceof Error ? error : new Error("Unknown STOP failure."));
        this.writeEmergencyStop();
      }
      try {
        await this.deflate({ requestId: randomUUID(), rampMs: this.options.defaultDeflateRampMs });
      } catch (error) {
        safetyErrors.push(error instanceof Error ? error : new Error("Unknown DEFLATE failure."));
      }
    }

    this.intentionalClose = true;
    this.rejectAllPending(new DeviceNotConnectedError("Serial device is closing."));
    if (port.isOpen) {
      try {
        await new Promise<void>((resolve, reject) => {
          port.close((error) => {
            if (error !== undefined && error !== null) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      } catch (error) {
        safetyErrors.push(error instanceof Error ? error : new Error("Unknown serial close failure."));
      }
    }
    this.detachPort(port);
    this.port = null;
    this.connected = false;
    this.state = "disconnected";
    this.emitStatus();
    if (safetyErrors.length > 0) {
      throw new AggregateError(safetyErrors, "Serial device shutdown did not complete cleanly.");
    }
  }

  public async ping(): Promise<DeviceStatus> {
    await this.sendCommand({ v: 1, requestId: randomUUID(), cmd: "ping" });
    return this.snapshot();
  }

  public async getStatus(): Promise<DeviceStatus> {
    await this.sendCommand({ v: 1, requestId: randomUUID(), cmd: "status" });
    return this.snapshot();
  }

  public async inflate(input: InflateInput): Promise<DeviceAck> {
    assertRequestId(input.requestId);
    assertNormalizedLevel(input.level);
    assertRampMs(input.rampMs);
    return this.sendCommand({
      v: 1,
      requestId: input.requestId,
      cmd: "inflate",
      level: input.level,
      rampMs: input.rampMs,
    });
  }

  public async deflate(input: DeflateInput): Promise<DeviceAck> {
    assertRequestId(input.requestId);
    assertRampMs(input.rampMs);
    return this.sendCommand({
      v: 1,
      requestId: input.requestId,
      cmd: "deflate",
      rampMs: input.rampMs,
    });
  }

  public async stop(input: StopInput): Promise<DeviceAck> {
    assertRequestId(input.requestId);
    this.cancelPendingForStop();
    return this.sendCommand({ v: 1, requestId: input.requestId, cmd: "stop" });
  }

  public onStatus(listener: DeviceStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private sendCommand(command: ProtocolCommand): Promise<DeviceAck> {
    this.assertConnected();
    if (this.pending.has(command.requestId)) {
      throw new DeviceProtocolError(`Duplicate requestId: ${command.requestId}`);
    }
    this.record(command);
    const timeoutMs = command.cmd === "stop"
      ? this.options.stopAckTimeoutMs
      : this.options.ackTimeoutMs;

    return new Promise<DeviceAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.requestId);
        this.ignoredRequestIds.add(command.requestId);
        const error = new DeviceTimeoutError(command.cmd);
        reject(error);
        if (command.cmd !== "stop") {
          this.handleCommunicationFault(error.code);
        }
      }, timeoutMs);
      this.pending.set(command.requestId, { command: command.cmd, resolve, reject, timer });

      const serialized = `${JSON.stringify(command)}\n`;
      this.port?.write(serialized, (error) => {
        if (error !== undefined && error !== null) {
          const pending = this.takePending(command.requestId);
          pending?.reject(new DeviceNotConnectedError(`Serial write failed: ${error.message}`));
          if (command.cmd !== "stop") {
            this.handleCommunicationFault("SERIAL_WRITE_FAILED");
          }
        }
      });
    });
  }

  private readonly handleData = (chunk: Buffer): void => {
    this.receiveBuffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.receiveBuffer, "utf8") > this.options.maxLineBytes) {
      this.handleInvalidResponse(new DeviceProtocolError("Serial response exceeded the line limit."));
      this.receiveBuffer = "";
      return;
    }
    let lineBreakIndex = this.receiveBuffer.indexOf("\n");
    while (lineBreakIndex >= 0) {
      const line = this.receiveBuffer.slice(0, lineBreakIndex).replace(/\r$/u, "");
      this.receiveBuffer = this.receiveBuffer.slice(lineBreakIndex + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      lineBreakIndex = this.receiveBuffer.indexOf("\n");
    }
  };

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      this.handleInvalidResponse(new DeviceProtocolError("Device returned malformed JSON.", { cause: error }));
      return;
    }
    if (!isRecord(message) || message.v !== 1) {
      this.handleInvalidResponse(new DeviceProtocolError("Device response has an invalid protocol version."));
      return;
    }

    if ("event" in message) {
      this.handleEvent(message);
      return;
    }
    this.handleAck(message);
  }

  private handleEvent(message: UnknownRecord): void {
    if (message.event === "ready" && isPufferDeviceState(message.state)) {
      if (message.level !== undefined && (typeof message.level !== "number" || message.level < 0 || message.level > 1)) {
        this.handleInvalidResponse(new DeviceProtocolError("Ready event has an invalid level."));
        return;
      }
      this.state = message.state;
      this.level = typeof message.level === "number" ? message.level : this.level;
      this.fault = null;
      this.emitStatus();
      return;
    }
    if (message.event === "fault" && message.state === "fault" && typeof message.errorCode === "string") {
      this.state = "fault";
      this.fault = message.errorCode;
      this.emitStatus();
      this.rejectAllPending(new DeviceFaultError(message.errorCode));
      this.writeEmergencyStop();
      return;
    }
    this.handleInvalidResponse(new DeviceProtocolError("Device returned an invalid asynchronous event."));
  }

  private handleAck(message: UnknownRecord): void {
    if (
      typeof message.requestId !== "string"
      || typeof message.ok !== "boolean"
      || !isPufferDeviceState(message.state)
      || (message.level !== undefined && (typeof message.level !== "number" || message.level < 0 || message.level > 1))
      || (message.errorCode !== undefined && typeof message.errorCode !== "string")
      || (message.fault !== undefined && message.fault !== null && typeof message.fault !== "string")
    ) {
      this.handleInvalidResponse(new DeviceProtocolError("Device returned an invalid acknowledgement."));
      return;
    }

    if (this.ignoredRequestIds.delete(message.requestId)) {
      return;
    }
    const pending = this.takePending(message.requestId);
    if (pending === undefined) {
      this.handleInvalidResponse(new DeviceProtocolError("Device returned an unknown requestId."));
      return;
    }

    this.state = message.state;
    this.level = typeof message.level === "number" ? message.level : this.level;
    this.fault = typeof message.fault === "string"
      ? message.fault
      : message.ok
        ? null
        : typeof message.errorCode === "string"
          ? message.errorCode
          : "DEVICE_FAULT";
    this.emitStatus();

    if (!message.ok) {
      const errorCode = typeof message.errorCode === "string" ? message.errorCode : "DEVICE_FAULT";
      pending.reject(new DeviceFaultError(errorCode));
      this.writeEmergencyStop();
      return;
    }

    pending.resolve(Object.freeze({
      requestId: message.requestId,
      ok: true,
      state: message.state,
      level: this.level,
      errorCode: null,
    }));
  }

  private handleInvalidResponse(error: DeviceProtocolError): void {
    this.rejectAllPending(error);
    this.handleCommunicationFault(error.code);
  }

  private handleCommunicationFault(errorCode: string): void {
    this.state = "fault";
    this.fault = errorCode;
    this.emitStatus();
    this.writeEmergencyStop();
  }

  private writeEmergencyStop(): void {
    const port = this.port;
    if (port === null || !port.isOpen) {
      return;
    }
    const requestId = randomUUID();
    this.ignoredRequestIds.add(requestId);
    const command: ProtocolCommand = { v: 1, requestId, cmd: "stop" };
    this.record(command);
    port.write(`${JSON.stringify(command)}\n`);
  }

  private cancelPendingForStop(): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.command !== "stop") {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        this.ignoredRequestIds.add(requestId);
        pending.reject(new DeviceCommandSupersededError(pending.command));
      }
    }
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
    }
    return pending;
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      this.ignoredRequestIds.add(requestId);
      pending.reject(error);
    }
  }

  private readonly handleSerialError = (): void => {
    if (!this.intentionalClose) {
      this.rejectAllPending(new DeviceNotConnectedError("Serial connection failed."));
      this.handleCommunicationFault("SERIAL_ERROR");
    }
  };

  private readonly handleSerialClose = (): void => {
    const wasIntentional = this.intentionalClose;
    this.connected = false;
    this.state = "disconnected";
    if (!wasIntentional) {
      this.fault = "SERIAL_DISCONNECTED";
      this.rejectAllPending(new DeviceNotConnectedError("Serial device disconnected unexpectedly."));
      this.writeEmergencyStop();
    }
    this.emitStatus();
  };

  private attachPort(port: SerialPortLike): void {
    port.on("data", this.handleData);
    port.on("error", this.handleSerialError);
    port.on("close", this.handleSerialClose);
  }

  private detachPort(port: SerialPortLike): void {
    port.off("data", this.handleData);
    port.off("error", this.handleSerialError);
    port.off("close", this.handleSerialClose);
  }

  private assertConnected(): void {
    if (!this.connected || this.port === null || !this.port.isOpen) {
      throw new DeviceNotConnectedError();
    }
  }

  private record(command: ProtocolCommand): void {
    this.entries.push(Object.freeze({
      command: command.cmd,
      requestId: command.requestId,
      level: command.level ?? null,
      rampMs: command.rampMs ?? null,
      issuedAt: this.now().toISOString(),
    }));
  }

  private snapshot(): DeviceStatus {
    return Object.freeze({
      connected: this.connected,
      state: this.state,
      level: this.level,
      fault: this.fault,
      updatedAt: this.now().toISOString(),
    });
  }

  private emitStatus(): void {
    const status = this.snapshot();
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}
