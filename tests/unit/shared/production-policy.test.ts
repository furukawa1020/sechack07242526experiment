import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashProductionCriticalConfig } from "../../../src/shared/config-loader.js";
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

function fixtureDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

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
  const source = {
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
    formUrl: "",
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: { allowLan: false, allowExternalRuntimeRequests: false },
  };
  const criticalConfigSha256 = hashProductionCriticalConfig(parseExperimentConfig(source));
  const approval = (documentId: string, contentSha256: string) => ({
    status: "GO" as const,
    protocolVersion,
    documentId,
    documentVersion: "1.0",
    contentSha256,
    approvedOn: "2026-07-20",
    applicableUntil: "2026-07-22",
  });
  return parseExperimentConfig({
    ...source,
    goEvidence: {
      status: "GO",
      protocolVersion,
      criticalConfigSha256,
      researchPlan: approval("PLAN-001", fixtureDigest("research-plan")),
      ethicsDetermination: approval("ETHICS-001", fixtureDigest("ethics")),
      preStimulusConsent: approval("CONSENT-001", fixtureDigest("consent")),
      dataManagementPlan: approval("DATA-PLAN-001", fixtureDigest("data-plan")),
      screenPilot: {
        ...approval("SCREEN-PILOT-001", fixtureDigest("screen-pilot")),
        completedSessions: 3,
        sourceTreeSha256: fixtureDigest("source-tree"),
        pilotConfigFileHash: fixtureDigest("pilot-config"),
      },
      releaseVerification: {
        status: "GO",
        protocolVersion,
        appVersion: "1.0.0",
        criticalConfigSha256,
        sourceTreeSha256: fixtureDigest("source-tree"),
        reviews: [
          {
            reviewId: "RELEASE-REVIEW-001",
            reviewerCode: "REV-0001",
            reviewVersion: "1.0",
            status: "GO",
            protocolVersion,
            criticalConfigSha256,
            reviewedOn: "2026-07-20",
            applicableUntil: "2026-07-22",
            attestationSha256: fixtureDigest("release-attestation-1"),
          },
          {
            reviewId: "RELEASE-REVIEW-002",
            reviewerCode: "REV-0002",
            reviewVersion: "1.0",
            status: "GO",
            protocolVersion,
            criticalConfigSha256,
            reviewedOn: "2026-07-20",
            applicableUntil: "2026-07-22",
            attestationSha256: fixtureDigest("release-attestation-2"),
          },
        ],
      },
    },
  });
}

function assess(config: ExperimentConfig, now = NOW) {
  return assessProductionPolicy(config, now, {
    criticalConfigSha256: hashProductionCriticalConfig(config),
  });
}

