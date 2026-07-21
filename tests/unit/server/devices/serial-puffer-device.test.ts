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
  public synchronousWriteFailureValue: unknown = new Error("injected synchronous write failure");
  public asynchronousWriteFailures = 0;
  public closeError: Error | null = null;
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
    if (this.closeError !== null) {
      callback(this.closeError);
      return;
    }
    this.isOpen = false;
    callback();
    for (const listener of this.closeListeners) listener();
  }

  public write(data: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(data);
    const command = JSON.parse(data.trim()) as WrittenCommand;
    if (this.synchronousWriteFailures > 0) {
      this.synchronousWriteFailures -= 1;
      throw this.synchronousWriteFailureValue;
    }
    if (this.asynchronousWriteFailures > 0) {
      this.asynchronousWriteFailures -= 1;
      queueMicrotask(() => callback?.(new Error("injected asynchronous write failure")));
      return true;
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

  public closeWithoutEvent(): void {
    this.isOpen = false;
  }
}

function setup(override: {
  ackTimeoutMs?: number;
  stopAckTimeoutMs?: number;
  maxLineBytes?: number;
} = {}) {
  const port = new FakeSerialPort();
  const device = new SerialPufferDevice({
    path: "COM-TEST",
    baudRate: 115_200,
    ackTimeoutMs: override.ackTimeoutMs ?? 1_000,
    stopAckTimeoutMs: override.stopAckTimeoutMs ?? 500,
    ...(override.maxLineBytes === undefined ? {} : { maxLineBytes: override.maxLineBytes }),
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

  it("times out STOP without recursively issuing another STOP", async () => {
    vi.useFakeTimers();
    const { device, port } = setup({ stopAckTimeoutMs: 50 });
    port.autoAck = false;
    await device.connect();
    const stop = device.stop({ requestId: "timed-out-stop" });
    const rejection = expect(stop).rejects.toBeInstanceOf(DeviceTimeoutError);

    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    expect(port.commands().map((command) => command.cmd)).toEqual(["stop"]);
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

  it("fails closed on invalid events and malformed ACK fields", async () => {
    const invalidReady = setup();
    const readyStates: Array<{ state: string; level: number }> = [];
    invalidReady.device.onStatus((status) => readyStates.push({ state: status.state, level: status.level }));
    invalidReady.port.autoAck = false;
    await invalidReady.device.connect();
    invalidReady.port.send("");
    invalidReady.port.send({ v: 1, event: "ready", state: "idle" });
    expect(readyStates.at(-1)).toEqual({ state: "idle", level: 0 });
    const readyPending = invalidReady.device.ping();
    const readyRejection = expect(readyPending).rejects.toBeInstanceOf(DeviceProtocolError);
    invalidReady.port.send({ v: 1, event: "ready", state: "idle", level: 2 });
    await readyRejection;

    const invalidEvent = setup();
    invalidEvent.port.autoAck = false;
    await invalidEvent.device.connect();
    const eventPending = invalidEvent.device.ping();
    const eventRejection = expect(eventPending).rejects.toBeInstanceOf(DeviceProtocolError);
    invalidEvent.port.send({ v: 1, event: "unknown", state: "idle" });
    await eventRejection;

    const invalidAck = setup();
    invalidAck.port.autoAck = false;
    await invalidAck.device.connect();
    const ackPending = invalidAck.device.ping();
    const ackRejection = expect(ackPending).rejects.toBeInstanceOf(DeviceProtocolError);
    invalidAck.port.send({ v: 1, requestId: 123, ok: true, state: "idle" });
    await ackRejection;

    expect(invalidReady.port.commands().at(-1)?.cmd).toBe("stop");
    expect(invalidEvent.port.commands().at(-1)?.cmd).toBe("stop");
    expect(invalidAck.port.commands().at(-1)?.cmd).toBe("stop");
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

  it("accepts an omitted level on PING and preserves a safe fault code on a negative ACK", async () => {
    const successful = setup();
    successful.port.autoAck = false;
    await successful.device.connect();
    const ping = successful.device.ping();
    const pingCommand = successful.port.commands()[0];
    successful.port.send({
      v: 1,
      requestId: pingCommand?.requestId,
      ok: true,
      state: "idle",
      fault: null,
    });
    await expect(ping).resolves.toMatchObject({ state: "idle", level: 0 });

    const failed = setup();
    const faults: Array<string | null> = [];
    failed.device.onStatus((status) => faults.push(status.fault));
    failed.port.autoAck = false;
    await failed.device.connect();
    const inflate = failed.device.inflate({ requestId: "fault-with-detail", level: 0.6, rampMs: 6_000 });
    const rejection = expect(inflate).rejects.toBeInstanceOf(DeviceFaultError);
    failed.port.send({
      v: 1,
      requestId: "fault-with-detail",
      ok: false,
      state: "fault",
      level: 0,
      errorCode: "OVERPRESSURE",
      fault: "OVERPRESSURE",
    });
    await rejection;
    expect(faults).toContain("OVERPRESSURE");
  });

  it("turns a synchronous serial write exception into a safe rejection and STOP attempt", async () => {
    const { device, port } = setup();
    await device.connect();
    port.synchronousWriteFailures = 1;

    await expect(device.ping()).rejects.toBeInstanceOf(DeviceNotConnectedError);

    expect(port.commands().map((command) => command.cmd)).toEqual(["ping", "stop"]);
  });

  it("rejects a STOP write failure without recursively sending STOP", async () => {
    const { device, port } = setup();
    await device.connect();
    port.synchronousWriteFailures = 1;
    port.synchronousWriteFailureValue = "injected non-Error write failure";

    await expect(device.stop({ requestId: "failed-stop-write" }))
      .rejects.toBeInstanceOf(DeviceNotConnectedError);

    expect(port.commands().map((command) => command.cmd)).toEqual(["stop"]);
  });

  it("turns an asynchronous serial write failure into a safe rejection and STOP attempt", async () => {
    const { device, port } = setup();
    const faults: Array<string | null> = [];
    device.onStatus((status) => faults.push(status.fault));
    await device.connect();
    port.asynchronousWriteFailures = 1;

    await expect(device.ping()).rejects.toBeInstanceOf(DeviceNotConnectedError);

    expect(port.commands().map((command) => command.cmd)).toEqual(["ping", "stop"]);
    expect(faults).toContain("SERIAL_WRITE_FAILED");
  });

  it("fails closed when a response exceeds the line limit and reports emergency STOP write failure", async () => {
    const { device, port } = setup({ maxLineBytes: 32 });
    const faults: Array<string | null> = [];
    device.onStatus((status) => faults.push(status.fault));
    port.autoAck = false;
    await device.connect();
    const ping = device.ping();
    const rejection = expect(ping).rejects.toBeInstanceOf(DeviceProtocolError);
    port.asynchronousWriteFailures = 1;

    port.send("x".repeat(33));

    await rejection;
    await Promise.resolve();
    expect(port.commands().map((command) => command.cmd)).toEqual(["ping", "stop"]);
    expect(faults.at(-1)).toBe("EMERGENCY_STOP_WRITE_FAILED");
  });

  it("ignores one late ACK after timeout but fails closed on a duplicate late ACK", async () => {
    vi.useFakeTimers();
    const { device, port } = setup({ ackTimeoutMs: 100 });
    const faults: Array<string | null> = [];
    device.onStatus((status) => faults.push(status.fault));
    port.autoAck = false;
    await device.connect();
    const ping = device.ping();
    const rejection = expect(ping).rejects.toBeInstanceOf(DeviceTimeoutError);
    const pingCommand = port.commands()[0];

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    port.ack(pingCommand);
    expect(port.commands().map((command) => command.cmd)).toEqual(["ping", "stop"]);

    port.ack(pingCommand);
    expect(port.commands().map((command) => command.cmd)).toEqual(["ping", "stop", "stop"]);
    expect(faults.at(-1)).toBe("INVALID_DEVICE_RESPONSE");
  });

  it("rejects duplicate pending request IDs without losing STOP priority", async () => {
    const { device, port } = setup();
    port.autoAck = false;
    await device.connect();
    const inflate = device.inflate({ requestId: "duplicate-request", level: 0.6, rampMs: 6_000 });

    await expect(device.deflate({ requestId: "duplicate-request", rampMs: 6_000 }))
      .rejects.toBeInstanceOf(DeviceProtocolError);

    const inflateRejection = expect(inflate).rejects.toBeInstanceOf(DeviceCommandSupersededError);
    const stop = device.stop({ requestId: "duplicate-stop" });
    await inflateRejection;
    port.ack(port.commands().at(-1));
    await expect(stop).resolves.toMatchObject({ requestId: "duplicate-stop", state: "stopped" });
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

  it("handles an explicit open error and permits a safe reconnect", async () => {
    const openFailure = setup();
    openFailure.port.deferOpen = true;
    const connecting = openFailure.device.connect();
    openFailure.port.completeOpen(new Error("injected open failure"));
    await expect(connecting).rejects.toBeInstanceOf(DeviceNotConnectedError);

    const reconnect = setup();
    await reconnect.device.connect();
    await expect(reconnect.device.connect()).resolves.toBeUndefined();
    reconnect.port.unexpectedClose();
    await reconnect.device.connect();
    await expect(reconnect.device.ping()).resolves.toMatchObject({ connected: true, state: "idle" });
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

  it("rejects pending work and attempts STOP on a serial error event", async () => {
    const { device, port } = setup();
    const faults: Array<string | null> = [];
    device.onStatus((status) => faults.push(status.fault));
    port.autoAck = false;
    await device.connect();
    const ping = device.ping();
    const rejection = expect(ping).rejects.toBeInstanceOf(DeviceNotConnectedError);

    port.fail(new Error("injected serial error"));

    await rejection;
    expect(port.commands().map((command) => command.cmd)).toEqual(["ping", "stop"]);
    expect(faults.at(-1)).toBe("SERIAL_ERROR");
  });

  it("aggregates STOP write and serial close failures while still detaching safely", async () => {
    const { device, port } = setup();
    await device.connect();
    port.asynchronousWriteFailures = 1;
    port.closeError = new Error("injected close failure");

    const disconnect = device.disconnect();
    const rejection = expect(disconnect).rejects.toBeInstanceOf(AggregateError);
    await rejection;

    expect(port.commands().map((command) => command.cmd)).toEqual([
      "stop",
      "stop",
      "deflate",
      "status",
    ]);
    expect(port.closeCalls).toBe(1);
    await expect(device.getStatus()).rejects.toBeInstanceOf(DeviceNotConnectedError);
  });

  it("disconnects safely when the port closes before the close event is delivered", async () => {
    const { device, port } = setup();
    await device.connect();
    port.closeWithoutEvent();

    await expect(device.disconnect()).resolves.toBeUndefined();

    expect(port.commands()).toEqual([]);
    expect(port.closeCalls).toBe(0);
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
