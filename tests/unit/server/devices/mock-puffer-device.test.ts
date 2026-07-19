import { afterEach, describe, expect, it, vi } from "vitest";

import { MockPufferDevice } from "../../../../src/server/devices/mock-puffer-device.js";
import {
  assertNormalizedLevel,
  assertRampMs,
  assertRequestId,
  DeviceCommandSupersededError,
  DeviceFaultError,
  DeviceNotConnectedError,
  DeviceTimeoutError,
  stopAndDeflateSafely,
  type PufferDevice,
} from "../../../../src/server/devices/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MockPufferDevice", () => {
  it("reproduces connect, inflate, hold, deflate and stop states in fast mode", async () => {
    const device = new MockPufferDevice({ timingMode: "fast" });
    const observed: string[] = [];
    const unsubscribe = device.onStatus((status) => observed.push(status.state));

    expect((await device.connect())).toBeUndefined();
    expect((await device.ping()).connected).toBe(true);
    expect((await device.getStatus()).state).toBe("idle");
    const inflateAck = await device.inflate({ requestId: "inflate-1", level: 0.6, rampMs: 6_000 });
    expect(inflateAck).toMatchObject({ requestId: "inflate-1", ok: true, state: "inflating" });
    expect(await device.getStatus()).toMatchObject({ state: "holding", level: 0.6 });

    const deflateAck = await device.deflate({ requestId: "deflate-1", rampMs: 6_000 });
    expect(deflateAck.state).toBe("deflating");
    expect(await device.getStatus()).toMatchObject({ state: "idle", level: 0 });
    expect((await device.stop({ requestId: "stop-1" })).state).toBe("stopped");
    expect(observed).toEqual(expect.arrayContaining([
      "disconnected", "connecting", "idle", "inflating", "holding", "deflating", "stopped",
    ]));
    unsubscribe();
    expect(device.commandHistory.map((entry) => entry.command)).toEqual([
      "ping", "status", "inflate", "status", "deflate", "status", "stop",
    ]);
  });

  it("runs motion over real time when requested", async () => {
    vi.useFakeTimers();
    const device = new MockPufferDevice({ timingMode: "real-time", initialConnected: true });
    await device.inflate({ requestId: "inflate-real", level: 0.6, rampMs: 100 });
    expect((await device.getStatus()).state).toBe("inflating");
    await vi.advanceTimersByTimeAsync(100);
    expect((await device.getStatus()).state).toBe("holding");
  });

  it("does not claim that STOP alone has deflated a held device", async () => {
    const device = new MockPufferDevice({ timingMode: "fast", initialConnected: true });
    await device.inflate({ requestId: "inflate-held", level: 0.6, rampMs: 1 });
    expect(await device.stop({ requestId: "stop-held" })).toMatchObject({ state: "stopped", level: 0.6 });
    await device.deflate({ requestId: "deflate-held", rampMs: 1 });
    expect(await device.getStatus()).toMatchObject({ state: "idle", level: 0 });
  });

  it("injects timeout, disconnect and device fault failures", async () => {
    const timeoutDevice = new MockPufferDevice({ timingMode: "fast", initialConnected: true });
    timeoutDevice.inject({ kind: "timeout", command: "inflate" });
    await expect(timeoutDevice.inflate({ requestId: "timeout", level: 0.6, rampMs: 1 }))
      .rejects.toBeInstanceOf(DeviceTimeoutError);

    const disconnectedDevice = new MockPufferDevice({ timingMode: "fast", initialConnected: true });
    disconnectedDevice.inject({ kind: "disconnect", command: "status" });
    await expect(disconnectedDevice.getStatus()).rejects.toBeInstanceOf(DeviceNotConnectedError);
    await expect(disconnectedDevice.ping()).rejects.toBeInstanceOf(DeviceNotConnectedError);

    const faultDevice = new MockPufferDevice({ timingMode: "fast", initialConnected: true });
    faultDevice.inject({ kind: "fault", errorCode: "OVERPRESSURE" });
    await expect(faultDevice.inflate({ requestId: "fault", level: 0.6, rampMs: 1 }))
      .rejects.toMatchObject({ code: "OVERPRESSURE" });
    expect(await faultDevice.stop({ requestId: "stop-after-fault" })).toMatchObject({ state: "stopped" });
  });

  it("lets STOP supersede an acknowledgement-delayed command", async () => {
    const device = new MockPufferDevice({ timingMode: "fast", initialConnected: true });
    device.inject({ kind: "delay", command: "inflate", delayMs: 10_000 });
    const pendingInflate = device.inflate({ requestId: "slow-inflate", level: 0.6, rampMs: 1 });
    await Promise.resolve();
    const stopAck = await device.stop({ requestId: "priority-stop" });
    await expect(pendingInflate).rejects.toBeInstanceOf(DeviceCommandSupersededError);
    expect(stopAck.state).toBe("stopped");
    expect(device.commandHistory.slice(-2).map((entry) => entry.command)).toEqual(["inflate", "stop"]);
  });

  it("supports repeatable injections and clearing them", async () => {
    const device = new MockPufferDevice({ timingMode: "fast", initialConnected: true });
    device.inject({ kind: "fault", command: "ping", times: 2, errorCode: "TEST_FAULT" });
    await expect(device.ping()).rejects.toBeInstanceOf(DeviceFaultError);
    await expect(device.ping()).rejects.toBeInstanceOf(DeviceFaultError);
    expect(await device.ping()).toMatchObject({ connected: true, state: "fault" });
    device.inject({ kind: "timeout", command: "ping" });
    device.clearInjections();
    expect(await device.ping()).toMatchObject({ connected: true });
    expect(() => device.inject({ kind: "fault", times: 0 })).toThrow(RangeError);
    expect(() => device.inject({ kind: "delay", delayMs: -1 })).toThrow(RangeError);
  });

  it("issues STOP before disconnecting", async () => {
    const device = new MockPufferDevice({ timingMode: "fast", initialConnected: true });
    await device.disconnect();
    expect(device.commandHistory.at(-1)?.command).toBe("stop");
    await expect(device.getStatus()).rejects.toBeInstanceOf(DeviceNotConnectedError);
    await expect(device.disconnect()).resolves.toBeUndefined();
  });

  it("validates normalized commands before sending them", async () => {
    const device = new MockPufferDevice({ timingMode: "fast", initialConnected: true });
    await expect(device.inflate({ requestId: "bad-level", level: 1.1, rampMs: 1 })).rejects.toThrow(RangeError);
    await expect(device.deflate({ requestId: "bad-ramp", rampMs: -1 })).rejects.toThrow(RangeError);
    await expect(device.stop({ requestId: "bad\nrequest" })).rejects.toThrow(TypeError);
    expect(() => assertNormalizedLevel(Number.NaN)).toThrow(RangeError);
    expect(() => assertRampMs(1.2)).toThrow(RangeError);
    expect(() => assertRequestId("")).toThrow(TypeError);
  });
});

describe("safe device shutdown", () => {
  it("attempts DEFLATE even when STOP fails and reports both outcomes", async () => {
    const calls: string[] = [];
    const device = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      ping: vi.fn(),
      getStatus: vi.fn(),
      inflate: vi.fn(),
      stop: vi.fn(async () => {
        calls.push("stop");
        throw new Error("stop failed");
      }),
      deflate: vi.fn(async () => {
        calls.push("deflate");
        return { requestId: "deflate", ok: true, state: "deflating", level: 0, errorCode: null } as const;
      }),
      onStatus: vi.fn(() => () => undefined),
    } satisfies PufferDevice;
    const result = await stopAndDeflateSafely(device, {
      stopRequestId: "stop",
      deflateRequestId: "deflate",
      deflateRampMs: 6_000,
    });
    expect(calls).toEqual(["stop", "deflate"]);
    expect(result).toMatchObject({ stopAcknowledged: false, deflateAcknowledged: true });
    expect(result.stopError).toBeInstanceOf(Error);
    expect(result.deflateError).toBeNull();
  });
});
