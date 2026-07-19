import {
  CONDITIONS,
  conditionsForOrder,
  type ConditionCode,
  type OrderCode,
  type PresentationMode,
  type ProcessingLocation,
  type SequenceIndex,
} from "./conditions.js";
import type { DeviceMode, FixedState, TimingConfig } from "./schemas.js";

export const EXPERIMENT_PHASES = [
  "idle",
  "setup",
  "intro",
  "handling",
  "processing",
  "result",
  "reset",
  "summary",
  "completed",
  "aborted",
  "error",
] as const;

export type ExperimentPhase = (typeof EXPERIMENT_PHASES)[number];
export type Phase = ExperimentPhase;

export const PUFFER_DEVICE_STATES = [
  "disconnected",
  "connecting",
  "idle",
  "inflating",
  "holding",
  "deflating",
  "stopped",
  "fault",
] as const;

export type PufferDeviceState = (typeof PUFFER_DEVICE_STATES)[number];
export type SessionResult = "ok" | "aborted" | "error" | null;

export interface Session {
  readonly id: string;
  readonly researchId: string;
  readonly orderCode: OrderCode;
  readonly phase: ExperimentPhase;
  readonly sequenceIndex: SequenceIndex | null;
  readonly currentCondition: ConditionCode | null;
  readonly fixedState: FixedState;
  readonly deviceMode: DeviceMode;
  readonly deviceStatus: PufferDeviceState;
  readonly deviceLevel: number;
  readonly consentConfirmed: boolean;
  readonly displayConnected: boolean;
  readonly recoveryRequired: boolean;
  readonly phaseStartedAt: string | null;
  readonly phaseEndsAt: string | null;
  readonly phaseStartedMonotonicMs: number | null;
  readonly phaseEndsMonotonicMs: number | null;
  readonly remainingMs: number | null;
  readonly result: SessionResult;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly configHash: string;
  readonly protocolVersion: string;
}

export interface SessionCreationInput {
  readonly id: string;
  readonly researchId: string;
  readonly orderCode: OrderCode;
  readonly fixedState: FixedState;
  readonly deviceMode: DeviceMode;
  readonly configHash: string;
  readonly protocolVersion: string;
  readonly wallClockIso: string;
  readonly monotonicMs: number;
  readonly consentConfirmed?: boolean;
  readonly displayConnected?: boolean;
  readonly deviceStatus?: PufferDeviceState;
  readonly deviceLevel?: number;
}

export interface SetupPrerequisites {
  readonly consentConfirmed: boolean;
  readonly researchIdValid: boolean;
  readonly orderAssigned: boolean;
  readonly displayConnected: boolean;
  readonly deviceReady: boolean;
  readonly deviceDeflated: boolean;
  readonly configValid: boolean;
}

export interface TransitionContext {
  readonly wallClockIso: string;
  readonly monotonicMs: number;
  readonly timingMs?: TimingConfig;
  readonly durationMs?: number;
  readonly prerequisites?: SetupPrerequisites;
  readonly deviceReady?: boolean;
  readonly formCompletionConfirmed?: boolean;
  readonly errorCode?: string;
}

export interface PublicCurrentPresentation {
  readonly position: 1 | 2 | 3 | 4;
  readonly processing: ProcessingLocation;
  readonly presentation: PresentationMode;
}

export type PublicPresentationSummary = PublicCurrentPresentation;

/** Participant-safe state: it deliberately has no research ID, order code or A/B/C/D code. */
export interface PublicSnapshot {
  readonly phase: ExperimentPhase;
  readonly current: PublicCurrentPresentation | null;
  readonly fixedState: FixedState;
  readonly recoveryRequired: boolean;
  readonly phaseStartedAt: string | null;
  readonly phaseEndsAt: string | null;
  readonly remainingMs: number | null;
  readonly result: SessionResult;
  readonly summary: readonly PublicPresentationSummary[];
  readonly formUrl: string | null;
}

const phases = (...values: ExperimentPhase[]): readonly ExperimentPhase[] => Object.freeze(values);

export const ALLOWED_TRANSITIONS: Readonly<Record<ExperimentPhase, readonly ExperimentPhase[]>> =
  Object.freeze({
    idle: phases("setup", "aborted"),
    setup: phases("intro", "aborted"),
    intro: phases("handling", "aborted"),
    handling: phases("processing", "aborted", "error"),
    processing: phases("result", "aborted", "error"),
    result: phases("reset", "aborted", "error"),
    reset: phases("handling", "summary", "aborted", "error"),
    summary: phases("completed", "aborted"),
    completed: phases(),
    aborted: phases(),
    error: phases("aborted"),
  });

