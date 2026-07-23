import { describe, expect, it } from "vitest";
import {
  parseCreatedSession,
  parseDeviceAck,
  parseDeviceStatus,
  parseOperatorSnapshot,
  parseParticipantSnapshot,
  payloadFromSocketMessage,
} from "../../../src/client/shared/model.js";

const baseSession = {
  id: "session-1",
  researchId: "SH26-001",
  orderCode: "ABDC",
  phase: "result",
  sequenceIndex: 0,
  currentCondition: "A",
  fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
  pufferSurface: "physical",
  pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
  deviceMode: "mock",
  deviceStatus: "holding",
  deviceLevel: 0.6,
  displayConnected: true,
  phaseEndsAt: "2026-07-19T12:00:15.000Z",
  phaseStartedAt: "2026-07-19T12:00:00.000Z",
  serverNow: "2026-07-19T12:00:00.000Z",
  remainingMs: 15_000,
  displayUrl: "/display/display-token",
  protocolVersion: "protocol-v1",
  configHash: "config-hash",
};

describe("client boundary parsers", () => {
  it("normalises the server operator snapshot and derives the fixed condition mapping", () => {
    expect(parseOperatorSnapshot(baseSession)).toMatchObject({
      sessionId: "session-1",
      researchId: "SH26-001",
      orderCode: "ABDC",
      conditionCode: "A",
      condition: { processing: "cloud", presentation: "label" },
      device: { mode: "mock", state: "holding", level: 0.6, connected: true },
      protocolVersion: "protocol-v1",
      configVersion: "config-hash",
    });
  });

  it("accepts the create-session snapshot envelope", () => {
    expect(parseCreatedSession({
      snapshot: baseSession,
      displayToken: "display-token",
      displayUrl: "/display/display-token",
    })).toMatchObject({
      displayToken: "display-token",
      displayUrl: "/display/display-token",
      session: { sessionId: "session-1" },
    });
  });

  it("rejects malformed device states while preserving a neutral unknown state", () => {
    expect(parseDeviceStatus({ mode: "unexpected", state: "overdrive", level: "high" })).toEqual({
      mode: "unknown",
      state: "unknown",
      level: null,
      fault: null,
      connected: false,
    });
    expect(parseDeviceStatus({ mode: "screen", state: "idle", level: 0 })).toEqual({
      mode: "screen",
      state: "idle",
      level: 0,
      fault: null,
      connected: true,
    });
    expect(parseDeviceStatus(null)).toBeNull();
  });

  it("accepts a complete device ACK and rejects contradictory shapes", () => {
    expect(parseDeviceAck({
      requestId: "request-1",
      ok: true,
      state: "inflating",
      level: 0.6,
      errorCode: null,
    })).toEqual({
      requestId: "request-1",
      ok: true,
      state: "inflating",
      level: 0.6,
      errorCode: null,
    });
    expect(parseDeviceAck({ requestId: "request-2", ok: true, state: "overdrive", level: 0.6 }))
      .toBeNull();
    expect(parseDeviceAck({ requestId: "request-3", ok: true, state: "idle" })).toBeNull();
  });

  it("accepts only structured WebSocket messages", () => {
    expect(payloadFromSocketMessage({ type: "session.snapshot", payload: { phase: "intro" } })).toEqual({
      type: "session.snapshot",
      payload: { phase: "intro" },
    });
    expect(payloadFromSocketMessage({ payload: {} })).toBeNull();
    expect(payloadFromSocketMessage("session.snapshot")).toBeNull();
  });

  it("strictly validates the participant puffer presentation fields", () => {
    const valid = {
      phase: "result",
      pufferSurface: "screen",
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
      phaseStartedAt: null,
      phaseEndsAt: null,
      serverNow: null,
      remainingMs: null,
    };
    expect(parseParticipantSnapshot(valid)).toMatchObject({
      pufferSurface: "screen",
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
    });
    for (const malformed of [
      { ...valid, pufferSurface: "device" },
      { ...valid, pufferSurface: undefined },
      { ...valid, pufferRamp: null },
      { ...valid, pufferRamp: { inflateMs: 0, deflateMs: 6000 } },
      { ...valid, pufferRamp: { inflateMs: 6000, deflateMs: 6000.5 } },
      { ...valid, pufferRamp: { inflateMs: "6000", deflateMs: 6000 } },
      { ...valid, phaseStartedAt: "not-an-instant" },
      { ...valid, phaseEndsAt: 1234 },
      { ...valid, serverNow: undefined },
      { ...valid, remainingMs: undefined },
      { ...valid, remainingMs: -1 },
    ]) {
      expect(parseParticipantSnapshot(malformed)).toBeNull();
    }
  });
});
