import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  allocateOrder,
  CONDITIONS,
  type ConditionCode,
  type ExperimentPhase,
  type OrderCode,
} from "../../shared/index.js";
import { badRequest, conflict, notFound } from "../api/http-error.js";
import type {
  DeviceStatus,
  OperatorSessionSnapshot,
  PublicCondition,
  PublicSessionSnapshot,
  RuntimeSession,
  ServerEvent,
  ServerExperimentConfig,
  SessionLogWriter,
  PufferDevice,
} from "../contracts.js";
import { createLogEvent } from "../logging/index.js";

const TERMINAL_PHASES = new Set<ExperimentPhase>(["completed", "aborted"]);
const TIMED_PHASES = new Set<ExperimentPhase>(["handling", "processing", "result", "reset"]);

const ALLOWED_TRANSITIONS: Readonly<Record<ExperimentPhase, readonly ExperimentPhase[]>> = {
  idle: ["setup", "aborted"],
  setup: ["intro", "aborted"],
  intro: ["handling", "aborted", "error"],
  handling: ["processing", "aborted", "error"],
  processing: ["result", "aborted", "error"],
  result: ["reset", "aborted", "error"],
  reset: ["handling", "summary", "aborted", "error"],
  summary: ["completed", "aborted", "error"],
  completed: [],
  aborted: [],
  error: ["aborted"],
};

export interface CreateSessionInput {
  readonly researchId: string;
  readonly consentConfirmed: true;
  readonly orderCode?: OrderCode | "auto";
}

export interface CreatedSession {
  readonly snapshot: OperatorSessionSnapshot;
  readonly displayToken: string;
  readonly displayUrl: string;
}

export interface SessionControllerOptions {
  readonly config: ServerExperimentConfig;
  readonly configHash: string;
  readonly appVersion: string;
  readonly device: PufferDevice;
  readonly logger: SessionLogWriter;
  readonly random?: () => number;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
}

type Listener = (event: ServerEvent) => void;

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return fallback;
}

function isPufferPhase(session: RuntimeSession): boolean {
  if (session.currentCondition === null) return false;
  const condition = CONDITIONS[session.currentCondition];
  return condition.presentation === "puffer" && (session.phase === "result" || session.phase === "reset");
}

function isSafeDeflatedStatus(status: DeviceStatus): boolean {
  if (!status.connected) return false;
  if (status.state !== "idle" && status.state !== "stopped") return false;
  return status.level === undefined || status.level <= 0;
}

export class SessionController {
  private readonly config: ServerExperimentConfig;
  private readonly configHash: string;
  private readonly appVersion: string;
  private readonly device: PufferDevice;
  private readonly logger: SessionLogWriter;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly displayTokens = new Map<string, string>();
  private readonly sessionTokens = new Map<string, string>();
  private readonly readyDisplayConnections = new Map<string, Set<string>>();
  private readonly pausedRemainingMs = new Map<string, number>();
  private readonly recentEvents = new Map<string, Array<{
    wallClockIso: string;
    eventType: string;
    deviceStatus: string;
    errorCode?: string;
  }>>();
  private readonly listeners = new Set<Listener>();
  private activeSessionId: string | null = null;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private timerGeneration = 0;
  private handlingFailure = false;
  private emergencyLocked = false;
  private lastDeviceStatus: DeviceStatus | null = null;
  private readonly unsubscribeDevice: () => void;

  public constructor(options: SessionControllerOptions) {
    this.config = options.config;
    this.configHash = options.configHash;
    this.appVersion = options.appVersion;
    this.device = options.device;
    this.logger = options.logger;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.unsubscribeDevice = this.device.onStatus((status) => {
      void this.handleDeviceStatus(status);
    });
  }

  public dispose(): void {
    this.cancelTimer();
    this.unsubscribeDevice();
    this.listeners.clear();
  }