export class InvalidSessionTransitionError extends Error {
  public readonly code = "INVALID_SESSION_TRANSITION";
  public readonly statusCode = 409;

  public constructor(message: string) {
    super(message);
    this.name = "InvalidSessionTransitionError";
  }
}

function assertClock(wallClockIso: string, monotonicMs: number): void {
  if (!Number.isFinite(Date.parse(wallClockIso))) {
    throw new TypeError("wallClockIso must be a valid ISO 8601 timestamp.");
  }
  if (!Number.isFinite(monotonicMs) || monotonicMs < 0) {
    throw new RangeError("monotonicMs must be a non-negative finite number.");
  }
}

function isSequenceIndex(value: number): value is SequenceIndex {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

function durationForPhase(
  phase: ExperimentPhase,
  context: TransitionContext,
): number | null {
  if (context.durationMs !== undefined) {
    if (!Number.isFinite(context.durationMs) || context.durationMs < 0) {
      throw new RangeError("durationMs must be a non-negative finite number.");
    }
    return context.durationMs;
  }
  const timing = context.timingMs;
  if (timing === undefined) {
    return null;
  }
  switch (phase) {
    case "handling":
      return timing.handling;
    case "processing":
      return timing.processing;
    case "result":
      return timing.result;
    case "reset":
      return timing.reset;
    default:
      return null;
  }
}

function phaseEndIso(wallClockIso: string, durationMs: number): string {
  return new Date(Date.parse(wallClockIso) + durationMs).toISOString();
}

function timerHasElapsed(session: Session, monotonicMs: number): boolean {
  return session.phaseEndsMonotonicMs === null || monotonicMs >= session.phaseEndsMonotonicMs;
}

function isTimedForwardTransition(from: ExperimentPhase, to: ExperimentPhase): boolean {
  return (from === "handling" && to === "processing")
    || (from === "processing" && to === "result")
    || (from === "result" && to === "reset")
    || (from === "reset" && (to === "handling" || to === "summary"));
}

function assertTransitionGuard(
  session: Session,
  target: ExperimentPhase,
  context: TransitionContext,
): void {
  if (!canTransition(session.phase, target)) {
    throw new InvalidSessionTransitionError(
      `Transition from ${session.phase} to ${target} is not allowed.`,
    );
  }

  if (isTimedForwardTransition(session.phase, target) && !timerHasElapsed(session, context.monotonicMs)) {
    throw new InvalidSessionTransitionError("The server-controlled phase timer has not elapsed.");
  }

  if (session.phase === "setup" && target === "intro") {
    const prerequisites = context.prerequisites;
    if (prerequisites === undefined || Object.values(prerequisites).some((value) => !value)) {
      throw new InvalidSessionTransitionError("All setup prerequisites must be satisfied.");
    }
  }

  if (session.phase === "reset" && (target === "handling" || target === "summary")) {
    if (context.deviceReady !== true) {
      throw new InvalidSessionTransitionError("The device must be ready before leaving reset.");
    }
    if (target === "handling" && session.sequenceIndex === 3) {
      throw new InvalidSessionTransitionError("The fourth presentation must transition to summary.");
    }
    if (target === "summary" && session.sequenceIndex !== 3) {
      throw new InvalidSessionTransitionError("Summary is only available after the fourth presentation.");
    }
  }

  if (session.phase === "summary" && target === "completed" && context.formCompletionConfirmed !== true) {
    throw new InvalidSessionTransitionError("Form completion must be confirmed before completion.");
  }

  if (target === "error" && (context.errorCode === undefined || context.errorCode.length === 0)) {
    throw new InvalidSessionTransitionError("An error transition requires an errorCode.");
  }
}

export function canTransition(from: ExperimentPhase, to: ExperimentPhase): boolean {
  return ALLOWED_TRANSITIONS[from].some((candidate) => candidate === to);
}

export function createSession(input: SessionCreationInput): Session {
  assertClock(input.wallClockIso, input.monotonicMs);
  if (!Number.isFinite(input.deviceLevel ?? 0) || (input.deviceLevel ?? 0) < 0 || (input.deviceLevel ?? 0) > 1) {
    throw new RangeError("deviceLevel must be in [0, 1].");
  }
  const fixedState = Object.freeze({ ...input.fixedState });
  return Object.freeze({
    id: input.id,
    researchId: input.researchId,
    orderCode: input.orderCode,
    phase: "idle",
    sequenceIndex: null,
    currentCondition: null,
    fixedState,
    deviceMode: input.deviceMode,
    deviceStatus: input.deviceStatus ?? "disconnected",
    deviceLevel: input.deviceLevel ?? 0,
    consentConfirmed: input.consentConfirmed ?? false,
    displayConnected: input.displayConnected ?? false,
    recoveryRequired: false,
    phaseStartedAt: input.wallClockIso,
    phaseEndsAt: null,
    phaseStartedMonotonicMs: input.monotonicMs,
    phaseEndsMonotonicMs: null,
    remainingMs: null,
    result: null,
    errorCode: null,
    createdAt: input.wallClockIso,
    updatedAt: input.wallClockIso,
    configHash: input.configHash,
    protocolVersion: input.protocolVersion,
  });
}

export function transitionSession(
  session: Session,
  target: ExperimentPhase,
  context: TransitionContext,
): Session {
  assertClock(context.wallClockIso, context.monotonicMs);
  assertTransitionGuard(session, target, context);

  let sequenceIndex = session.sequenceIndex;
  if (target === "handling") {
    const nextIndex = session.phase === "intro"
      ? 0
      : (session.sequenceIndex ?? -1) + 1;
    if (!isSequenceIndex(nextIndex)) {
      throw new InvalidSessionTransitionError("No presentation remains in this order.");
    }
    sequenceIndex = nextIndex;
  }

  const conditions = conditionsForOrder(session.orderCode);
  const currentCondition = target === "summary" || target === "completed"
    ? null
    : sequenceIndex === null
      ? null
      : conditions[sequenceIndex] ?? null;
  const durationMs = durationForPhase(target, context);
  const result: SessionResult = target === "completed"
    ? "ok"
    : target === "aborted"
      ? "aborted"
      : target === "error"
        ? "error"
        : session.result;

  return Object.freeze({
    ...session,
    phase: target,
    sequenceIndex,
    currentCondition,
    recoveryRequired: false,
    phaseStartedAt: context.wallClockIso,
    phaseEndsAt: durationMs === null ? null : phaseEndIso(context.wallClockIso, durationMs),
    phaseStartedMonotonicMs: context.monotonicMs,
    phaseEndsMonotonicMs: durationMs === null ? null : context.monotonicMs + durationMs,
    remainingMs: durationMs,
    result,
    errorCode: target === "error" ? context.errorCode ?? null : session.errorCode,
    updatedAt: context.wallClockIso,
  });
}

export function getRemainingMs(session: Session, monotonicMs: number): number | null {
  if (session.phaseEndsMonotonicMs === null) {
    return null;
  }
  return Math.max(0, session.phaseEndsMonotonicMs - monotonicMs);
}

export function setDisplayConnection(
  session: Session,
  connected: boolean,
  wallClockIso: string,
): Session {
  const requiresRecovery = !connected && ["handling", "processing", "result", "reset"].includes(session.phase);
  return Object.freeze({
    ...session,
    displayConnected: connected,
    recoveryRequired: session.recoveryRequired || requiresRecovery,
    updatedAt: wallClockIso,
  });
}

export function confirmSessionRecovery(session: Session, wallClockIso: string): Session {
  if (!session.displayConnected) {
    throw new InvalidSessionTransitionError("The participant display must reconnect before recovery.");
  }
  return Object.freeze({
    ...session,
    recoveryRequired: false,
    updatedAt: wallClockIso,
  });
}

export function setDeviceSnapshot(
  session: Session,
  deviceStatus: PufferDeviceState,
  deviceLevel: number,
  wallClockIso: string,
): Session {
  if (!Number.isFinite(deviceLevel) || deviceLevel < 0 || deviceLevel > 1) {
    throw new RangeError("deviceLevel must be in [0, 1].");
  }
  return Object.freeze({ ...session, deviceStatus, deviceLevel, updatedAt: wallClockIso });
}

export function toPublicSnapshot(
  session: Session,
  monotonicMs: number,
  formUrl = "",
): PublicSnapshot {
  const current = session.currentCondition === null || session.sequenceIndex === null
    ? null
    : Object.freeze({
      position: (session.sequenceIndex + 1) as 1 | 2 | 3 | 4,
      ...CONDITIONS[session.currentCondition],
    });
  const showSummary = session.phase === "summary" || session.phase === "completed";
  const summary: readonly PublicPresentationSummary[] = showSummary
    ? Object.freeze(conditionsForOrder(session.orderCode).map((code, index) => Object.freeze({
      position: (index + 1) as 1 | 2 | 3 | 4,
      ...CONDITIONS[code],
    })))
    : Object.freeze([]);

  return Object.freeze({
    phase: session.phase,
    current,
    fixedState: session.fixedState,
    recoveryRequired: session.recoveryRequired,
    phaseStartedAt: session.phaseStartedAt,
    phaseEndsAt: session.phaseEndsAt,
    remainingMs: getRemainingMs(session, monotonicMs),
    result: session.result,
    summary,
    formUrl: showSummary && formUrl !== "" ? formUrl : null,
  });
}
