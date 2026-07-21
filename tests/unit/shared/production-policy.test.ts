import { describe, expect, it } from "vitest";

import { STUDY_FORM_URL } from "../../../src/shared/form-audit.js";
import {
  assessProductionPolicy,
  isWindowsComPath,
  SCREEN_PRODUCTION_FIXED_STATE,
  SCREEN_PRODUCTION_ORDERS,
  SCREEN_PRODUCTION_RESEARCH_ID_PATTERN,
  SCREEN_PRODUCTION_TIMING_MS,
  type ProductionProtocolPolicyIssueCode,
} from "../../../src/shared/production-policy.js";
import {
  SCREEN_PROTOCOL_VERSION,
  parseExperimentConfig,
  type ExperimentConfig,
} from "../../../src/shared/schemas.js";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const SERIAL_PROTOCOL_VERSION = "serial-policy-test-v1";

type PolicyMutation = (base: ExperimentConfig) => ExperimentConfig;

const SCREEN_PROTOCOL_MUTATIONS: readonly [
  string,
  PolicyMutation,
  ProductionProtocolPolicyIssueCode,
][] = [
  ["score", (base) => ({
    ...base,
    fixedState: { ...base.fixedState, score: 71 },
  } as ExperimentConfig), "screen-fixed-state-mismatch"],
  ["label", (base) => ({
    ...base,
    fixedState: { ...base.fixedState, label: "低ストレス" },
  } as ExperimentConfig), "screen-fixed-state-mismatch"],
  ["pufferLevel", (base) => ({
    ...base,
    fixedState: { ...base.fixedState, pufferLevel: 0.59 },
  } as ExperimentConfig), "screen-fixed-state-mismatch"],
  ...(["handling", "processing", "result", "reset", "inflateRamp", "deflateRamp"] as const)
    .map((field): [string, PolicyMutation, ProductionProtocolPolicyIssueCode] => [
      `timingMs.${field}`,
      (base) => ({
        ...base,
        timingMs: { ...base.timingMs, [field]: base.timingMs[field] + 1 },
      } as ExperimentConfig),
      "screen-timing-mismatch",
    ]),
  ["orders position", (base) => ({
    ...base,
    orders: ["BCAD", "ABDC", "CDBA", "DACB"],
  } as ExperimentConfig), "screen-orders-mismatch"],
  ["orders length", (base) => ({
    ...base,
    orders: base.orders.slice(0, 3),
  } as ExperimentConfig), "screen-orders-mismatch"],
  ["researchIdPattern", (base) => ({
    ...base,
    researchIdPattern: "^[A-Za-z0-9_-]+$",
  } as ExperimentConfig), "screen-research-id-pattern-mismatch"],
];

function productionConfig(mode: "mock" | "serial" | "screen"): ExperimentConfig {
  const protocolVersion = mode === "screen"
    ? SCREEN_PROTOCOL_VERSION
    : SERIAL_PROTOCOL_VERSION;
  return parseExperimentConfig({
    schemaVersion: 1,
    protocolVersion,
    studyTitle: "本番ポリシーテスト",
    bindHost: "127.0.0.1",
    port: 4173,
    researchIdPattern: mode === "screen"
      ? SCREEN_PRODUCTION_RESEARCH_ID_PATTERN
      : "^TEST-[0-9]{3}$",
    orders: ["ABDC", "BCAD", "CDBA", "DACB"],
    fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
    timingMs: {
      handling: 8_000,
      processing: 3_000,
      result: 15_000,
      reset: 7_000,
      inflateRamp: 6_000,
      deflateRamp: 6_000,
    },
    device: {
      mode,
      serialPath: mode === "serial" ? "COM3" : "",
      baudRate: 115_200,
      ackTimeout: 1_000,
      allowMockInProduction: false,
    },
    formUrl: STUDY_FORM_URL,
    formAudit: {
      status: "GO",
      protocolVersion,
      formUrl: STUDY_FORM_URL,
      auditedOn: "2026-07-21",
      contentSha256: "a".repeat(64),
      twoPersonVerified: true,
    },
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: { allowLan: false, allowExternalRuntimeRequests: false },
  });
}