describe("shared production policy", () => {
  it("accepts only the formal screen production mode", () => {
    expect(assess(productionConfig("serial"))).toMatchObject({
      approved: false,
      deviceIssues: expect.arrayContaining([
        "serial-device-not-allowed",
        "production-protocol-version-not-screen",
      ]),
    });
    expect(assess(productionConfig("screen")).approved).toBe(true);
    expect(assess(productionConfig("mock"))).toMatchObject({
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
    expect(assess(invalidSerial).deviceIssues)
      .toContain("serial-path-not-windows-com");
    expect(assess(serial).deviceIssues)
      .toContain("serial-device-not-allowed");
    expect(assess(invalidScreen).deviceIssues)
      .toContain("screen-serial-path-not-empty");
  });

  it("does not let an editable Mock permission bypass either production mode", () => {
    for (const mode of ["serial", "screen"] as const) {
      const base = productionConfig(mode);
      const invalid = {
        ...base,
        device: { ...base.device, allowMockInProduction: true },
      } as ExperimentConfig;
      expect(assess(invalid).deviceIssues)
        .toContain("allow-mock-in-production-enabled");
    }
  });

  it("rejects every legacy in-app Google Form integration in screen production", () => {
    const base = productionConfig("screen");
    const withUrl = {
      ...base,
      formUrl: "https://forms.gle/legacy-form",
    } as ExperimentConfig;
    const withAudit = {
      ...base,
      formAudit: {
        status: "NO-GO",
        protocolVersion: base.protocolVersion,
        formUrl: "",
        auditedOn: "2026-07-21",
        contentSha256: fixtureDigest("legacy-form-audit"),
        twoPersonVerified: false,
      },
    } as ExperimentConfig;
    expect(assess(withUrl)).toMatchObject({
      approved: false,
      formIssues: ["production-form-url-not-empty"],
    });
    expect(assess(withAudit)).toMatchObject({
      approved: false,
      formIssues: ["production-form-audit-present"],
    });
  });

  it("does not let a form-audit boolean become formal GO without all approvals", () => {
    const base = productionConfig("screen");
    const withoutEvidence = { ...base, goEvidence: undefined } as ExperimentConfig;
    const assessment = assessProductionPolicy(withoutEvidence, NOW, {
      criticalConfigSha256: hashProductionCriticalConfig(withoutEvidence),
    });
    expect(assessment.formIssues).toEqual([]);
    expect(assessment.goEvidence).toMatchObject({ approved: false, issues: ["missing"] });
    expect(assessment.approved).toBe(false);
  });

  it("rejects stale, protocol-mismatched, duplicate and config-mismatched GO evidence", () => {
    const base = productionConfig("screen");
    const evidence = base.goEvidence!;
    const reviews = evidence.releaseVerification.reviews;
    const invalid = {
      ...base,
      goEvidence: {
        ...evidence,
        protocolVersion: "other-protocol",
        criticalConfigSha256: "9".repeat(64),
        researchPlan: {
          ...evidence.researchPlan,
          applicableUntil: "2026-07-19",
        },
        releaseVerification: {
          ...evidence.releaseVerification,
          reviews: [
            reviews[0],
            {
              ...reviews[1],
              reviewId: reviews[0].reviewId,
              reviewerCode: reviews[0].reviewerCode,
            },
          ],
        },
      },
    } as ExperimentConfig;
    const assessment = assess(invalid);
    expect(assessment.goEvidence.approved).toBe(false);
    expect(assessment.goEvidence.issues).toEqual(expect.arrayContaining([
      "protocol-version-mismatch",
      "critical-config-sha256-mismatch",
      "researchPlan:applicability-expired-2-days",
      "releaseVerification:duplicate-review-id",
      "releaseVerification:duplicate-reviewer-code",
    ]));
  });

  it("never accepts placeholder identifiers after statuses and SHA values are flipped to GO", () => {
    const base = productionConfig("screen");
    const evidence = base.goEvidence!;
    const reviews = evidence.releaseVerification.reviews;
    const invalid = {
      ...base,
      goEvidence: {
        ...evidence,
        researchPlan: {
          ...evidence.researchPlan,
          documentId: "PENDING-RESEARCH-PLAN",
          documentVersion: "PENDING",
        },
        releaseVerification: {
          ...evidence.releaseVerification,
          reviews: [
            {
              ...reviews[0],
              reviewId: "PENDING-RELEASE-REVIEW-1",
              reviewerCode: "REV-PENDING01",
              reviewVersion: "PENDING",
            },
            reviews[1],
          ],
        },
      },
    } as ExperimentConfig;
    expect(assess(invalid).goEvidence.issues).toEqual(expect.arrayContaining([
      "researchPlan:document-id-pending",
      "researchPlan:document-version-pending",
      "releaseVerification.reviews.0:review-id-pending",
      "releaseVerification.reviews.0:reviewer-code-pending",
      "releaseVerification.reviews.0:review-version-pending",
    ]));
  });

  it("rejects broader placeholder vocabulary and synthetic repeated digests", () => {
    const base = productionConfig("screen");
    const evidence = base.goEvidence!;
    const invalid = {
      ...base,
      goEvidence: {
        ...evidence,
        screenPilot: {
          ...evidence.screenPilot,
          sourceTreeSha256: fixtureDigest("different-pilot-source"),
          pilotConfigFileHash: "a".repeat(64),
        },
        researchPlan: {
          ...evidence.researchPlan,
          documentId: "TODO-RESEARCH-PLAN",
          documentVersion: "EXAMPLE",
          contentSha256: "a".repeat(64),
        },
        releaseVerification: {
          ...evidence.releaseVerification,
          appVersion: "PLACEHOLDER",
          sourceTreeSha256: "deadbeef".repeat(8),
        },
      },
    } as ExperimentConfig;
    expect(assess(invalid).goEvidence.issues).toEqual(expect.arrayContaining([
      "researchPlan:document-id-placeholder",
      "researchPlan:document-version-placeholder",
      "researchPlan:content-sha256-unapproved",
      "screenPilot:pilot-config-file-hash-unapproved",
      "screenPilot:source-tree-sha256-mismatch",
      "releaseVerification:app-version-placeholder",
      "releaseVerification:source-tree-sha256-unapproved",
    ]));
  });

  it("requires the approved pilot source tree to equal the release candidate tree", () => {
    const base = productionConfig("screen");
    const evidence = base.goEvidence!;
    const invalid = {
      ...base,
      goEvidence: {
        ...evidence,
        screenPilot: {
          ...evidence.screenPilot,
          sourceTreeSha256: fixtureDigest("different-pilot-source"),
        },
      },
    } as ExperimentConfig;
    expect(assess(invalid).goEvidence.issues).toContain(
      "screenPilot:source-tree-sha256-mismatch",
    );
  });

  it("requires fresh, version-matched and distinct independent release attestations", () => {
    const base = productionConfig("screen");
    const evidence = base.goEvidence!;
    const [first, second] = evidence.releaseVerification.reviews;
    const invalid = {
      ...base,
      goEvidence: {
        ...evidence,
        releaseVerification: {
          ...evidence.releaseVerification,
          reviews: [
            { ...first, reviewedOn: "2026-06-20" },
            {
              ...second,
              reviewVersion: "2.0",
              attestationSha256: first.attestationSha256,
            },
          ],
        },
      },
    } as ExperimentConfig;
    expect(assess(invalid).goEvidence.issues).toEqual(expect.arrayContaining([
      "releaseVerification.reviews.0:review-stale-31-days",
      "releaseVerification:review-version-mismatch",
      "releaseVerification:duplicate-attestation-sha256",
    ]));
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
    expect(assess(oldProtocolScreen).deviceIssues)
      .toEqual(expect.arrayContaining([
        "screen-mode-protocol-mismatch",
        "production-protocol-version-not-screen",
      ]));
    expect(assess(screenProtocolSerial).deviceIssues)
      .toContain("screen-protocol-mode-mismatch");
  });

  it("publishes the immutable formal screen-v2 parameter set", () => {
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
    "rejects a modified formal screen-v2 %s",
    (_label, mutate, issueCode) => {
      const assessment = assess(mutate(productionConfig("screen")));
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
    const assessment = assess(modified);
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
