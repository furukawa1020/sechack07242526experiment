import { describe, expect, it } from "vitest";
import {
  parseCreatedSession,
  parseDeviceStatus,
  parseOperatorSnapshot,
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
  deviceMode: "mock",
  deviceStatus: "holding",
  deviceLevel: 0.6,
  displayConnected: true,
  phaseEndsAt: "2026-07-19T12:00:15.000Z",
  serverNow: "2026-07-19T12:00:00.000Z",
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
    expect(parseDeviceStatus(null)).toBeNull();
  });

  it("accepts only structured WebSocket messages", () => {
    expect(payloadFromSocketMessage({ type: "session.snapshot", payload: { phase: "intro" } })).toEqual({
      type: "session.snapshot",
      payload: { phase: "intro" },
    });
    expect(payloadFromSocketMessage({ payload: {} })).toBeNull();
    expect(payloadFromSocketMessage("session.snapshot")).toBeNull();
  });
});