describe("shared production policy", () => {
  it("accepts only the formal screen production mode", () => {
    expect(assessProductionPolicy(productionConfig("serial"), NOW)).toMatchObject({
      approved: false,
      deviceIssues: expect.arrayContaining([
        "serial-device-not-allowed",
        "production-protocol-version-not-screen",
      ]),
    });
    expect(assessProductionPolicy(productionConfig("screen"), NOW).approved).toBe(true);
    expect(assessProductionPolicy(productionConfig("mock"), NOW)).toMatchObject({
      approved: false,
      deviceIssues: expect.arrayContaining([
        "mock-device-not-allowed",
        "production-protocol-version-not-screen",
      ]),
    });
  });

  it("rejects Serial unconditionally and requires an empty screen Serial path", () => {
    const serial = productionConfig("serial");
    const screen = productionConfig("screen");
    const invalidSerial = {
      ...serial,
      device: { ...serial.device, serialPath: "COM0" },
    } as ExperimentConfig;
    const invalidScreen = {
      ...screen,
      device: { ...screen.device, serialPath: "COM3" },
    } as ExperimentConfig;
    expect(assessProductionPolicy(invalidSerial, NOW).deviceIssues)
      .toContain("serial-path-not-windows-com");
    expect(assessProductionPolicy(serial, NOW).deviceIssues)
      .toContain("serial-device-not-allowed");
    expect(assessProductionPolicy(invalidScreen, NOW).deviceIssues)
      .toContain("screen-serial-path-not-empty");
  });

  it("does not let an editable Mock permission bypass either production mode", () => {
    for (const mode of ["serial", "screen"] as const) {
      const base = productionConfig(mode);
      const invalid = {
        ...base,
        device: { ...base.device, allowMockInProduction: true },
      } as ExperimentConfig;
      expect(assessProductionPolicy(invalid, NOW).deviceIssues)
        .toContain("allow-mock-in-production-enabled");
    }
  });

  it("keeps the human form-audit evidence gate intact for screen production", () => {
    const base = productionConfig("screen");
    const notApproved = {
      ...base,
      formAudit: { ...base.formAudit!, status: "NO-GO", twoPersonVerified: false },
    } as ExperimentConfig;
    expect(assessProductionPolicy(notApproved, NOW)).toMatchObject({
      approved: false,
      formAudit: {
        approved: false,
        issues: expect.arrayContaining(["status-not-go", "two-person-not-verified"]),
      },
    });
  });

  it("defends the screen protocol/mode binding even for pre-parsed callers", () => {
    const screen = productionConfig("screen");
    const serial = productionConfig("serial");
    const oldProtocolScreen = {
      ...screen,
      protocolVersion: SERIAL_PROTOCOL_VERSION,
    } as ExperimentConfig;
    const screenProtocolSerial = {
      ...serial,
      protocolVersion: SCREEN_PROTOCOL_VERSION,
    } as ExperimentConfig;
    expect(assessProductionPolicy(oldProtocolScreen, NOW).deviceIssues)
      .toEqual(expect.arrayContaining([
        "screen-mode-protocol-mismatch",
        "production-protocol-version-not-screen",
      ]));
    expect(assessProductionPolicy(screenProtocolSerial, NOW).deviceIssues)
      .toContain("screen-protocol-mode-mismatch");
  });

  it("publishes the immutable formal screen-v1 parameter set", () => {
    expect(SCREEN_PRODUCTION_FIXED_STATE).toEqual({
      score: 72,
      label: "高ストレス",
      pufferLevel: 0.6,
    });
    expect(SCREEN_PRODUCTION_TIMING_MS).toEqual({
      handling: 8_000,
      processing: 3_000,
      result: 15_000,
      reset: 7_000,
      inflateRamp: 6_000,
      deflateRamp: 6_000,
    });
    expect(SCREEN_PRODUCTION_ORDERS).toEqual(["ABDC", "BCAD", "CDBA", "DACB"]);
    expect(SCREEN_PRODUCTION_RESEARCH_ID_PATTERN).toBe("^SH26-[0-9]{3}$");
    expect(Object.isFrozen(SCREEN_PRODUCTION_FIXED_STATE)).toBe(true);
    expect(Object.isFrozen(SCREEN_PRODUCTION_TIMING_MS)).toBe(true);
    expect(Object.isFrozen(SCREEN_PRODUCTION_ORDERS)).toBe(true);
  });

  it.each(SCREEN_PROTOCOL_MUTATIONS)(
    "rejects a modified formal screen-v1 %s",
    (_label, mutate, issueCode) => {
      const assessment = assessProductionPolicy(mutate(productionConfig("screen")), NOW);
      expect(assessment.approved).toBe(false);
      expect(assessment.protocolIssues).toContain(issueCode);
    },
  );

  it("does not provide an alternate production policy for a different Serial protocol", () => {
    const serial = productionConfig("serial");
    const modified = {
      ...serial,
      fixedState: { score: 1, label: "別の正式プロトコル", pufferLevel: 0.1 },
      timingMs: {
        handling: 1,
        processing: 1,
        result: 1,
        reset: 1,
        inflateRamp: 1,
        deflateRamp: 1,
      },
      orders: ["DACB", "CDBA", "BCAD", "ABDC"],
    } as ExperimentConfig;
    const assessment = assessProductionPolicy(modified, NOW);
    expect(assessment.approved).toBe(false);
    expect(assessment.deviceIssues).toEqual(expect.arrayContaining([
      "serial-device-not-allowed",
      "production-protocol-version-not-screen",
    ]));
    expect(assessment.protocolIssues).toEqual(expect.arrayContaining([
      "screen-fixed-state-mismatch",
      "screen-timing-mismatch",
      "screen-orders-mismatch",
      "screen-research-id-pattern-mismatch",
    ]));
  });

  it("recognizes only real Windows COM paths", () => {
    expect(isWindowsComPath("COM3")).toBe(true);
    expect(isWindowsComPath("\\\\.\\COM10")).toBe(true);
    expect(isWindowsComPath("COM0")).toBe(false);
    expect(isWindowsComPath("")).toBe(false);
  });
});
