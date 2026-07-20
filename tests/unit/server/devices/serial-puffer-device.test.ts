import { afterEach, describe, expect, it, vi } from "vitest";

import { SerialPufferDevice } from "../../../../src/server/devices/serial-puffer-device.js";
import {
  DeviceCommandSupersededError,
  DeviceFaultError,
  DeviceNotConnectedError,
  DeviceProtocolError,
  DeviceTimeoutError,
} from "../../../../src/server/devices/types.js";

type DataListener = (data: Buffer) => void;
type ErrorListener = (error: Error) => void;
type CloseListener = () => void;

interface WrittenCommand {
  readonly v: number;
  readonly requestId: string;
  readonly cmd: string;
  readonly level?: number;
  readonly rampMs?: number;
}

class FakeSerialPort {
  public isOpen = false;
  public readonly writes: string[] = [];
  public autoAck = true;
  public deferOpen = false;
  public closeCalls = 0;
  public synchronousWriteFailures = 0;
  private deferredOpenCallback: ((error?: Error | null) => void) | null = null;
  private readonly dataListeners = new Set<DataListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly closeListeners = new Set<CloseListener>();

  public open(callback: (error?: Error | null) => void): void {
    if (this.deferOpen) {
      this.deferredOpenCallback = callback;
      return;
    }
    this.isOpen = true;
    callback();
  }

  public close(callback: (error?: Error | null) => void): void {
    this.closeCalls += 1;
    this.isOpen = false;
    callback();
    for (const listener of this.closeListeners) listener();
  }

  public write(data: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(data);
    const command = JSON.parse(data.trim()) as WrittenCommand;
    if (this.synchronousWriteFailures > 0) {
      this.synchronousWriteFailures -= 1;
      throw new Error("injected synchronous write failure");
    }
    callback?.();
    if (this.autoAck) {
      queueMicrotask(() => this.ack(command));
    }
    return true;
  }

  public completeOpen(error?: Error): void {
    const callback = this.deferredOpenCallback;
    if (callback === null) throw new Error("No deferred open is pending.");
    this.deferredOpenCallback = null;
    if (error === undefined) this.isOpen = true;
    callback(error);
  }

  public on(event: "data", listener: DataListener): this;
  public on(event: "error", listener: ErrorListener): this;
  public on(event: "close", listener: CloseListener): this;
  public on(event: "data" | "error" | "close", listener: DataListener | ErrorListener | CloseListener): this {
    if (event === "data") this.dataListeners.add(listener as DataListener);
    if (event === "error") this.errorListeners.add(listener as ErrorListener);
    if (event === "close") this.closeListeners.add(listener as CloseListener);
    return this;
  }

  public off(event: "data", listener: DataListener): this;
  public off(event: "error", listener: ErrorListener): this;
  public off(event: "close", listener: CloseListener): this;
  public off(event: "data" | "error" | "close", listener: DataListener | ErrorListener | CloseListener): this {
    if (event === "data") this.dataListeners.delete(listener as DataListener);
    if (event === "error") this.errorListeners.delete(listener as ErrorListener);
    if (event === "close") this.closeListeners.delete(listener as CloseListener);
    return this;
  }

  public commands(): readonly WrittenCommand[] {
    return this.writes.map((line) => JSON.parse(line.trim()) as WrittenCommand);
  }

  public ack(command: WrittenCommand | undefined): void {
    if (command === undefined) throw new Error("No command to acknowledge.");
    const state = command.cmd === "inflate"
      ? "inflating"
      : command.cmd === "deflate"
        ? "deflating"
        : command.cmd === "stop"
          ? "stopped"
          : "idle";
    this.send({
      v: 1,
      requestId: command.requestId,
      ok: true,
      state,
      level: command.cmd === "inflate" ? command.level ?? 0 : 0,
      fault: null,
    });
  }

  public send(value: unknown): void {
    const data = Buffer.from(`${typeof value === "string" ? value : JSON.stringify(value)}\n`, "utf8");
    for (const listener of this.dataListeners) listener(data);
  }

  public fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  public unexpectedClose(): void {
    this.isOpen = false;
    for (const listener of this.closeListeners) listener();
  }
}

