import { describe, expect, it } from "vitest";

import {
  assertExperimentLogEventFieldAllowlist,
  EXPERIMENT_LOG_EVENT_ALLOWED_FIELDS,
  findUnexpectedExperimentLogEventFields,
} from "../../../../src/server/logging/log-event-allowlist.js";

const EXPECTED_ALLOWED_FIELDS = [
  "schemaVersion",
  "protocolVersion",
  "appVersion",
  "configHash",
  "sessionId",
  "researchId",
  "orderCode",
  "sequenceIndex",
  "conditionCode",
  "processing",
  "presentation",
  "phase",
  "eventType",
  "wallClockIso",
  "monotonicMs",
  "fixedScore",
  "pufferLevel",
  "deviceMode",
  "deviceStatus",
  "result",
  "errorCode",
] as const;

describe("experiment log event field allowlist", () => {
  it("contains exactly the fields approved by the experiment specification", () => {
    expect(EXPERIMENT_LOG_EVENT_ALLOWED_FIELDS).toEqual(EXPECTED_ALLOWED_FIELDS);
    expect(Object.isFrozen(EXPERIMENT_LOG_EVENT_ALLOWED_FIELDS)).toBe(true);
  });

  it("accepts every approved field and reports no unexpected fields", () => {
    const allApprovedFields = Object.fromEntries(
      EXPERIMENT_LOG_EVENT_ALLOWED_FIELDS.map((field) => [field, undefined]),
    );

    const unexpected = findUnexpectedExperimentLogEventFields(allApprovedFields);
    expect(unexpected).toEqual([]);
    expect(Object.isFrozen(unexpected)).toBe(true);
    expect(() => assertExperimentLogEventFieldAllowlist(allApprovedFields)).not.toThrow();
  });

  it.each([
    "name",
    "email",
    "studentId",
    "ip",
    "ipAddress",
    "userAgent",
    "location",
    "formAnswers",
    "freeText",
    "biometricData",
  ])("rejects prohibited or sensitive field %s", (field) => {
    expect(() => assertExperimentLogEventFieldAllowlist({ [field]: "sensitive" }))
      .toThrow(`Experiment log event contains forbidden fields: ${field}.`);
  });

  it("reports every unexpected field in deterministic order", () => {
    expect(findUnexpectedExperimentLogEventFields({ zzz: true, schemaVersion: 1, aaa: true }))
      .toEqual(["aaa", "zzz"]);
  });

  it("rejects non-object values and arrays before field inspection", () => {
    expect(() => assertExperimentLogEventFieldAllowlist("not-an-object")).toThrow(TypeError);
    expect(() => assertExperimentLogEventFieldAllowlist(null)).toThrow(TypeError);
    expect(() => assertExperimentLogEventFieldAllowlist([])).toThrow(TypeError);
  });
});
