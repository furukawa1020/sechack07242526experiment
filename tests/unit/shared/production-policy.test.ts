import { describe, expect, it } from "vitest";

import {
  assessProductionPolicy,
  isWindowsComPath,
  SCREEN_PRODUCTION_BIND_HOST,
  SCREEN_PRODUCTION_FIXED_STATE,
  SCREEN_PRODUCTION_ORDERS,
  SCREEN_PRODUCTION_PORT,
  SCREEN_PRODUCTION_RESEARCH_ID_PATTERN,
  SCREEN_PRODUCTION_TIMING_MS,
  type ProductionNetworkPolicyIssueCode,
  type ProductionProtocolPolicyIssueCode,
} from "../../../src/shared/production-policy.js";
import {
  parseExperimentConfig,
  SCREEN_PROTOCOL_VERSION,
  type ExperimentConfig,
} from "../../../src/shared/schemas.js";

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
  ["orders", (base) => ({
    ...base,
    orders: ["BCAD", "ABDC", "CDBA", "DACB"],
  } as ExperimentConfig), "screen-orders-mismatch"],
  ["researchIdPattern", (base) => ({
    ...base,
    researchIdPattern: "^OTHER-[0-9]{3}$",
  } as ExperimentConfig), "screen-research-id-pattern-mismatch"],
];

const PRODUCTION_NETWORK_MUTATIONS: readonly [
  string,
  PolicyMutation,
  ProductionNetworkPolicyIssueCode,
][] = [
  ["bindHost", (base) => ({ ...base, bindHost: "localhost" } as ExperimentConfig),
    "production-bind-host-not-127-0-0-1"],
  ["port", (base) => ({ ...base, port: 4_174 } as ExperimentConfig),
    "production-port-not-4173"],
  ["allowLan", (base) => ({
    ...base,
    network: { ...base.network, allowLan: true },
  } as ExperimentConfig), "production-lan-access-enabled"],
  ["external requests", (base) => ({
    ...base,
    network: { ...base.network, allowExternalRuntimeRequests: true },
  } as ExperimentConfig), "production-external-runtime-requests-enabled"],
];

function productionConfig(): ExperimentConfig {
  return parseExperimentConfig({
    schemaVersion: 1,
    protocolVersion: SCREEN_PROTOCOL_VERSION,
    environment: "production",
    participantMode: "enabled",
    compliance: {
      mode: "external",
      evidenceStorage: "outside-system",
      verifiedByApplication: false,
      requireApprovalDocument: false,
      requireApprovalHash: false,
      requireSecondVerifier: false,
      requireReviewerIdentity: false,
      requireScreenPilotForRelease: false,
      requireManualGoTicket: false,
    },
    runtime: {
      requireOperatorSessionConfirmation: true,
      persistOperatorConfirmation: false,
      requireConsentConfirmation: true,
      requireEmergencyStopCheck: true,
    },
    privacy: {
      storeOperatorIdentity: false,
      storeApprovalEvidence: false,
      storeApprovalHash: false,
      storeIpAddress: false,
      analyticsEnabled: false,
      telemetryEnabled: false,
    },
    studyTitle: "本番ポリシーテスト",
    bindHost: "127.0.0.1",
    port: 4_173,
    researchIdPattern: "^SH26-[0-9]{3}$",
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
      mode: "screen",
      serialPath: "",
      baudRate: 115_200,
      ackTimeout: 1_000,
      allowMockInProduction: false,
    },
    formUrl: "",
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: { allowLan: false, allowExternalRuntimeRequests: false },
  });
}

