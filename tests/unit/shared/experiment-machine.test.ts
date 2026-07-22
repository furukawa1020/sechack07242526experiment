import { describe, expect, it } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  canTransition,
  confirmSessionRecovery,
  createSession,
  getRemainingMs,
  InvalidSessionTransitionError,
  setDeviceSnapshot,
  setDisplayConnection,
  toPublicSnapshot,
  transitionSession,
  type ExperimentPhase,
  type Session,
  type SetupPrerequisites,
} from "../../../src/shared/experiment-machine.js";
import type { TimingConfig } from "../../../src/shared/schemas.js";
import { SCREEN_PROTOCOL_VERSION } from "../../../src/shared/schemas.js";

const timing: TimingConfig = Object.freeze({
  handling: 80,
  processing: 30,
  result: 150,
  reset: 70,
  inflateRamp: 60,
  deflateRamp: 60,
});

const prerequisites: SetupPrerequisites = Object.freeze({
  consentConfirmed: true,
  researchIdValid: true,
  orderAssigned: true,
  displayConnected: true,
  deviceReady: true,
  deviceDeflated: true,
  configValid: true,
});

function iso(milliseconds: number): string {
  return new Date(Date.UTC(2026, 6, 19, 12, 0, 0, milliseconds)).toISOString();
}

function newSession(): Session {
  return createSession({
    id: "11111111-1111-4111-8111-111111111111",
    researchId: "SH26-001",
    orderCode: "ABDC",
    fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
    deviceMode: "mock",
    configHash: "a".repeat(64),
    protocolVersion: SCREEN_PROTOCOL_VERSION,
    wallClockIso: iso(0),
    monotonicMs: 0,
    consentConfirmed: true,
    displayConnected: true,
    deviceStatus: "idle",
  });
}

function context(monotonicMs: number, extra: Record<string, unknown> = {}) {
  return {
    wallClockIso: iso(monotonicMs),
    monotonicMs,
    ...extra,
  };
}

