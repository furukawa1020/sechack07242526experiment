import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  ALLOWED_TRANSITIONS,
  allocateOrder,
  CONDITIONS,
  type ConditionCode,
  type ExperimentPhase,
  type OrderCode,
} from "../../shared/index.js";
import { badRequest, conflict, notFound } from "../api/http-error.js";
import { waitForConfirmedDeflatedStatus } from "../devices/index.js";
import type {
  DeviceAck,
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

export interface DeviceTestResult {
  readonly status: DeviceStatus;
  readonly ack: DeviceAck | null;
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
  if (status.state !== "idle") return false;
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
  private readonly displayFullscreenStates = new Map<string, boolean | null>();
  private readonly pausedRemainingMs = new Map<string, number>();
  private readonly recentEvents = new Map<string, Array<{
    wallClockIso: string;
    eventType: string;
    deviceStatus: string;
    errorCode?: string;
  }>>();
  private readonly listeners = new Set<Listener>();
  private activeSessionId: string | null = null;
  private creationPending = false;
  private deviceOperationTail: Promise<void> = Promise.resolve();
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private timerGeneration = 0;
  private handlingFailure = false;
  private emergencyLocked = false;
  private lastDeviceStatus: DeviceStatus | null = null;
  private lastSafetyFailure: Error | null = null;
  private auditStorageHealthy = true;
  private readonly backgroundTasks = new Set<Promise<void>>();
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
      this.trackBackgroundTask(this.handleDeviceStatus(status).catch((error: unknown) => {
        this.handleBackgroundFailure(error, "DEVICE_STATUS_HANDLER_FAILED");
      }));
    });
  }

  public dispose(): void {
    this.cancelTimer();
    this.unsubscribeDevice();
    this.listeners.clear();
  }

  /** Safely terminates any active run and always attempts STOP then DEFLATE. */
  public async shutdown(): Promise<void> {
    try {
      const active = this.activeSessionId === null ? null : this.sessions.get(this.activeSessionId) ?? null;
      if (active === null) {
        await this.safeStopAndDeflate();
        this.throwIfSafetyUnconfirmed();
        return;
      }
      if (active.phase === "completed" || active.phase === "aborted") {
        await this.safeStopAndDeflate();
        this.throwIfSafetyUnconfirmed();
        this.activeSessionId = null;
        return;
      }
      await this.abort(active.id);
      this.throwIfSafetyUnconfirmed();
    } finally {
      await this.flushBackgroundTasks();
    }
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async create(input: CreateSessionInput): Promise<CreatedSession> {
    this.requireAuditStorageHealthy();
    if (this.activeSessionId !== null || this.creationPending) {
      throw conflict("進行中または確認待ちのセッションがあります。", "ACTIVE_SESSION_EXISTS");
    }
    this.creationPending = true;
    try {
      return await this.createReserved(input);
    } finally {
      this.creationPending = false;
    }
  }

  private async createReserved(input: CreateSessionInput): Promise<CreatedSession> {
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
    this.displayFullscreenStates.set(id, null);
    this.activeSessionId = id;
    try {
      await this.audit(session, "session.created");
    } catch (error) {
      this.sessions.delete(id);
      this.displayTokens.delete(displayToken);
      this.sessionTokens.delete(id);
      this.readyDisplayConnections.delete(id);
      this.displayFullscreenStates.delete(id);
      this.activeSessionId = null;
      throw error;
    }
    this.emergencyLocked = false;
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
    const initial = this.requireActive(sessionId);
    this.requirePhase(initial, "setup");
    if (!initial.displayConnected) {
      throw conflict("参加者画面の接続を確認してください。", "DISPLAY_NOT_READY");
    }
    const status = await this.runDeviceOperation(() => this.device.getStatus());
    const session = this.requireActive(sessionId);
    this.requirePhase(session, "setup");
    if (!session.displayConnected) {
      throw conflict("参加者画面の接続を確認してください。", "DISPLAY_NOT_READY");
    }
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
    this.emit({ type: "session.phaseChanged", sessionId: updated.id });
    try {
      await this.audit(updated, "session.resumed");
    } catch {
      const current = this.sessions.get(updated.id);
      if (
        current !== undefined
        && this.activeSessionId === current.id
        && current.phase !== "error"
        && !TERMINAL_PHASES.has(current.phase)
      ) {
        await this.failSession(current, "AUDIT_STORAGE_FAILED");
      }
    }
    return this.operatorSnapshot(this.get(updated.id));
  }

  public async abort(sessionId: string): Promise<OperatorSessionSnapshot> {
    const session = this.requireActive(sessionId);
    if (TERMINAL_PHASES.has(session.phase)) {
      throw conflict("終了済みセッションは中止できません。", "SESSION_ALREADY_TERMINAL");
    }
    this.cancelTimer();
    const terminal = this.enterTerminalPhase(session, "aborted", "aborted", null, "session.aborted");
    const safety = this.safeStopAndDeflate();
    await Promise.all([terminal, safety]);
    this.requireSafetyConfirmed();
    this.requireAuditStorageHealthy();
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
    return this.operatorSnapshot(this.get(sessionId));
  }

  public async emergencyStop(sessionId: string): Promise<OperatorSessionSnapshot> {
    this.cancelTimer();
    this.emergencyLocked = true;
    // Start STOP before consulting session state so stale Operator views can
    // always repeat the global physical safety command.
    const safety = this.safeStopAndDeflate();
    const session = this.get(sessionId);
    let terminal: Promise<RuntimeSession> | null = null;
    if (this.activeSessionId === sessionId && !TERMINAL_PHASES.has(session.phase)) {
      terminal = this.enterTerminalPhase(
        session,
        "aborted",
        "aborted",
        "EMERGENCY_STOP",
        "session.emergencyStop",
      );
    }
    await Promise.all([safety, ...(terminal === null ? [] : [terminal])]);
    this.requireSafetyConfirmed();
    this.requireAuditStorageHealthy();
    if (this.activeSessionId === sessionId && TERMINAL_PHASES.has(this.get(sessionId).phase)) {
      this.activeSessionId = null;
    }
    return this.operatorSnapshot(this.get(sessionId));
  }

  public async confirmFormComplete(sessionId: string): Promise<OperatorSessionSnapshot> {
    const session = this.requireActive(sessionId);
    this.requirePhase(session, "summary");
    const updated = await this.enterTerminalPhase(session, "completed", "ok", null, "session.completed");
    this.requireAuditStorageHealthy();
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
    return this.operatorSnapshot(this.get(updated.id));
  }

  public async delete(sessionId: string): Promise<void> {
    let session = this.get(sessionId);
    if (this.activeSessionId === sessionId && session.phase !== "setup") {
      throw conflict("進行中または確認待ちのセッションは削除できません。", "SESSION_DELETE_UNSAFE");
    }
    if (session.phase === "error") {
      throw conflict("error状態は中止確認後にのみ削除できます。", "SESSION_DELETE_UNSAFE");
    }
    if (this.activeSessionId === sessionId) {
      this.cancelTimer();
      await this.safeStopAndDeflate();
      this.requireSafetyConfirmed();
      session = this.get(sessionId);
      if (session.phase === "error") {
        throw conflict("安全停止の監査に失敗しました。中止確認後にのみ削除できます。", "SESSION_DELETE_UNSAFE");
      }
      this.activeSessionId = null;
    }
    await this.audit(session, "session.deleted");
    const token = this.sessionTokens.get(sessionId);
    if (token !== undefined) this.displayTokens.delete(token);
    this.sessionTokens.delete(sessionId);
    this.readyDisplayConnections.delete(sessionId);
    this.displayFullscreenStates.delete(sessionId);
    this.pausedRemainingMs.delete(sessionId);
    this.sessions.delete(sessionId);
    this.recentEvents.delete(sessionId);
  }

  public markDisplayReady(displayToken: string, connectionId: string): void {
    const session = this.sessionForToken(displayToken);
    const connections = this.readyDisplayConnections.get(session.id) ?? new Set<string>();
    if (connections.size > 0 && !connections.has(connectionId)) {
      throw conflict("参加者画面は同時に1接続だけ使用できます。", "DISPLAY_ALREADY_CONNECTED");
    }
    connections.add(connectionId);
    this.readyDisplayConnections.set(session.id, connections);
    if (!session.displayConnected) {
      const updated = this.patchSession(session, { displayConnected: true });
      this.sessions.set(updated.id, updated);
      this.trackBackgroundTask(this.audit(updated, "display.ready").catch((error: unknown) => {
        this.handleBackgroundFailure(error, "AUDIT_STORAGE_FAILED");
      }));
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

    this.displayFullscreenStates.set(session.id, null);
    let updated = this.patchSession(session, { displayConnected: false });
    this.sessions.set(updated.id, updated);
    this.trackBackgroundTask(this.audit(updated, "display.disconnected").catch((error: unknown) => {
      this.handleBackgroundFailure(error, "AUDIT_STORAGE_FAILED");
    }));

    if (this.activeSessionId === updated.id && isPufferPhase(updated)) {
      void this.failSession(updated, "DISPLAY_LOST_DURING_PUFFER").catch((error: unknown) => {
        this.handleBackgroundFailure(error, "DISPLAY_FAILURE_HANDLER_FAILED");
      });
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
      this.trackBackgroundTask(this.audit(updated, "session.recoveryRequired").catch((error: unknown) => {
        this.handleBackgroundFailure(error, "AUDIT_STORAGE_FAILED");
      }));
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

  public markDisplayFullscreen(displayToken: string, connectionId: string, fullscreen: boolean): void {
    const session = this.sessionForToken(displayToken);
    const connections = this.readyDisplayConnections.get(session.id);
    if (connections?.has(connectionId) !== true) {
      throw conflict("参加者画面のready確認が必要です。", "DISPLAY_NOT_READY");
    }
    if (this.displayFullscreenStates.get(session.id) === fullscreen) return;
    this.displayFullscreenStates.set(session.id, fullscreen);
    this.emit({ type: "session.snapshot", sessionId: session.id });
  }

  /** A run must never continue unattended after the final Operator connection is lost. */
  public markOperatorDisconnected(): void {
    const active = this.activeSessionId === null ? undefined : this.sessions.get(this.activeSessionId);
    if (
      active === undefined
      || active.phase === "setup"
      || active.phase === "error"
      || TERMINAL_PHASES.has(active.phase)
    ) return;
    void this.failSession(active, "OPERATOR_CONNECTION_LOST").catch((error: unknown) => {
      this.handleBackgroundFailure(error, "OPERATOR_DISCONNECT_HANDLER_FAILED");
    });
  }

  public async connectDevice(): Promise<DeviceStatus> {
    this.requireDeviceTestAllowed("connect");
    return this.runDeviceOperation(async () => {
      this.requireDeviceTestAllowed("connect");
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.connect.issued"));
      await this.device.connect();
      const status = await this.device.getStatus();
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.connect.ack"));
      return status;
    });
  }

  public async disconnectDevice(): Promise<DeviceStatus> {
    this.requireDeviceTestAllowed("disconnect");
    return this.runDeviceOperation(async () => {
      this.requireDeviceTestAllowed("disconnect");
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.disconnect.issued"));
      await this.device.disconnect();
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.disconnect.ack"));
      if (this.lastDeviceStatus !== null) return this.lastDeviceStatus;
      return this.device.getStatus();
    });
  }

  public async pingDevice(): Promise<DeviceStatus> {
    this.requireDeviceTestAllowed("ping");
    return this.runDeviceOperation(() => {
      this.requireDeviceTestAllowed("ping");
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.ping.issued"));
      return this.device.ping().then((status) => {
        this.trackBackgroundTask(this.auditActiveDeviceEvent("device.ping.ack"));
        return status;
      });
    });
  }

  public async getDeviceStatus(): Promise<DeviceStatus> {
    try {
      return await this.runDeviceOperation(() => this.device.getStatus());
    } catch (error) {
      if (this.lastDeviceStatus?.state === "disconnected") return this.lastDeviceStatus;
      throw error;
    }
  }

  public async testInflate(level: number): Promise<DeviceTestResult> {
    this.requireDeviceTestAllowed("inflate");
    if (level < 0 || level > this.config.fixedState.pufferLevel) {
      throw conflict("テスト膨張量は設定済み上限以下で指定してください。", "DEVICE_LEVEL_OUT_OF_RANGE");
    }
    return this.runDeviceOperation(async () => {
      this.requireDeviceTestAllowed("inflate");
      const before = await this.device.getStatus();
      if (!isSafeDeflatedStatus(before)) {
        throw conflict("膨張テスト前に装置をidleかつ収縮済みにしてください。", "DEVICE_NOT_READY");
      }
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.inflate.issued"));
      const ack = await this.device.inflate({
        level,
        rampMs: this.config.timingMs.inflateRamp,
        requestId: randomUUID(),
      });
      const status = await this.device.getStatus();
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.inflate.ack"));
      return { status, ack };
    });
  }

  public async testDeflate(): Promise<DeviceTestResult> {
    this.requireDeviceTestAllowed("deflate");
    return this.runDeviceOperation(async () => {
      this.requireDeviceTestAllowed("deflate");
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.deflate.issued"));
      const ack = await this.device.deflate({
        rampMs: this.config.timingMs.deflateRamp,
        requestId: randomUUID(),
      });
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.deflate.ack"));
      const status = await waitForConfirmedDeflatedStatus(this.device, {
        timeoutMs: this.config.timingMs.deflateRamp + this.config.device.ackTimeout + 1_000,
      });
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.deflate.complete"));
      return { status, ack };
    });
  }

  public async stopDevice(): Promise<DeviceTestResult> {
    const active = this.activeSessionId === null ? undefined : this.sessions.get(this.activeSessionId);
    if (active !== undefined && active.phase !== "setup" && !TERMINAL_PHASES.has(active.phase)) {
      await this.emergencyStop(active.id);
      return { status: await this.getDeviceStatus(), ack: null };
    }
    this.trackBackgroundTask(this.auditActiveDeviceEvent("device.stop.issued"));
    const ack = await this.device.stop({ requestId: randomUUID() });
    this.trackBackgroundTask(this.auditActiveDeviceEvent("device.stop.ack"));
    return { status: await this.device.getStatus(), ack };
  }

  public exportCsv(): Promise<string> {
    return this.logger.exportCsv();
  }

  private requireDeviceTestAllowed(action: string): void {
    if (this.emergencyLocked && action !== "connect" && action !== "deflate") {
      throw conflict("緊急停止後は新しいセッションを作成するまで装置操作できません。", "DEVICE_EMERGENCY_LOCKED");
    }
    if (this.activeSessionId === null) return;
    const active = this.get(this.activeSessionId);
    if (active.phase !== "setup") {
      throw conflict("本番セッション中はデバイステスト操作を実行できません。", "DEVICE_TEST_LOCKED");
    }
  }

  private runDeviceOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.deviceOperationTail.then(operation, operation);
    this.deviceOperationTail = result.then(() => undefined, () => undefined);
    return result;
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
    this.emit({ type: "session.phaseChanged", sessionId: updated.id });
    const generation = this.timerGeneration;
    const auditResult = this.audit(updated, `phase.${phase}`).then(
      () => null,
      (error: unknown) => error,
    );

    const condition = CONDITIONS[currentCondition];
    const issuedAuditResult = (
      phase === "result" && condition.presentation === "puffer"
        ? this.audit(updated, "device.inflate.issued")
        : phase === "reset" && condition.presentation === "puffer"
          ? this.audit(updated, "device.deflate.issued")
          : Promise.resolve()
    ).then(
      () => null,
      (error: unknown) => error,
    );
    let commandError: unknown = null;
    let deviceAuditError: unknown = null;
    try {
      if (phase === "result" && condition.presentation === "puffer") {
        await this.device.inflate({
          level: updated.fixedState.pufferLevel,
          rampMs: this.config.timingMs.inflateRamp,
          requestId: randomUUID(),
        });
        const status = await this.device.getStatus();
        if (this.isCurrentTimedPhase(updated.id, phase, sequenceIndex, generation)) {
          updated = this.refreshDeviceStatus(updated.id, status);
        }
        const currentAfterAck = this.sessions.get(updated.id);
        if (currentAfterAck !== undefined) {
          try {
            await this.audit(currentAfterAck, "device.inflate.ack");
          } catch (error) {
            deviceAuditError = error;
          }
        }
      } else if (phase === "reset" && condition.presentation === "puffer") {
        await this.device.deflate({
          rampMs: this.config.timingMs.deflateRamp,
          requestId: randomUUID(),
        });
        const status = await this.device.getStatus();
        if (this.isCurrentTimedPhase(updated.id, phase, sequenceIndex, generation)) {
          updated = this.refreshDeviceStatus(updated.id, status);
        }
        const currentAfterAck = this.sessions.get(updated.id);
        if (currentAfterAck !== undefined) {
          try {
            await this.audit(currentAfterAck, "device.deflate.ack");
          } catch (error) {
            deviceAuditError = error;
          }
        }
      }
    } catch (error) {
      commandError = error;
    }

    const [auditError, issuedAuditError] = await Promise.all([auditResult, issuedAuditResult]);
    const current = this.sessions.get(updated.id);
    if (
      current !== undefined
      && this.activeSessionId === current.id
      && current.phase !== "error"
      && !TERMINAL_PHASES.has(current.phase)
    ) {
      if (commandError !== null) {
        await this.failSession(current, errorCode(commandError, "DEVICE_COMMAND_FAILED"));
      } else if (auditError !== null || issuedAuditError !== null || deviceAuditError !== null) {
        await this.failSession(current, "AUDIT_STORAGE_FAILED");
      }
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
    this.emit({ type: "session.phaseChanged", sessionId: updated.id });
    try {
      await this.audit(updated, `phase.${phase}`);
    } catch {
      const current = this.sessions.get(updated.id);
      if (
        current !== undefined
        && this.activeSessionId === current.id
        && current.phase !== "error"
        && !TERMINAL_PHASES.has(current.phase)
      ) {
        await this.failSession(current, "AUDIT_STORAGE_FAILED");
      }
    }
    return this.get(updated.id);
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
    this.emit({
      type: phase === "completed" ? "session.completed" : "session.aborted",
      sessionId: updated.id,
    });
    try {
      await this.audit(this.get(updated.id), eventType);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Terminal session audit failed.");
    }
    return this.get(updated.id);
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
      void this.advancePhase(session.id, session.phase).catch((error: unknown) => {
        this.handleBackgroundFailure(error, errorCode(error, "PHASE_ADVANCE_FAILED"));
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
          const latest = this.sessions.get(session.id);
          if (
            latest === undefined
            || this.activeSessionId !== session.id
            || latest.phase !== "reset"
            || latest.sequenceIndex !== index
            || latest.recoveryRequired
          ) return;
          if (!isSafeDeflatedStatus(status)) {
            await this.failSession(latest, "DEFLATE_NOT_CONFIRMED");
            return;
          }
        }
        const current = this.sessions.get(session.id);
        if (
          current === undefined
          || this.activeSessionId !== session.id
          || current.phase !== "reset"
          || current.sequenceIndex !== index
          || current.recoveryRequired
        ) return;
        if (index === 3) {
          await this.enterUntimedPhase(current, "summary", { currentCondition: null });
        } else {
          const nextIndex = (index + 1) as 0 | 1 | 2 | 3;
          await this.enterTimedPhase(current, "handling", nextIndex);
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
    const current = this.sessions.get(session.id);
    if (
      this.handlingFailure
      || current === undefined
      || current.phase === "error"
      || TERMINAL_PHASES.has(current.phase)
    ) return;
    this.handlingFailure = true;
    try {
      this.cancelTimer();
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
      const safety = this.safeStopAndDeflate();
      this.emit({ type: "session.error", sessionId: updated.id });
      await safety;
      try {
        await this.audit(this.get(updated.id), "session.error");
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Error-state audit failed.");
      }
    } finally {
      this.handlingFailure = false;
    }
  }

  private async safeStopAndDeflate(): Promise<void> {
    let firstError: unknown;
    this.trackBackgroundTask(this.auditActiveDeviceEvent("device.stop.issued"));
    try {
      await this.device.stop({ requestId: randomUUID() });
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.stop.ack"));
    } catch (error) {
      firstError = error;
    }
    this.trackBackgroundTask(this.auditActiveDeviceEvent("device.deflate.issued"));
    try {
      await this.device.deflate({ rampMs: this.config.timingMs.deflateRamp, requestId: randomUUID() });
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.deflate.ack"));
      const confirmedStatus = await waitForConfirmedDeflatedStatus(this.device, {
        timeoutMs: this.config.timingMs.deflateRamp + this.config.device.ackTimeout + 1_000,
      });
      this.lastDeviceStatus = confirmedStatus;
      this.trackBackgroundTask(this.auditActiveDeviceEvent("device.deflate.complete"));
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) {
      console.error(`Device safety command failed: ${errorCode(firstError, "DEVICE_SAFETY_FAILED")}`);
      // Both operations were attempted. The session transition still has to be recorded.
      const active = this.activeSessionId === null ? undefined : this.sessions.get(this.activeSessionId);
      if (active !== undefined) {
        try {
          await this.audit(active, "device.safetyCommandFailed", errorCode(firstError, "DEVICE_SAFETY_FAILED"));
        } catch (error) {
          console.error(error instanceof Error ? error.message : "Device safety failure audit failed.");
        }
      }
    }
    const lastStatus = this.lastDeviceStatus;
    const alreadySafelyDisconnected = lastStatus?.state === "disconnected"
      && lastStatus.level <= 0
      && lastStatus.fault === null;
    this.lastSafetyFailure = firstError === undefined || alreadySafelyDisconnected
      ? null
      : firstError instanceof Error
        ? firstError
        : new Error("Unknown device safety failure.");
  }

  private throwIfSafetyUnconfirmed(): void {
    if (this.lastSafetyFailure !== null) {
      throw new AggregateError([this.lastSafetyFailure], "Device STOP/DEFLATE could not be confirmed during shutdown.");
    }
  }

  private requireSafetyConfirmed(): void {
    if (this.lastSafetyFailure !== null) {
      throw conflict(
        "STOPまたはDEFLATEを確認できません。物理安全を確認し、緊急停止を再送してください。",
        "DEVICE_SAFETY_UNCONFIRMED",
      );
    }
  }

  private requireAuditStorageHealthy(): void {
    if (!this.auditStorageHealthy) {
      throw conflict(
        "監査ログを保存できません。新しい進行を開始せず、保存先を確認してサーバーを再起動してください。",
        "AUDIT_STORAGE_UNAVAILABLE",
      );
    }
  }

  private async auditActiveDeviceEvent(eventType: string): Promise<void> {
    const active = this.activeSessionId === null ? undefined : this.sessions.get(this.activeSessionId);
    if (active === undefined) return;
    try {
      await this.audit(active, eventType);
    } catch (error) {
      this.handleBackgroundFailure(error, "AUDIT_STORAGE_FAILED");
    }
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    }).catch(() => undefined);
  }

  private async flushBackgroundTasks(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }

  private async handleDeviceStatus(status: DeviceStatus): Promise<void> {
    this.lastDeviceStatus = status;
    const active = this.activeSessionId === null ? undefined : this.sessions.get(this.activeSessionId);
    if (active !== undefined) {
      const updated = this.refreshDeviceStatus(active.id, status);
      this.emit({ type: "device.status", sessionId: updated.id, deviceStatus: status });
      this.trackBackgroundTask(this.audit(updated, "device.status").catch((error: unknown) => {
        this.handleBackgroundFailure(error, "AUDIT_STORAGE_FAILED");
      }));
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

  private refreshDeviceStatus(sessionId: string, status: DeviceStatus): RuntimeSession {
    const current = this.get(sessionId);
    const updated = this.patchSession(current, { deviceStatus: status.state, deviceLevel: status.level });
    this.sessions.set(updated.id, updated);
    return updated;
  }

  private isCurrentTimedPhase(
    sessionId: string,
    phase: "handling" | "processing" | "result" | "reset",
    sequenceIndex: 0 | 1 | 2 | 3,
    generation: number,
  ): boolean {
    const current = this.sessions.get(sessionId);
    return current !== undefined
      && this.activeSessionId === sessionId
      && this.timerGeneration === generation
      && current.phase === phase
      && current.sequenceIndex === sequenceIndex
      && !current.recoveryRequired;
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
      displayFullscreen: this.displayFullscreenStates.get(session.id) ?? null,
    };
  }

  private publicSnapshot(session: RuntimeSession): PublicSessionSnapshot {
    const showCondition = session.currentCondition !== null && TIMED_PHASES.has(session.phase);
    const current = showCondition
      ? this.publicCondition(session.currentCondition as ConditionCode, this.requireSequenceIndex(session))
      : null;
    const showSummary = session.phase === "summary" || session.phase === "completed";
    const showLabelState = session.phase === "result"
      && session.currentCondition !== null
      && CONDITIONS[session.currentCondition].presentation === "label";
    const summary = showSummary
      ? [...session.orderCode].map((conditionCode, index) =>
          this.publicCondition(conditionCode as ConditionCode, index as 0 | 1 | 2 | 3),
        )
      : [];
    const base: PublicSessionSnapshot = {
      phase: session.phase,
      sequenceIndex: session.sequenceIndex,
      current,
      fixedState: showLabelState
        ? { score: session.fixedState.score, label: session.fixedState.label }
        : null,
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

  private handleBackgroundFailure(error: unknown, failureCode: string): void {
    console.error(error instanceof Error ? error.message : failureCode);
    const active = this.activeSessionId === null ? undefined : this.sessions.get(this.activeSessionId);
    if (active === undefined || active.phase === "error" || TERMINAL_PHASES.has(active.phase)) return;
    void this.failSession(active, failureCode).catch((nestedError: unknown) => {
      console.error(nestedError instanceof Error ? nestedError.message : "Session safety handling failed.");
    });
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
    try {
      await this.logger.append(event);
    } catch (error) {
      this.auditStorageHealthy = false;
      throw error;
    }
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
