import { randomUUID } from "node:crypto";

import type { PufferDeviceState } from "../../shared/experiment-machine.js";
import {
  assertNormalizedLevel,
  assertRampMs,
  assertRequestId,
  DeviceCommandSupersededError,
  DeviceFaultError,
  DeviceNotConnectedError,
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

export type MockTimingMode = "real-time" | "fast";
export type MockInjectionKind = "delay" | "timeout" | "disconnect" | "fault";

export interface MockFaultInjection {
  readonly kind: MockInjectionKind;
  /** Omit to target every command except STOP. */
  readonly command?: DeviceCommandName;
  readonly times?: number;
  readonly delayMs?: number;
  readonly errorCode?: string;
}

interface MutableInjection {
  readonly kind: MockInjectionKind;
  readonly command: DeviceCommandName | null;
  remaining: number;
  readonly delayMs: number;
  readonly errorCode: string;
}

export interface MockPufferDeviceOptions {
  readonly timingMode?: MockTimingMode;
  readonly ackDelayMs?: number;
  readonly ackTimeoutMs?: number;
  readonly initialConnected?: boolean;
  readonly now?: () => Date;
}

interface PendingDelay {
  readonly command: DeviceCommandName;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class MockPufferDevice implements PufferDevice {
  private readonly timingMode: MockTimingMode;
  private readonly ackDelayMs: number;
  private readonly ackTimeoutMs: number;
  private readonly now: () => Date;
  private readonly listeners = new Set<DeviceStatusListener>();
  private readonly entries: DeviceCommandHistoryEntry[] = [];
  private readonly injections: MutableInjection[] = [];
  private readonly pendingDelays = new Set<PendingDelay>();
  private motionTimer: ReturnType<typeof setTimeout> | null = null;
  private connected: boolean;
  private state: PufferDeviceState;
  private level = 0;
  private fault: string | null = null;

  public constructor(options: MockPufferDeviceOptions = {}) {
    this.timingMode = options.timingMode ?? "real-time";
    this.ackDelayMs = options.ackDelayMs ?? 0;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
    this.connected = options.initialConnected ?? false;
    this.state = this.connected ? "idle" : "disconnected";
    if (this.ackDelayMs < 0 || this.ackTimeoutMs <= 0) {
      throw new RangeError("Mock timing values must be positive.");
    }
  }

  public get commandHistory(): readonly DeviceCommandHistoryEntry[] {
    return Object.freeze([...this.entries]);
  }

  public inject(injection: MockFaultInjection): void {
    const times = injection.times ?? 1;
    if (!Number.isInteger(times) || times <= 0) {
      throw new RangeError("Injection times must be a positive integer.");
    }
    const delayMs = injection.delayMs ?? 0;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("Injection delayMs must be non-negative.");
    }
    this.injections.push({
      kind: injection.kind,
      command: injection.command ?? null,
      remaining: times,
      delayMs,
      errorCode: injection.errorCode ?? "MOCK_DEVICE_FAULT",
    });
  }

  public clearInjections(): void {
    this.injections.splice(0, this.injections.length);
  }

  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.state = "connecting";
    this.emitStatus();
    await this.wait(this.ackDelayMs, "status");
    this.connected = true;
    this.state = "idle";
    this.level = 0;
    this.fault = null;
    this.emitStatus();
  }

  public async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }
    try {
      await this.stop({ requestId: randomUUID() });
      await this.deflate({ requestId: randomUUID(), rampMs: 0 });
    } finally {
      this.cancelMotion();
      this.cancelPending("stop");
      this.connected = false;
      this.state = "disconnected";
      this.emitStatus();
    }
  }

  public async ping(): Promise<DeviceStatus> {
    const requestId = randomUUID();
    this.record("ping", requestId, null, null);
    await this.beforeAck("ping");
    return this.snapshot();
  }

  public async getStatus(): Promise<DeviceStatus> {
    const requestId = randomUUID();
    this.record("status", requestId, null, null);
    await this.beforeAck("status");
    return this.snapshot();
  }

  public async inflate(input: InflateInput): Promise<DeviceAck> {
    assertRequestId(input.requestId);
    assertNormalizedLevel(input.level);
    assertRampMs(input.rampMs);
    this.record("inflate", input.requestId, input.level, input.rampMs);
    await this.beforeAck("inflate");
    this.state = "inflating";
    this.fault = null;
    this.emitStatus();
    this.scheduleMotion("holding", input.level, input.rampMs);
    return this.ack(input.requestId, "inflating");
  }

  public async deflate(input: DeflateInput): Promise<DeviceAck> {
    assertRequestId(input.requestId);
    assertRampMs(input.rampMs);
    this.record("deflate", input.requestId, null, input.rampMs);
    this.cancelPending("deflate");
    await this.beforeAck("deflate");
    this.cancelMotion();
    this.state = "deflating";
    this.emitStatus();
    this.scheduleMotion("idle", 0, input.rampMs);
    return this.ack(input.requestId, "deflating");
  }

  public async stop(input: StopInput): Promise<DeviceAck> {
    assertRequestId(input.requestId);
    this.record("stop", input.requestId, null, null);
    this.cancelPending("stop");
    this.cancelMotion();
    await this.beforeAck("stop");
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

  private async beforeAck(command: DeviceCommandName): Promise<void> {
    this.assertConnected();
    const injectionIndex = this.injections.findIndex((candidate) =>
      (candidate.command === command || (candidate.command === null && command !== "stop"))
      && candidate.remaining > 0,
    );
    const injection = injectionIndex < 0 ? undefined : this.injections[injectionIndex];
    if (injection !== undefined) {
      injection.remaining -= 1;
      if (injection.remaining === 0) {
        this.injections.splice(injectionIndex, 1);
      }
      if (injection.kind === "delay") {
        await this.wait(injection.delayMs, command);
      } else if (injection.kind === "timeout") {
        await this.waitForTimeout(command);
      } else if (injection.kind === "disconnect") {
        this.connected = false;
        this.state = "disconnected";
        this.emitStatus();
        throw new DeviceNotConnectedError("Mock disconnect was injected.");
      } else {
        this.state = "fault";
        this.fault = injection.errorCode;
        this.emitStatus();
        throw new DeviceFaultError(injection.errorCode);
      }
    }
    if (this.ackDelayMs > 0) {
      await this.wait(this.ackDelayMs, command);
    }
    this.assertConnected();
  }

  private wait(delayMs: number, command: DeviceCommandName): Promise<void> {
    if (delayMs === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDelays.delete(pending);
        resolve();
      }, delayMs);
      const pending: PendingDelay = { command, reject, timer };
      this.pendingDelays.add(pending);
    });
  }

  private async waitForTimeout(command: DeviceCommandName): Promise<never> {
    const timeoutMs = this.timingMode === "fast" ? 0 : this.ackTimeoutMs;
    await this.wait(timeoutMs, command);
    throw new DeviceTimeoutError(command);
  }

  private cancelPending(except: DeviceCommandName): void {
    for (const pending of [...this.pendingDelays]) {
      if (pending.command !== except) {
        clearTimeout(pending.timer);
        this.pendingDelays.delete(pending);
        pending.reject(new DeviceCommandSupersededError(pending.command));
      }
    }
  }

  private scheduleMotion(finalState: PufferDeviceState, finalLevel: number, rampMs: number): void {
    this.cancelMotion();
    const complete = (): void => {
      this.motionTimer = null;
      this.state = finalState;
      this.level = finalLevel;
      this.emitStatus();
    };
    if (this.timingMode === "fast" || rampMs === 0) {
      queueMicrotask(complete);
      return;
    }
    this.motionTimer = setTimeout(complete, rampMs);
  }

  private cancelMotion(): void {
    if (this.motionTimer !== null) {
      clearTimeout(this.motionTimer);
      this.motionTimer = null;
    }
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