describe("experiment state machine", () => {
  it("exposes only the protocol transition graph", () => {
    expect(ALLOWED_TRANSITIONS.idle).toEqual(["setup", "aborted"]);
    expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
    expect(canTransition("handling", "processing")).toBe(true);
    expect(canTransition("completed", "setup")).toBe(false);
  });

  it("completes all four presentations using server-owned phase deadlines", () => {
    let session = newSession();
    expect(Object.isFrozen(session.fixedState)).toBe(true);
    session = transitionSession(session, "setup", context(1));
    session = transitionSession(session, "intro", context(2, { prerequisites }));

    const expectedConditions = ["A", "B", "D", "C"];
    let now = 3;
    for (let presentation = 0; presentation < 4; presentation += 1) {
      session = transitionSession(session, "handling", context(now, {
        timingMs: timing,
        ...(presentation === 0 ? {} : { deviceReady: true }),
      }));
      expect(session.sequenceIndex).toBe(presentation);
      expect(session.currentCondition).toBe(expectedConditions[presentation]);
      expect(session.phaseEndsMonotonicMs).toBe(now + timing.handling);
      expect(session.phaseEndsAt).toBe(iso(now + timing.handling));
      expect(getRemainingMs(session, now + 10)).toBe(timing.handling - 10);

      now += timing.handling;
      session = transitionSession(session, "processing", context(now, { timingMs: timing }));
      now += timing.processing;
      session = transitionSession(session, "result", context(now, { timingMs: timing }));
      now += timing.result;
      session = transitionSession(session, "reset", context(now, { timingMs: timing }));
      now += timing.reset;
      if (presentation === 3) {
        session = transitionSession(session, "summary", context(now, { deviceReady: true }));
      }
    }
    expect(session.phase).toBe("summary");
    expect(session.currentCondition).toBeNull();
    expect(() => transitionSession(session, "completed", context(now + 1)))
      .toThrow(/Staff handoff/iu);
    session = transitionSession(session, "completed", context(now + 1, {
      staffHandoffConfirmed: true,
    }));
    expect(session.result).toBe("ok");
    expect(session.remainingMs).toBeNull();
  });

  it("rejects missing setup guards, early timers and incorrect reset branches", () => {
    let session = transitionSession(newSession(), "setup", context(1));
    expect(() => transitionSession(session, "intro", context(2)))
      .toThrow(InvalidSessionTransitionError);
    expect(() => transitionSession(session, "intro", context(2, {
      prerequisites: { ...prerequisites, configValid: false },
    }))).toThrow(/prerequisites/iu);
    session = transitionSession(session, "intro", context(2, { prerequisites }));
    session = transitionSession(session, "handling", context(3, { timingMs: timing }));
    expect(() => transitionSession(session, "processing", context(4, { timingMs: timing })))
      .toThrow(/timer/iu);

    const fourthReset: Session = {
      ...session,
      phase: "reset",
      sequenceIndex: 3,
      currentCondition: "C",
      phaseEndsMonotonicMs: 0,
    };
    expect(() => transitionSession(fourthReset, "handling", context(100, { deviceReady: true })))
      .toThrow(/fourth presentation/iu);
    expect(() => transitionSession(fourthReset, "summary", context(100, { deviceReady: false })))
      .toThrow(/device must be ready/iu);
    const firstReset = { ...fourthReset, sequenceIndex: 0 as const, currentCondition: "A" as const };
    expect(() => transitionSession(firstReset, "summary", context(100, { deviceReady: true })))
      .toThrow(/fourth presentation/iu);
  });

  it("requires error codes and makes terminal sessions non-restartable", () => {
    const handling: Session = {
      ...newSession(),
      phase: "handling",
      sequenceIndex: 0,
      currentCondition: "A",
    };
    expect(() => transitionSession(handling, "error", context(10))).toThrow(/errorCode/iu);
    const failed = transitionSession(handling, "error", context(10, { errorCode: "DEVICE_FAULT" }));
    expect(failed.result).toBe("error");
    expect(failed.errorCode).toBe("DEVICE_FAULT");
    const aborted = transitionSession(failed, "aborted", context(11));
    expect(aborted.result).toBe("aborted");
    expect(aborted.errorCode).toBe("DEVICE_FAULT");
    expect(() => transitionSession(aborted, "setup", context(12)))
      .toThrow(InvalidSessionTransitionError);
  });

  it("allows abort only from the documented nonterminal phases", () => {
    const abortable: readonly ExperimentPhase[] = [
      "idle", "setup", "intro", "handling", "processing", "result", "reset", "summary",
    ];
    for (const phase of abortable) {
      const session: Session = { ...newSession(), phase };
      expect(transitionSession(session, "aborted", context(20)).phase).toBe("aborted");
    }
  });

  it.each(["intro", "handling", "processing", "summary"] as const)(
    "marks %s display loss for operator-confirmed recovery",
    (phase) => {
      const active: Session = {
        ...newSession(),
        phase,
        ...(phase === "handling" || phase === "processing"
          ? { sequenceIndex: 0 as const, currentCondition: "A" as const }
          : {}),
      };
      const disconnected = setDisplayConnection(active, false, iso(10));
      expect(disconnected.displayConnected).toBe(false);
      expect(disconnected.recoveryRequired).toBe(true);
      expect(() => confirmSessionRecovery(disconnected, iso(11))).toThrow(/reconnect/iu);
      const reconnected = setDisplayConnection(disconnected, true, iso(12));
      expect(reconnected.recoveryRequired).toBe(true);
      expect(confirmSessionRecovery(reconnected, iso(13)).recoveryRequired).toBe(false);
    },
  );

  it.each([
    ["A", "result"],
    ["B", "result"],
    ["C", "result"],
    ["D", "result"],
    ["A", "reset"],
    ["B", "reset"],
    ["C", "reset"],
    ["D", "reset"],
  ] as const)("makes condition %s %s display loss non-resumable", (condition, phase) => {
    const critical: Session = {
      ...newSession(),
      phase,
      sequenceIndex: 0,
      currentCondition: condition,
    };
    const disconnected = setDisplayConnection(critical, false, iso(20));
    expect(disconnected).toMatchObject({ displayConnected: false, recoveryRequired: true });
    const reconnected = setDisplayConnection(disconnected, true, iso(21));
    expect(() => confirmSessionRecovery(reconnected, iso(22))).toThrow(/stimulus loss/iu);
  });

  it("does not require recovery when an idle display disconnects", () => {
    expect(setDisplayConnection(newSession(), false, iso(30)).recoveryRequired).toBe(false);
  });

  it("updates device state with normalized values only", () => {
    expect(setDeviceSnapshot(newSession(), "holding", 0.6, iso(20))).toMatchObject({
      deviceStatus: "holding",
      deviceLevel: 0.6,
    });
    expect(() => setDeviceSnapshot(newSession(), "holding", 1.1, iso(20))).toThrow(RangeError);
    expect(() => createSession({
      ...newSession(),
      wallClockIso: "bad timestamp",
      monotonicMs: 0,
    })).toThrow(TypeError);
  });

  it("creates participant-safe snapshots without internal condition codes", () => {
    const active: Session = {
      ...newSession(),
      phase: "result",
      sequenceIndex: 0,
      currentCondition: "A",
      phaseEndsMonotonicMs: 100,
      remainingMs: 100,
    };
    const snapshot = toPublicSnapshot(active, 25, timing, false, iso(25));
    expect(snapshot.current).toEqual({ position: 1, processing: "cloud", presentation: "label" });
    expect(snapshot).not.toHaveProperty("formUrl");
    expect(snapshot.remainingMs).toBe(75);
    expect(snapshot.summary).toEqual([]);
    expect(snapshot.pufferSurface).toBe("screen");
    expect(snapshot.pufferRamp).toEqual({ inflateMs: 60, deflateMs: 60 });
    expect(snapshot.serverNow).toBe(iso(25));
    expect(snapshot).not.toHaveProperty("researchId");
    expect(snapshot).not.toHaveProperty("orderCode");
    expect(snapshot).not.toHaveProperty("currentCondition");

    const summary = toPublicSnapshot(
      { ...active, phase: "summary", currentCondition: null },
      100,
      timing,
    );
    expect(summary.summary).toEqual([
      { position: 1, processing: "cloud", presentation: "label" },
      { position: 2, processing: "local", presentation: "label" },
      { position: 3, processing: "cloud", presentation: "puffer" },
      { position: 4, processing: "local", presentation: "puffer" },
    ]);
    expect(summary).not.toHaveProperty("formUrl");
    expect(toPublicSnapshot(
      { ...active, phase: "summary", currentCondition: null },
      25,
      timing,
      true,
      iso(25),
    )).not.toHaveProperty("formUrl");
    expect(toPublicSnapshot({ ...active, deviceMode: "serial" }, 25, timing).pufferSurface)
      .toBe("physical");
    expect(getRemainingMs(newSession(), 10)).toBeNull();
  });

  it("supports an explicit duration and rejects invalid clock/duration inputs", () => {
    const intro: Session = { ...newSession(), phase: "intro" };
    const handling = transitionSession(intro, "handling", context(5, { durationMs: 25 }));
    expect(handling.phaseEndsMonotonicMs).toBe(30);
    expect(() => transitionSession(intro, "handling", context(5, { durationMs: -1 })))
      .toThrow(RangeError);
    expect(() => transitionSession(intro, "handling", {
      wallClockIso: iso(1),
      monotonicMs: Number.NaN,
    })).toThrow(RangeError);
  });
});