function setup(override: { ackTimeoutMs?: number; stopAckTimeoutMs?: number } = {}) {
  const port = new FakeSerialPort();
  const device = new SerialPufferDevice({
    path: "COM-TEST",
    baudRate: 115_200,
    ackTimeoutMs: override.ackTimeoutMs ?? 1_000,
    stopAckTimeoutMs: override.stopAckTimeoutMs ?? 500,
    portFactory: () => port,
  });
  return { device, port };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SerialPufferDevice", () => {
  it("uses newline-delimited protocol v1 JSON and matches request IDs", async () => {
    const { device, port } = setup();
    const states: string[] = [];
    device.onStatus((status) => states.push(status.state));
    await device.connect();
    expect(await device.ping()).toMatchObject({ connected: true, state: "idle" });
    expect(await device.inflate({ requestId: "inflate-request", level: 0.6, rampMs: 6_000 }))
      .toMatchObject({ requestId: "inflate-request", state: "inflating", level: 0.6 });
    expect(port.writes.every((line) => line.endsWith("\n"))).toBe(true);
    expect(port.commands()).toEqual([
      expect.objectContaining({ v: 1, cmd: "ping" }),
      { v: 1, requestId: "inflate-request", cmd: "inflate", level: 0.6, rampMs: 6_000 },
    ]);
    expect(states).toEqual(expect.arrayContaining(["disconnected", "connecting", "idle", "inflating"]));
  });

  it("gives STOP priority over an outstanding command", async () => {
    const { device, port } = setup();
    port.autoAck = false;
    await device.connect();
    const inflate = device.inflate({ requestId: "pending-inflate", level: 0.6, rampMs: 6_000 });
    const inflateRejection = expect(inflate).rejects.toBeInstanceOf(DeviceCommandSupersededError);
    const stop = device.stop({ requestId: "priority-stop" });
    await inflateRejection;
    port.ack(port.commands().at(-1));
    expect(await stop).toMatchObject({ requestId: "priority-stop", state: "stopped" });
    expect(port.commands().slice(-2).map((command) => command.cmd)).toEqual(["inflate", "stop"]);
  });

  it("times out an ACK and immediately sends a best-effort STOP", async () => {
    vi.useFakeTimers();
    const { device, port } = setup({ ackTimeoutMs: 100 });
    port.autoAck = false;
    await device.connect();
    const ping = device.ping();
    const rejection = expect(ping).rejects.toBeInstanceOf(DeviceTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(port.commands().map((command) => command.cmd)).toEqual(["ping", "stop"]);
  });

  it("fails closed on malformed JSON, unknown request IDs and invalid ACKs", async () => {
    const malformed = setup();
    malformed.port.autoAck = false;
    await malformed.device.connect();
    const pendingMalformed = malformed.device.ping();
    const malformedRejection = expect(pendingMalformed).rejects.toBeInstanceOf(DeviceProtocolError);
    malformed.port.send("{broken");
    await malformedRejection;
    expect(malformed.port.commands().at(-1)?.cmd).toBe("stop");

    const mismatch = setup();
    mismatch.port.autoAck = false;
    await mismatch.device.connect();
    const pendingMismatch = mismatch.device.ping();
    const mismatchRejection = expect(pendingMismatch).rejects.toBeInstanceOf(DeviceProtocolError);
    mismatch.port.send({ v: 1, requestId: "wrong", ok: true, state: "idle" });
    await mismatchRejection;
    expect(mismatch.port.commands().at(-1)?.cmd).toBe("stop");

    const invalid = setup();
    invalid.port.autoAck = false;
    await invalid.device.connect();
    const pendingInvalid = invalid.device.ping();
    const invalidRejection = expect(pendingInvalid).rejects.toBeInstanceOf(DeviceProtocolError);
    const request = invalid.port.commands()[0];
    invalid.port.send({ v: 2, requestId: request?.requestId, ok: true, state: "idle" });
    await invalidRejection;
  });

  it("rejects a successful ACK whose state contradicts the pending command", async () => {
    const { device, port } = setup();
    port.autoAck = false;
    await device.connect();
    const inflate = device.inflate({ requestId: "contradictory-inflate", level: 0.6, rampMs: 6_000 });
    const rejection = expect(inflate).rejects.toBeInstanceOf(DeviceProtocolError);

    port.send({
      v: 1,
      requestId: "contradictory-inflate",
      ok: true,
      state: "idle",
      level: 0,
      fault: null,
    });

    await rejection;
    expect(port.commands().map((command) => command.cmd).slice(-2)).toEqual(["inflate", "stop"]);
  });

  it("fails closed on an explicit negative ACK and exposes immutable command history", async () => {
    const { device, port } = setup();
    port.autoAck = false;
    const statuses: string[] = [];
    const unsubscribe = device.onStatus((status) => statuses.push(status.state));
    await device.connect();
    const inflate = device.inflate({ requestId: "rejected-inflate", level: 0.6, rampMs: 6_000 });
    const rejection = expect(inflate).rejects.toBeInstanceOf(DeviceFaultError);

    port.send({
      v: 1,
      requestId: "rejected-inflate",
      ok: false,
      state: "fault",
      level: 0,
      errorCode: "OVERPRESSURE",
    });

    await rejection;
    unsubscribe();
    expect(statuses).toContain("fault");
    expect(Object.isFrozen(device.commandHistory)).toBe(true);
    expect(device.commandHistory.map((entry) => entry.command).slice(-2)).toEqual(["inflate", "stop"]);
  });

  it("turns a synchronous serial write exception into a safe rejection and STOP attempt", async () => {
    const { device, port } = setup();
    await device.connect();
    port.synchronousWriteFailures = 1;

    await expect(device.ping()).rejects.toBeInstanceOf(DeviceNotConnectedError);

    expect(port.commands().map((command) => command.cmd)).toEqual(["ping", "stop"]);
  });

  it("times out a serial open and closes a port that opens after the timeout", async () => {
    vi.useFakeTimers();
    const { device, port } = setup({ ackTimeoutMs: 100 });
    port.deferOpen = true;
    const connecting = device.connect();
    const rejection = expect(connecting).rejects.toBeInstanceOf(DeviceNotConnectedError);

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    await expect(device.getStatus()).rejects.toBeInstanceOf(DeviceNotConnectedError);

    port.completeOpen();
    await vi.runAllTicks();
    expect(port.closeCalls).toBe(1);
    expect(port.isOpen).toBe(false);
    await expect(device.getStatus()).rejects.toBeInstanceOf(DeviceNotConnectedError);
  });

  it("allows STOP to be repeated while an earlier STOP acknowledgement is pending", async () => {
    const { device, port } = setup();
    port.autoAck = false;
    await device.connect();

    const firstStop = device.stop({ requestId: "repeat-stop-1" });
    const secondStop = device.stop({ requestId: "repeat-stop-2" });
    const commands = port.commands();
    port.ack(commands.find((command) => command.requestId === "repeat-stop-1"));
    port.ack(commands.find((command) => command.requestId === "repeat-stop-2"));

    await expect(firstStop).resolves.toMatchObject({ requestId: "repeat-stop-1", state: "stopped" });
    await expect(secondStop).resolves.toMatchObject({ requestId: "repeat-stop-2", state: "stopped" });
    expect(commands.map((command) => command.cmd)).toEqual(["stop", "stop"]);
  });

  it("handles ready/fault events and unexpected connection loss", async () => {
    const { device, port } = setup();
    await device.connect();
    port.send({ v: 1, event: "ready", state: "idle", level: 0 });
    expect(await device.getStatus()).toMatchObject({ state: "idle", fault: null });
    port.send({ v: 1, event: "fault", state: "fault", errorCode: "OVERPRESSURE" });
    expect(port.commands().at(-1)?.cmd).toBe("stop");

    port.unexpectedClose();
    await expect(device.getStatus()).rejects.toBeInstanceOf(DeviceNotConnectedError);
  });

  it("attempts STOP then DEFLATE before a normal serial close", async () => {
    const { device, port } = setup();
    await device.connect();
    await device.disconnect();
    expect(port.commands().slice(-3).map((command) => command.cmd)).toEqual(["stop", "deflate", "status"]);
    await expect(device.disconnect()).resolves.toBeUndefined();
  });

  it("validates construction and commands", async () => {
    expect(() => new SerialPufferDevice({
      path: "",
      baudRate: 115_200,
      ackTimeoutMs: 1_000,
    })).toThrow(TypeError);
    expect(() => new SerialPufferDevice({
      path: "COM-TEST",
      baudRate: 0,
      ackTimeoutMs: 1_000,
    })).toThrow(RangeError);
    expect(() => new SerialPufferDevice({
      path: "COM-TEST",
      baudRate: 115_200,
      ackTimeoutMs: 0,
    })).toThrow(RangeError);

    const { device } = setup();
    await expect(device.ping()).rejects.toBeInstanceOf(DeviceNotConnectedError);
    await device.connect();
    await expect(device.inflate({ requestId: "inflate", level: -0.1, rampMs: 1 })).rejects.toThrow(RangeError);
  });
});
