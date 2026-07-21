import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenPufferDevice } from "../../../../src/server/devices/screen-puffer-device.js";
import { DeviceNotConnectedError } from "../../../../src/server/devices/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ScreenPufferDevice", () => {
  it("connects and publishes its lifecycle through the PufferDevice contract", async () => {
    const device = new ScreenPufferDevice();
    const observed: string[] = [];
    const unsubscribe = device.onStatus((status) => observed.push(status.state));

    await device.connect();

    expect(await device.ping()).toMatchObject({ connected: true, state: "idle", level: 0 });
    expect(observed).toEqual(["disconnected", "connecting", "idle"]);
    unsubscribe();
    await device.stop({ requestId: "not-observed" });
    expect(observed).toEqual(["disconnected", "connecting", "idle"]);
  });

  it("advances inflate and deflate levels over monotonic real time", async () => {
    vi.useFakeTimers();
    const device = new ScreenPufferDevice({
      initialConnected: true,
      rampTickMs: 10,
    });
    const levels: number[] = [];
    device.onStatus((status) => levels.push(status.level));

    expect(await device.inflate({
      requestId: "inflate-screen",
      level: 0.6,
      rampMs: 100,
    })).toMatchObject({ state: "inflating", level: 0 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await device.getStatus()).toMatchObject({ state: "inflating" });
    expect((await device.getStatus()).level).toBeCloseTo(0.3, 5);
    await vi.advanceTimersByTimeAsync(50);
    expect(await device.getStatus()).toMatchObject({ state: "holding", level: 0.6 });

    expect(await device.deflate({
      requestId: "deflate-screen",
      rampMs: 100,
    })).toMatchObject({ state: "deflating", level: 0.6 });
    await vi.advanceTimersByTimeAsync(50);
    expect((await device.getStatus()).level).toBeCloseTo(0.3, 5);
    await vi.advanceTimersByTimeAsync(50);
    expect(await device.getStatus()).toMatchObject({ state: "idle", level: 0 });
    expect(levels.some((level) => level > 0 && level < 0.6)).toBe(true);
  });

  it("preserves transitions without wall-clock waits in fast mode", async () => {
    const device = new ScreenPufferDevice({ initialConnected: true, timingMode: "fast" });
    const inflateAck = await device.inflate({
      requestId: "fast-inflate",
      level: 0.6,
      rampMs: 6_000,
    });
    expect(inflateAck.state).toBe("inflating");
    await Promise.resolve();
    expect(await device.getStatus()).toMatchObject({ state: "holding", level: 0.6 });

    const deflateAck = await device.deflate({ requestId: "fast-deflate", rampMs: 6_000 });
    expect(deflateAck.state).toBe("deflating");
    await Promise.resolve();
    expect(await device.getStatus()).toMatchObject({ state: "idle", level: 0 });
  });

  it("gives STOP priority over a pending fast transition", async () => {
    const device = new ScreenPufferDevice({ initialConnected: true, timingMode: "fast" });
    const inflate = device.inflate({ requestId: "pending-inflate", level: 0.6, rampMs: 6_000 });
    const stop = device.stop({ requestId: "priority-stop" });
    await expect(inflate).resolves.toMatchObject({ state: "inflating" });
    await expect(stop).resolves.toMatchObject({ state: "stopped", level: 0 });
    await Promise.resolve();
    expect(await device.getStatus()).toMatchObject({ state: "stopped", level: 0 });
  });

  it("lets STOP cancel a motion without claiming that it deflated the stimulus", async () => {
    vi.useFakeTimers();
    const device = new ScreenPufferDevice({ initialConnected: true, rampTickMs: 10 });
    await device.inflate({ requestId: "inflate-before-stop", level: 0.6, rampMs: 100 });
    await vi.advanceTimersByTimeAsync(50);

    const stopAck = await device.stop({ requestId: "stop-screen" });
    expect(stopAck.state).toBe("stopped");
    expect(stopAck.level).toBeCloseTo(0.3, 5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await device.getStatus()).toMatchObject({ state: "stopped" });
    expect((await device.getStatus()).level).toBeCloseTo(0.3, 5);

    await device.deflate({ requestId: "deflate-after-stop", rampMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await device.getStatus()).toMatchObject({ state: "idle", level: 0 });
  });

  it("performs STOP and immediate DEFLATE before close and clears active timers", async () => {
    vi.useFakeTimers();
    const device = new ScreenPufferDevice({ initialConnected: true, rampTickMs: 10 });
    const observed: string[] = [];
    device.onStatus((status) => observed.push(status.state));
    await device.inflate({ requestId: "inflate-before-close", level: 0.6, rampMs: 1_000 });
    await vi.advanceTimersByTimeAsync(100);

    await device.close();

    expect(device.commandHistory.slice(-2).map((entry) => entry.command)).toEqual([
      "stop",
      "deflate",
    ]);
    expect(observed.at(-1)).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(device.getStatus()).rejects.toBeInstanceOf(DeviceNotConnectedError);
    await expect(device.close()).resolves.toBeUndefined();
  });

  it("validates commands and rejects operations while disconnected", async () => {
    expect(() => new ScreenPufferDevice({ rampTickMs: 0 })).toThrow(RangeError);
    expect(() => new ScreenPufferDevice({ rampTickMs: 1_001 })).toThrow(RangeError);
    expect(() => new ScreenPufferDevice({
      timingMode: "invalid" as "real-time",
    })).toThrow(TypeError);
    const disconnected = new ScreenPufferDevice();
    await expect(disconnected.ping()).rejects.toBeInstanceOf(DeviceNotConnectedError);
    await expect(disconnected.inflate({ requestId: "offline", level: 0.6, rampMs: 10 }))
      .rejects.toBeInstanceOf(DeviceNotConnectedError);

    const connected = new ScreenPufferDevice({ initialConnected: true });
    await expect(connected.inflate({ requestId: "bad-level", level: 1.1, rampMs: 10 }))
      .rejects.toThrow(RangeError);
    await expect(connected.deflate({ requestId: "bad-ramp", rampMs: -1 }))
      .rejects.toThrow(RangeError);
    await expect(connected.stop({ requestId: "bad\nrequest" })).rejects.toThrow(TypeError);
  });

  it("does not expose Mock fault injection and still attempts DEFLATE after STOP failure", async () => {
    const device = new ScreenPufferDevice({ initialConnected: true });
    expect("inject" in device).toBe(false);
    const order: string[] = [];
    vi.spyOn(device, "stop").mockImplementationOnce(async () => {
      order.push("stop");
      throw new Error("synthetic stop failure");
    });
    const originalDeflate = device.deflate.bind(device);
    vi.spyOn(device, "deflate").mockImplementationOnce(async (input) => {
      order.push("deflate");
      return originalDeflate(input);
    });

    await expect(device.disconnect()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(["stop", "deflate"]);
    await expect(device.getStatus()).rejects.toBeInstanceOf(DeviceNotConnectedError);
  });

  it("completes zero-duration commands deterministically", async () => {
    const device = new ScreenPufferDevice({ initialConnected: true });
    await device.inflate({ requestId: "instant-inflate", level: 0.6, rampMs: 0 });
    expect(await device.getStatus()).toMatchObject({ state: "holding", level: 0.6 });
    await device.deflate({ requestId: "instant-deflate", rampMs: 0 });
    expect(await device.getStatus()).toMatchObject({ state: "idle", level: 0 });
  });
});
