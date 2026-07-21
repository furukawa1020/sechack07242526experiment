import { randomUUID } from "node:crypto";

import type { PufferDeviceState } from "../../shared/experiment-machine.js";
import {
  assertNormalizedLevel,
  assertRampMs,
  assertRequestId,
  DeviceNotConnectedError,
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

export interface ScreenPufferDeviceOptions {
  readonly timingMode?: ScreenTimingMode;
  readonly initialConnected?: boolean;
  readonly rampTickMs?: number;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
}

export type ScreenTimingMode = "real-time" | "fast";

interface ActiveMotion {
  readonly startedAtMs: number;
  readonly startLevel: number;
  readonly targetLevel: number;
  readonly rampMs: number;
  readonly finalState: "holding" | "idle";
}

/**
 * In-process puffer adapter for a screen-rendered stimulus.
 *
 * This is deliberately separate from MockPufferDevice and has no fault injection.
 * Production advances the normalized level using monotonic real time. The fast
 * mode preserves the same state transitions without wall-clock waits for tests.
 */
export class ScreenPufferDevice implements PufferDevice {
  private readonly timingMode: ScreenTimingMode;
  private readonly rampTickMs: number;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly listeners = new Set<DeviceStatusListener>();
  private readonly entries: DeviceCommandHistoryEntry[] = [];
  private connected: boolean;
  private state: PufferDeviceState;
  private level = 0;
  private motion: ActiveMotion | null = null;
  private motionTimer: ReturnType<typeof setTimeout> | null = null;
  private motionGeneration = 0;

  public constructor(options: ScreenPufferDeviceOptions = {}) {
    const timingMode = options.timingMode ?? "real-time";
    if (timingMode !== "real-time" && timingMode !== "fast") {
      throw new TypeError("timingMode must be real-time or fast.");
    }
    const rampTickMs = options.rampTickMs ?? 100;
    if (!Number.isInteger(rampTickMs) || rampTickMs <= 0 || rampTickMs > 1_000) {
      throw new RangeError("rampTickMs must be an integer between 1 and 1000.");
    }
    this.timingMode = timingMode;
    this.rampTickMs = rampTickMs;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.connected = options.initialConnected ?? false;
    this.state = this.connected ? "idle" : "disconnected";
  }

  public get commandHistory(): readonly DeviceCommandHistoryEntry[] {
    return Object.freeze([...this.entries]);
  }

  public async connect(): Promise<void> {
    if (this.connected) return;
    this.state = "connecting";
    this.emitStatus();
    this.connected = true;
    this.level = 0;
    this.state = "idle";
    this.emitStatus();
  }

  public async disconnect(): Promise<void> {
    if (!this.connected) return;
    const shutdownErrors: Error[] = [];
    try {
      try {
        await this.stop({ requestId: randomUUID() });
      } catch (error) {
        shutdownErrors.push(error instanceof Error ? error : new Error("Unknown screen STOP failure."));
      }
      try {
        await this.deflate({ requestId: randomUUID(), rampMs: 0 });
      } catch (error) {
        shutdownErrors.push(
          error instanceof Error ? error : new Error("Unknown screen DEFLATE failure."),
        );
      }
    } finally {
      this.cancelMotion();
      this.level = 0;
      this.connected = false;
      this.state = "disconnected";
      this.emitStatus();
    }
    if (shutdownErrors.length > 0) {
      throw new AggregateError(
        shutdownErrors,
        "Screen device disconnect did not complete every STOP/DEFLATE safety step.",
      );
    }
  }

  /** Idempotent resource cleanup alias for server shutdown hooks. */
  public async close(): Promise<void> {
    await this.disconnect();
  }

  public async ping(): Promise<DeviceStatus> {
    this.assertConnected();
    this.record("ping", randomUUID(), null, null);
    return this.snapshot();
  }

  public async getStatus(): Promise<DeviceStatus> {
    this.assertConnected();
    this.record("status", randomUUID(), null, null);
    this.refreshMotion();
    return this.snapshot();
  }

  public async inflate(input: InflateInput): Promise<DeviceAck> {
    assertRequestId(input.requestId);
    assertNormalizedLevel(input.level);
    assertRampMs(input.rampMs);
    this.assertConnected();
    this.record("inflate", input.requestId, input.level, input.rampMs);
    this.beginMotion("inflating", "holding", input.level, input.rampMs);
    return this.ack(input.requestId, "inflating");
  }

  public async deflate(input: DeflateInput): Promise<DeviceAck> {
    assertRequestId(input.requestId);
    assertRampMs(input.rampMs);
    this.assertConnected();
    this.record("deflate", input.requestId, null, input.rampMs);
    this.beginMotion("deflating", "idle", 0, input.rampMs);
    return this.ack(input.requestId, "deflating");
  }

  public async stop(input: StopInput): Promise<DeviceAck> {
    assertRequestId(input.requestId);
    this.assertConnected();
    this.record("stop", input.requestId, null, null);
    this.refreshMotion();
    this.cancelMotion();
    this.state = "stopped";
    this.emitStatus();
    return this.ack(input.requestId, "stopped");
  }

  public onStatus(listener: DeviceStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private beginMotion(
    movingState: "inflating" | "deflating",
    finalState: "holding" | "idle",
    targetLevel: number,
    rampMs: number,
  ): void {
    this.refreshMotion();
    this.cancelMotion();
    this.state = movingState;
    this.emitStatus();
    if (rampMs === 0 || this.level === targetLevel) {
      this.level = targetLevel;
      this.state = finalState;
      this.emitStatus();
      return;
    }
    this.motion = {
      startedAtMs: this.monotonicNow(),
      startLevel: this.level,
      targetLevel,
      rampMs,
      finalState,
    };
    this.scheduleMotionTick();
  }

  private scheduleMotionTick(): void {
    const motion = this.motion;
    if (motion === null) return;
    const generation = this.motionGeneration;
    if (this.timingMode === "fast") {
      queueMicrotask(() => {
        if (generation !== this.motionGeneration || this.motion !== motion) return;
        this.motion = null;
        this.level = motion.targetLevel;
        this.state = motion.finalState;
        this.emitStatus();
      });
      return;
    }
    const elapsedMs = Math.max(0, this.monotonicNow() - motion.startedAtMs);
    const remainingMs = Math.max(0, motion.rampMs - elapsedMs);
    const delayMs = Math.max(1, Math.min(this.rampTickMs, remainingMs));
    this.motionTimer = setTimeout(() => {
      this.motionTimer = null;
      if (generation !== this.motionGeneration) return;
      this.refreshMotion();
      if (this.motion !== null) this.scheduleMotionTick();
    }, delayMs);
    this.motionTimer.unref?.();
  }

  private refreshMotion(): void {
    const motion = this.motion;
    if (motion === null) return;
    if (this.timingMode === "fast") return;
    const elapsedMs = Math.max(0, this.monotonicNow() - motion.startedAtMs);
    const progress = Math.min(1, elapsedMs / motion.rampMs);
    this.level = this.clampLevel(
      motion.startLevel + ((motion.targetLevel - motion.startLevel) * progress),
    );
    if (progress >= 1) {
      this.clearMotionTimer();
      this.motion = null;
      this.level = motion.targetLevel;
      this.state = motion.finalState;
    }
    this.emitStatus();
  }

  private cancelMotion(): void {
    this.motionGeneration += 1;
    this.clearMotionTimer();
    this.motion = null;
  }

  private clearMotionTimer(): void {
    if (this.motionTimer === null) return;
    clearTimeout(this.motionTimer);
    this.motionTimer = null;
  }

  private assertConnected(): void {
    if (!this.connected || this.state === "disconnected") {
      throw new DeviceNotConnectedError();
    }
  }

  private record(
    command: DeviceCommandName,
    requestId: string,
    level: number | null,
    rampMs: number | null,
  ): void {
    this.entries.push(Object.freeze({
      command,
      requestId,
      level,
      rampMs,
      issuedAt: this.now().toISOString(),
    }));
  }

  private ack(requestId: string, state: PufferDeviceState): DeviceAck {
    return Object.freeze({
      requestId,
      ok: true,
      state,
      level: this.level,
      errorCode: null,
    });
  }

  private snapshot(): DeviceStatus {
    return Object.freeze({
      connected: this.connected,
      state: this.state,
      level: this.level,
      fault: null,
      updatedAt: this.now().toISOString(),
    });
  }

  private emitStatus(): void {
    const status = this.snapshot();
    for (const listener of this.listeners) listener(status);
  }

  private clampLevel(level: number): number {
    return Math.min(1, Math.max(0, level));
  }
}