describe("shared production policy", () => {
  it("reports technical GO separately from externally managed approval evidence", () => {
    expect(assessProductionPolicy(productionConfig())).toMatchObject({
      technicalReadiness: "GO",
      participantMode: "enabled",
      complianceMode: "external",
      approvalEvidence: "managed-outside-system",
      approvalVerifiedByApplication: false,
      deviceIssues: [],
      protocolIssues: [],
      formIssues: [],
      networkIssues: [],
      complianceIssues: [],
    });
  });

  it("does not turn legacy PENDING approval state into a production hard gate", () => {
    const config = {
      ...productionConfig(),
      goEvidence: {
        status: "NO-GO",
        protocolVersion: SCREEN_PROTOCOL_VERSION,
      },
    } as unknown as ExperimentConfig;
    expect(assessProductionPolicy(config)).toMatchObject({
      technicalReadiness: "GO",
      approvalEvidence: "managed-outside-system",
      approvalVerifiedByApplication: false,
      complianceIssues: [],
    });
  });

  it("requires external compliance, ephemeral Operator confirmation and privacy-off values", () => {
    const base = productionConfig();
    const invalid = {
      ...base,
      participantMode: "disabled",
      runtime: {
        ...base.runtime,
        requireOperatorSessionConfirmation: false,
        persistOperatorConfirmation: true,
        requireConsentConfirmation: false,
        requireEmergencyStopCheck: false,
      },
      privacy: {
        ...base.privacy,
        storeOperatorIdentity: true,
        storeApprovalEvidence: true,
        storeApprovalHash: true,
        storeIpAddress: true,
        analyticsEnabled: true,
        telemetryEnabled: true,
      },
    } as unknown as ExperimentConfig;
    const assessment = assessProductionPolicy(invalid);
    expect(assessment.technicalReadiness).toBe("NO-GO");
    expect(assessment.complianceIssues).toEqual(expect.arrayContaining([
      "production-participant-mode-not-enabled",
      "production-operator-confirmation-not-required",
      "production-operator-confirmation-persisted",
      "production-consent-confirmation-not-required",
      "production-emergency-stop-check-not-required",
      "production-operator-identity-storage-enabled",
      "production-approval-evidence-storage-enabled",
      "production-approval-hash-storage-enabled",
      "production-ip-storage-enabled",
      "production-analytics-enabled",
      "production-telemetry-enabled",
    ]));
  });

  it("rejects physical and Mock devices for the formal screen protocol", () => {
    for (const mode of ["mock", "serial"] as const) {
      const base = productionConfig();
      const invalid = {
        ...base,
        device: {
          ...base.device,
          mode,
          serialPath: mode === "serial" ? "COM3" : "",
        },
      } as ExperimentConfig;
      expect(assessProductionPolicy(invalid).technicalReadiness).toBe("NO-GO");
    }
  });

  it("rejects form integration while leaving the external staff workflow outside runtime", () => {
    const base = productionConfig();
    expect(assessProductionPolicy({
      ...base,
      formUrl: "https://forms.gle/legacy",
    }).formIssues).toContain("production-form-url-not-empty");
    expect(assessProductionPolicy({
      ...base,
      formAudit: {
        status: "NO-GO",
        protocolVersion: SCREEN_PROTOCOL_VERSION,
        formUrl: "",
        auditedOn: "2026-07-21",
        contentSha256: "0".repeat(64),
        twoPersonVerified: false,
      },
    }).formIssues).toContain("production-form-audit-present");
  });

  it.each(SCREEN_PROTOCOL_MUTATIONS)(
    "rejects a modified formal screen-v3 %s",
    (_label, mutate, issueCode) => {
      const assessment = assessProductionPolicy(mutate(productionConfig()));
      expect(assessment.technicalReadiness).toBe("NO-GO");
      expect(assessment.protocolIssues).toContain(issueCode);
    },
  );

  it.each(PRODUCTION_NETWORK_MUTATIONS)(
    "rejects a modified formal production %s boundary",
    (_label, mutate, issueCode) => {
      const assessment = assessProductionPolicy(mutate(productionConfig()));
      expect(assessment.technicalReadiness).toBe("NO-GO");
      expect(assessment.networkIssues).toContain(issueCode);
    },
  );

  it("publishes the immutable formal screen-v3 parameter set", () => {
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
    expect(SCREEN_PRODUCTION_BIND_HOST).toBe("127.0.0.1");
    expect(SCREEN_PRODUCTION_PORT).toBe(4_173);
  });

  it("recognizes only real Windows COM paths", () => {
    expect(isWindowsComPath("COM3")).toBe(true);
    expect(isWindowsComPath("\\\\.\\COM10")).toBe(true);
    expect(isWindowsComPath("COM0")).toBe(false);
    expect(isWindowsComPath("")).toBe(false);
  });
});