  /** Safely terminates any active run and always attempts STOP then DEFLATE. */
  public async shutdown(): Promise<void> {
    const active = this.activeSessionId === null ? null : this.sessions.get(this.activeSessionId) ?? null;
    if (active === null) {
      await this.safeStopAndDeflate();
      return;
    }
    if (active.phase === "completed" || active.phase === "aborted") {
      await this.safeStopAndDeflate();
      this.activeSessionId = null;
      return;
    }
    await this.abort(active.id);
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async create(input: CreateSessionInput): Promise<CreatedSession> {
    if (this.activeSessionId !== null) {
      throw conflict("進行中または確認待ちのセッションがあります。", "ACTIVE_SESSION_EXISTS");
    }
    if (!input.consentConfirmed) {
      throw badRequest("同意確認が必要です。", "CONSENT_NOT_CONFIRMED");
    }
    const researchIdPattern = new RegExp(this.config.researchIdPattern);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(input.researchId) ||
      !researchIdPattern.test(input.researchId)
    ) {
      throw badRequest("研究用IDの形式が正しくありません。", "INVALID_RESEARCH_ID");
    }
    if (
      [...this.sessions.values()].some((session) => session.researchId === input.researchId) ||
      (await this.logger.hasResearchId(input.researchId))
    ) {
      throw conflict("この研究用IDは既に使用されています。", "DUPLICATE_RESEARCH_ID");
    }

    const orderCode =
      input.orderCode !== undefined && input.orderCode !== "auto"
        ? input.orderCode
        : await this.allocateOrder();
    if (!this.config.orders.includes(orderCode)) {
      throw badRequest("提示順が許可された集合に含まれていません。", "INVALID_ORDER_CODE");
    }

    const id = randomUUID();
    const displayToken = randomBytes(32).toString("base64url");
    const timestamp = this.now().toISOString();
    let initialDeviceStatus: RuntimeSession["deviceStatus"] = "disconnected";
    let initialDeviceLevel = 0;
    try {
      const status = await this.device.getStatus();
      initialDeviceStatus = status.state;
      initialDeviceLevel = status.level;
    } catch {
      // A disconnected device is valid while the operator is still in setup.
    }

    const session: RuntimeSession = {
      id,
      researchId: input.researchId,
      orderCode,
      phase: "setup",
      sequenceIndex: null,
      currentCondition: null,
      fixedState: { ...this.config.fixedState },
      deviceMode: this.config.device.mode,
      deviceStatus: initialDeviceStatus,
      deviceLevel: initialDeviceLevel,
      displayConnected: false,
      recoveryRequired: false,
      phaseStartedAt: timestamp,
      phaseEndsAt: null,
      phaseStartedMonotonicMs: this.monotonicNow(),
      phaseEndsMonotonicMs: null,
      remainingMs: null,
      result: null,
      errorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      consentConfirmed: true,
      configHash: this.configHash,
      protocolVersion: this.config.protocolVersion,
    };

    this.sessions.set(id, session);
    this.displayTokens.set(displayToken, id);
    this.sessionTokens.set(id, displayToken);
    this.readyDisplayConnections.set(id, new Set());
    this.activeSessionId = id;
    this.emergencyLocked = false;
    await this.audit(session, "session.created");
    this.emit({ type: "session.snapshot", sessionId: id });

    const displayUrl = this.displayUrl(displayToken);
    return { snapshot: this.operatorSnapshot(session), displayToken, displayUrl };
  }

  public get(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw notFound("セッションが見つかりません。", "SESSION_NOT_FOUND");
    return session;
  }

  public getOperatorSnapshot(sessionId: string): OperatorSessionSnapshot {
    return this.operatorSnapshot(this.get(sessionId));
  }

  public getActiveOperatorSnapshot(): OperatorSessionSnapshot | null {
    return this.activeSessionId === null ? null : this.getOperatorSnapshot(this.activeSessionId);
  }

  public getDeviceMode(): "mock" | "serial" {
    return this.config.device.mode;
  }

  public getPublicSnapshot(displayToken: string): PublicSessionSnapshot {
    return this.publicSnapshot(this.sessionForToken(displayToken));
  }

  public resolveDisplayToken(displayToken: string): string {
    return this.sessionForToken(displayToken).id;
  }

  public async prepare(sessionId: string): Promise<OperatorSessionSnapshot> {
    const session = this.requireActive(sessionId);
    this.requirePhase(session, "setup");
    if (!session.displayConnected) {
      throw conflict("参加者画面の接続を確認してください。", "DISPLAY_NOT_READY");
    }
    const status = await this.device.getStatus();
    if (!isSafeDeflatedStatus(status)) {
      throw conflict("装置を接続し、idleかつ収縮済みの状態にしてください。", "DEVICE_NOT_READY");
    }
    const updated = await this.enterUntimedPhase(session, "intro", {
      deviceStatus: status.state,
      deviceLevel: status.level,
      currentCondition: null,
      sequenceIndex: null,
    });
    return this.operatorSnapshot(updated);
  }

  public async start(sessionId: string): Promise<OperatorSessionSnapshot> {
    const session = this.requireActive(sessionId);
    this.requirePhase(session, "intro");
    if (session.recoveryRequired) {
      throw conflict("参加者画面の復旧確認を先に行ってください。", "RECOVERY_REQUIRED");
    }
    if (!session.displayConnected) {
      throw conflict("参加者画面が接続されていません。", "DISPLAY_NOT_READY");
    }
    const updated = await this.enterTimedPhase(session, "handling", 0);
    return this.operatorSnapshot(updated);
  }

  public async resume(sessionId: string): Promise<OperatorSessionSnapshot> {
    const session = this.requireActive(sessionId);
    if (!session.recoveryRequired) {
      throw conflict("このセッションは復旧確認待ちではありません。", "RECOVERY_NOT_REQUIRED");
    }
    if (!session.displayConnected) {
      throw conflict("参加者画面の再接続を確認してください。", "DISPLAY_NOT_READY");
    }
    if (session.phase === "error") {
      throw conflict("error状態のセッションは再開できません。", "SESSION_NOT_RESUMABLE");
    }

    const remaining = this.pausedRemainingMs.get(session.id);
    let updated: RuntimeSession;
    if (TIMED_PHASES.has(session.phase)) {
      if (remaining === undefined || remaining <= 0) {
        throw conflict("安全に再開できる残り時間がありません。", "SESSION_NOT_RESUMABLE");
      }
      updated = this.patchSession(session, this.phaseTimingPatch(remaining, { recoveryRequired: false }));
      this.sessions.set(updated.id, updated);
      this.pausedRemainingMs.delete(updated.id);
      this.schedulePhaseAdvance(updated, remaining);
    } else {
      updated = this.patchSession(session, { recoveryRequired: false });
      this.sessions.set(updated.id, updated);
    }
    await this.audit(updated, "session.resumed");
    this.emit({ type: "session.phaseChanged", sessionId: updated.id });
    return this.operatorSnapshot(updated);
  }

  public async abort(sessionId: string): Promise<OperatorSessionSnapshot> {
    const session = this.requireActive(sessionId);
    if (TERMINAL_PHASES.has(session.phase)) {
      throw conflict("終了済みセッションは中止できません。", "SESSION_ALREADY_TERMINAL");
    }
    this.cancelTimer();
    await this.safeStopAndDeflate();
    const updated = await this.enterTerminalPhase(session, "aborted", "aborted", null, "session.aborted");
    this.activeSessionId = null;
    return this.operatorSnapshot(updated);
  }

  public async emergencyStop(sessionId: string): Promise<OperatorSessionSnapshot> {
    const session = this.requireActive(sessionId);
    this.cancelTimer();
    this.emergencyLocked = true;
    await this.safeStopAndDeflate();
    const updated = await this.enterTerminalPhase(
      session,
      "aborted",
      "aborted",
      "EMERGENCY_STOP",
      "session.emergencyStop",
    );
    this.activeSessionId = null;
    return this.operatorSnapshot(updated);
  }

  public async confirmFormComplete(sessionId: string): Promise<OperatorSessionSnapshot> {
    const session = this.requireActive(sessionId);
    this.requirePhase(session, "summary");
    const updated = await this.enterTerminalPhase(session, "completed", "ok", null, "session.completed");
    this.activeSessionId = null;
    return this.operatorSnapshot(updated);
  }

  public async delete(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    if (this.activeSessionId === sessionId && session.phase !== "setup") {
      throw conflict("進行中または確認待ちのセッションは削除できません。", "SESSION_DELETE_UNSAFE");
    }
    if (session.phase === "error") {
      throw conflict("error状態は中止確認後にのみ削除できます。", "SESSION_DELETE_UNSAFE");
    }
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      this.cancelTimer();
    }
    const token = this.sessionTokens.get(sessionId);
    if (token !== undefined) this.displayTokens.delete(token);
    this.sessionTokens.delete(sessionId);
    this.readyDisplayConnections.delete(sessionId);
    this.pausedRemainingMs.delete(sessionId);
    this.sessions.delete(sessionId);
    await this.audit(session, "session.deleted");
    this.recentEvents.delete(sessionId);
  }

  public markDisplayReady(displayToken: string, connectionId: string): void {
    const session = this.sessionForToken(displayToken);
    const connections = this.readyDisplayConnections.get(session.id) ?? new Set<string>();
    connections.add(connectionId);
    this.readyDisplayConnections.set(session.id, connections);
    if (!session.displayConnected) {
      const updated = this.patchSession(session, { displayConnected: true });
      this.sessions.set(updated.id, updated);
      void this.audit(updated, "display.ready");
      this.emit({ type: "session.snapshot", sessionId: updated.id });
    }
  }

  public markDisplayDisconnected(displayToken: string, connectionId: string): void {
    let session: RuntimeSession;
    try {
      session = this.sessionForToken(displayToken);
    } catch {
      return;
    }
    const connections = this.readyDisplayConnections.get(session.id);
    connections?.delete(connectionId);
    if (connections !== undefined && connections.size > 0) return;
    if (!session.displayConnected) return;

    let updated = this.patchSession(session, { displayConnected: false });
    this.sessions.set(updated.id, updated);
    void this.audit(updated, "display.disconnected");

    if (this.activeSessionId === updated.id && isPufferPhase(updated)) {
      void this.failSession(updated, "DISPLAY_LOST_DURING_PUFFER");
      return;
    }

    if (
      this.activeSessionId === updated.id &&
      (TIMED_PHASES.has(updated.phase) || updated.phase === "intro" || updated.phase === "summary")
    ) {
      if (TIMED_PHASES.has(updated.phase)) {
        const remaining = Math.max(0, (updated.phaseEndsMonotonicMs ?? this.monotonicNow()) - this.monotonicNow());
        this.pausedRemainingMs.set(updated.id, remaining);
        this.cancelTimer();
      }
      updated = this.patchSession(updated, {
        recoveryRequired: true,
        phaseEndsAt: null,
        phaseEndsMonotonicMs: null,
        remainingMs: this.pausedRemainingMs.get(updated.id) ?? null,
      });
      this.sessions.set(updated.id, updated);
      void this.audit(updated, "session.recoveryRequired");
    }
    this.emit({ type: "session.snapshot", sessionId: updated.id });
  }

  public noteDisplayHeartbeat(displayToken: string, connectionId: string): void {
    const session = this.sessionForToken(displayToken);
    const connections = this.readyDisplayConnections.get(session.id);
    if (connections?.has(connectionId) !== true) {
      this.markDisplayReady(displayToken, connectionId);
    }
  }

  public async connectDevice(): Promise<DeviceStatus> {
    this.requireDeviceTestAllowed("connect");
    await this.device.connect();
    return this.device.getStatus();
  }

  public async disconnectDevice(): Promise<DeviceStatus> {
    this.requireDeviceTestAllowed("disconnect");
    await this.device.disconnect();
    if (this.lastDeviceStatus !== null) return this.lastDeviceStatus;
    return this.device.getStatus();
  }

  public async pingDevice(): Promise<DeviceStatus> {
    return this.device.ping();
  }

  public async getDeviceStatus(): Promise<DeviceStatus> {
    try {
      return await this.device.getStatus();
    } catch (error) {
      if (this.lastDeviceStatus?.state === "disconnected") return this.lastDeviceStatus;
      throw error;
    }
  }

  public async testInflate(level: number): Promise<DeviceStatus> {
    this.requireDeviceTestAllowed("inflate");
    if (level < 0 || level > this.config.fixedState.pufferLevel) {
      throw conflict("テスト膨張量は設定済み上限以下で指定してください。", "DEVICE_LEVEL_OUT_OF_RANGE");
    }
    await this.device.inflate({
      level,
      rampMs: this.config.timingMs.inflateRamp,
      requestId: randomUUID(),
    });
    return this.device.getStatus();
  }

  public async testDeflate(): Promise<DeviceStatus> {
    this.requireDeviceTestAllowed("deflate");
    await this.device.deflate({ rampMs: this.config.timingMs.deflateRamp, requestId: randomUUID() });
    return this.device.getStatus();
  }

  public async stopDevice(): Promise<DeviceStatus> {
    await this.device.stop({ requestId: randomUUID() });
    return this.device.getStatus();
  }

  public exportCsv(): Promise<string> {
    return this.logger.exportCsv();
  }

  private requireDeviceTestAllowed(action: string): void {
    if (this.emergencyLocked && action !== "connect") {
      throw conflict("緊急停止後は新しいセッションを作成するまで装置操作できません。", "DEVICE_EMERGENCY_LOCKED");
    }
    if (this.activeSessionId === null) return;
    const active = this.get(this.activeSessionId);
    if (active.phase !== "setup") {
      throw conflict("本番セッション中はデバイステスト操作を実行できません。", "DEVICE_TEST_LOCKED");
    }
  }

  private async allocateOrder(): Promise<OrderCode> {
    const summaries = await this.logger.listSessionSummaries();
    return allocateOrder(
      summaries.map((summary) => ({
        orderCode: summary.orderCode,
        result: summary.result,
        presentationsStarted: summary.presentationsStarted,
      })),
      {
        includeAbortedInOrderBalancing: this.config.logging.includeAbortedInOrderBalancing,
        random: this.random,
      },
    );
  }

  private async enterTimedPhase(
    session: RuntimeSession,
    phase: "handling" | "processing" | "result" | "reset",
    sequenceIndex: 0 | 1 | 2 | 3,
  ): Promise<RuntimeSession> {
    const currentCondition = session.orderCode[sequenceIndex] as ConditionCode;
    const duration = this.config.timingMs[phase];
    let updated = this.transition(session, phase, {
      ...this.phaseTimingPatch(duration),
      sequenceIndex,
      currentCondition,
      recoveryRequired: false,
    });
    this.sessions.set(updated.id, updated);
    this.schedulePhaseAdvance(updated, duration);
    await this.audit(updated, `phase.${phase}`);
    this.emit({ type: "session.phaseChanged", sessionId: updated.id });

    const condition = CONDITIONS[currentCondition];
    try {
      if (phase === "result" && condition.presentation === "puffer") {
        await this.device.inflate({
          level: updated.fixedState.pufferLevel,
          rampMs: this.config.timingMs.inflateRamp,
          requestId: randomUUID(),
        });
        updated = this.refreshDeviceStatus(updated, await this.device.getStatus());
      } else if (phase === "reset" && condition.presentation === "puffer") {
        await this.device.deflate({
          rampMs: this.config.timingMs.deflateRamp,
          requestId: randomUUID(),
        });
        updated = this.refreshDeviceStatus(updated, await this.device.getStatus());
      }
    } catch (error) {
      await this.failSession(updated, errorCode(error, "DEVICE_COMMAND_FAILED"));
    }
    return this.get(updated.id);
  }

  private async enterUntimedPhase(
    session: RuntimeSession,
    phase: "intro" | "summary",
    patch: Partial<RuntimeSession> = {},
  ): Promise<RuntimeSession> {
    const monotonic = this.monotonicNow();
    const timestamp = this.now().toISOString();
    const updated = this.transition(session, phase, {
      ...patch,
      phaseStartedAt: timestamp,
      phaseEndsAt: null,
      phaseStartedMonotonicMs: monotonic,
      phaseEndsMonotonicMs: null,
      remainingMs: null,
      recoveryRequired: false,
    });
    this.sessions.set(updated.id, updated);
    await this.audit(updated, `phase.${phase}`);
    this.emit({ type: "session.phaseChanged", sessionId: updated.id });
    return updated;
  }

  private async enterTerminalPhase(
    session: RuntimeSession,
    phase: "completed" | "aborted",
    result: "ok" | "aborted",
    terminalErrorCode: string | null,
    eventType: string,
  ): Promise<RuntimeSession> {
    const monotonic = this.monotonicNow();
    const timestamp = this.now().toISOString();
    const updated = this.transition(session, phase, {
      result,
      errorCode: terminalErrorCode,
      recoveryRequired: false,
      phaseStartedAt: timestamp,
      phaseEndsAt: null,
      phaseStartedMonotonicMs: monotonic,
      phaseEndsMonotonicMs: null,
      remainingMs: null,
    });
    this.sessions.set(updated.id, updated);
    await this.audit(updated, eventType);
    this.emit({
      type: phase === "completed" ? "session.completed" : "session.aborted",
      sessionId: updated.id,
    });
    return updated;
  }

  private phaseTimingPatch(durationMs: number, extra: Partial<RuntimeSession> = {}): Partial<RuntimeSession> {
    const monotonic = this.monotonicNow();
    const now = this.now();
    return {
      ...extra,
      phaseStartedAt: now.toISOString(),
      phaseEndsAt: new Date(now.getTime() + durationMs).toISOString(),
      phaseStartedMonotonicMs: monotonic,
      phaseEndsMonotonicMs: monotonic + durationMs,
      remainingMs: durationMs,
    };
  }

  private schedulePhaseAdvance(session: RuntimeSession, durationMs: number): void {
    this.cancelTimer();
    const generation = this.timerGeneration;
    this.phaseTimer = setTimeout(() => {
      if (generation !== this.timerGeneration) return;
      void this.advancePhase(session.id, session.phase).catch(async (error: unknown) => {
        const current = this.sessions.get(session.id);
        if (current !== undefined && !TERMINAL_PHASES.has(current.phase) && current.phase !== "error") {
          await this.failSession(current, errorCode(error, "PHASE_ADVANCE_FAILED"));
        }
      });
    }, durationMs);
    this.phaseTimer.unref?.();
  }

  private async advancePhase(sessionId: string, expectedPhase: ExperimentPhase): Promise<void> {
    const session = this.get(sessionId);
    if (session.phase !== expectedPhase || session.recoveryRequired || this.activeSessionId !== sessionId) return;
    switch (session.phase) {
      case "handling":
        await this.enterTimedPhase(session, "processing", this.requireSequenceIndex(session));
        return;
      case "processing":
        await this.enterTimedPhase(session, "result", this.requireSequenceIndex(session));
        return;
      case "result":
        await this.enterTimedPhase(session, "reset", this.requireSequenceIndex(session));
        return;
      case "reset": {
        const index = this.requireSequenceIndex(session);
        const condition = CONDITIONS[session.currentCondition as ConditionCode];
        if (condition.presentation === "puffer") {
          const status = await this.device.getStatus();
          if (!isSafeDeflatedStatus(status)) {
            await this.failSession(session, "DEFLATE_NOT_CONFIRMED");
            return;
          }
        }
        if (index === 3) {
          await this.enterUntimedPhase(session, "summary", { currentCondition: null });
        } else {
          const nextIndex = (index + 1) as 0 | 1 | 2 | 3;
          await this.enterTimedPhase(session, "handling", nextIndex);
        }
        return;
      }
      default:
        return;
    }
  }

  private requireSequenceIndex(session: RuntimeSession): 0 | 1 | 2 | 3 {
    if (session.sequenceIndex === null) throw new Error("提示位置が設定されていません。");
    return session.sequenceIndex;
  }

  private async failSession(session: RuntimeSession, failureCode: string): Promise<void> {
    if (this.handlingFailure || session.phase === "error" || TERMINAL_PHASES.has(session.phase)) return;
    this.handlingFailure = true;
    try {
      this.cancelTimer();
      await this.safeStopAndDeflate();
      const current = this.get(session.id);
      const monotonic = this.monotonicNow();
      const timestamp = this.now().toISOString();
      const updated = this.transition(current, "error", {
        result: "error",
        errorCode: failureCode,
        recoveryRequired: false,
        phaseStartedAt: timestamp,
        phaseEndsAt: null,
        phaseStartedMonotonicMs: monotonic,
        phaseEndsMonotonicMs: null,
        remainingMs: null,
      });
      this.sessions.set(updated.id, updated);
      await this.audit(updated, "session.error");
      this.emit({ type: "session.error", sessionId: updated.id });
    } finally {
      this.handlingFailure = false;
    }
  }

  private async safeStopAndDeflate(): Promise<void> {
    let firstError: unknown;
    try {
      await this.device.stop({ requestId: randomUUID() });
    } catch (error) {
      firstError = error;
    }
    try {
      await this.device.deflate({ rampMs: this.config.timingMs.deflateRamp, requestId: randomUUID() });
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) {
      // Both operations were attempted. The session transition still has to be recorded.
      const active = this.activeSessionId === null ? undefined : this.sessions.get(this.activeSessionId);
      if (active !== undefined) await this.audit(active, "device.safetyCommandFailed", errorCode(firstError, "DEVICE_SAFETY_FAILED"));
    }
  }

  private async handleDeviceStatus(status: DeviceStatus): Promise<void> {
    this.lastDeviceStatus = status;
    const active = this.activeSessionId === null ? undefined : this.sessions.get(this.activeSessionId);
    if (active !== undefined) {
      const updated = this.refreshDeviceStatus(active, status);
      this.emit({ type: "device.status", sessionId: updated.id, deviceStatus: status });
      if (
        updated.phase !== "setup" &&
        updated.phase !== "error" &&
        !TERMINAL_PHASES.has(updated.phase) &&
        (status.state === "fault" || status.state === "disconnected")
      ) {
        await this.failSession(updated, status.state === "fault" ? "DEVICE_FAULT" : "DEVICE_DISCONNECTED");
      }
    } else {
      this.emit({ type: "device.status", deviceStatus: status });
    }
  }

  private refreshDeviceStatus(session: RuntimeSession, status: DeviceStatus): RuntimeSession {
    const updated = this.patchSession(session, { deviceStatus: status.state, deviceLevel: status.level });
    this.sessions.set(updated.id, updated);
    return updated;
  }

  private transition(session: RuntimeSession, phase: ExperimentPhase, patch: Partial<RuntimeSession>): RuntimeSession {
    if (!ALLOWED_TRANSITIONS[session.phase].includes(phase)) {
      throw conflict(`${session.phase}から${phase}への遷移は許可されていません。`, "INVALID_TRANSITION");
    }
    return this.patchSession(session, { ...patch, phase });
  }

  private patchSession(session: RuntimeSession, patch: Partial<RuntimeSession>): RuntimeSession {
    return { ...session, ...patch, updatedAt: this.now().toISOString() };
  }

  private requireActive(sessionId: string): RuntimeSession {
    const session = this.get(sessionId);
    if (this.activeSessionId !== sessionId) {
      throw conflict("このセッションは現在のアクティブセッションではありません。", "SESSION_NOT_ACTIVE");
    }
    return session;
  }

  private requirePhase(session: RuntimeSession, expected: ExperimentPhase): void {
    if (session.phase !== expected) {
      throw conflict(`現在の状態(${session.phase})ではこの操作を実行できません。`, "INVALID_STATE");
    }
  }

  private sessionForToken(displayToken: string): RuntimeSession {
    const sessionId = this.displayTokens.get(displayToken);
    if (sessionId === undefined) throw notFound("参加者画面トークンが無効です。", "DISPLAY_TOKEN_NOT_FOUND");
    return this.get(sessionId);
  }

  private operatorSnapshot(session: RuntimeSession): OperatorSessionSnapshot {
    const token = this.sessionTokens.get(session.id);
    if (token === undefined) throw new Error("参加者画面トークンが見つかりません。");
    const publicView = this.publicSnapshot(session);
    return {
      ...session,
      serverNow: this.now().toISOString(),
      displayToken: token,
      displayUrl: this.displayUrl(token),
      current: publicView.current,
      summary: publicView.summary,
      formUrl: publicView.formUrl,
      recentEvents: [...(this.recentEvents.get(session.id) ?? [])],
    };
  }

  private publicSnapshot(session: RuntimeSession): PublicSessionSnapshot {
    const showCondition = session.currentCondition !== null && TIMED_PHASES.has(session.phase);
    const current = showCondition
      ? this.publicCondition(session.currentCondition as ConditionCode, this.requireSequenceIndex(session))
      : null;
    const showSummary = session.phase === "summary" || session.phase === "completed";
    const summary = showSummary
      ? [...session.orderCode].map((conditionCode, index) =>
          this.publicCondition(conditionCode as ConditionCode, index as 0 | 1 | 2 | 3),
        )
      : [];
    const base: PublicSessionSnapshot = {
      phase: session.phase,
      sequenceIndex: session.sequenceIndex,
      current,
      fixedState: { ...session.fixedState },
      phaseStartedAt: session.phaseStartedAt,
      phaseEndsAt: session.phaseEndsAt,
      remainingMs:
        session.phaseEndsMonotonicMs === null
          ? session.remainingMs
          : Math.max(0, session.phaseEndsMonotonicMs - this.monotonicNow()),
      serverNow: this.now().toISOString(),
      recoveryRequired: session.recoveryRequired,
      result: session.result,
      summary,
      formUrl: showSummary && this.config.formUrl.length > 0 ? this.config.formUrl : null,
    };
    return base;
  }

  private publicCondition(conditionCode: ConditionCode, index: 0 | 1 | 2 | 3): PublicCondition {
    const condition = CONDITIONS[conditionCode];
    return {
      position: (index + 1) as 1 | 2 | 3 | 4,
      processing: condition.processing,
      presentation: condition.presentation,
    };
  }

  private displayUrl(displayToken: string): string {
    return `/display/${encodeURIComponent(displayToken)}`;
  }

  private cancelTimer(): void {
    this.timerGeneration += 1;
    if (this.phaseTimer !== null) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async audit(session: RuntimeSession, eventType: string, explicitErrorCode?: string): Promise<void> {
    const event = createLogEvent({
      session,
      appVersion: this.appVersion,
      eventType,
      wallClockIso: this.now().toISOString(),
      monotonicMs: this.monotonicNow(),
      deviceStatus: session.deviceStatus,
      ...(explicitErrorCode === undefined ? {} : { errorCode: explicitErrorCode }),
    });
    await this.logger.append(event);
    const recent = this.recentEvents.get(session.id) ?? [];
    recent.push({
      wallClockIso: event.wallClockIso,
      eventType: event.eventType,
      deviceStatus: event.deviceStatus ?? session.deviceStatus,
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    });
    if (recent.length > 20) recent.splice(0, recent.length - 20);
    this.recentEvents.set(session.id, recent);
  }
}
