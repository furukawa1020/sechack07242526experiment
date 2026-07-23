import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  hashExperimentConfig,
  hashProductionCriticalConfig,
  hashProductionGoEvidence,
} from "../../../src/shared/config-loader.js";
import {
  FORMAL_SCREEN_PROTOCOL_VERSION,
  hashFormalProductionConfig,
  hashFormalProductionCriticalConfig,
  hashFormalProductionGoEvidence,
  loadFormalProductionConfig,
  parseFormalProductionConfig,
} from "../../../src/shared/formal-production-config.js";
import { parseExperimentConfig } from "../../../src/shared/schemas.js";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function formalSource(): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    protocolVersion: FORMAL_SCREEN_PROTOCOL_VERSION,
    studyTitle: "身体状態の提示実験",
    bindHost: "127.0.0.1",
    port: 4173,
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
  };
  const criticalConfigSha256 = hashProductionCriticalConfig(parseExperimentConfig(base));
  const approval = (documentId: string, seed: string) => ({
    status: "GO",
    protocolVersion: FORMAL_SCREEN_PROTOCOL_VERSION,
    documentId,
    documentVersion: "1.0",
    contentSha256: digest(seed),
    approvedOn: "2026-07-22",
    applicableUntil: "2026-07-24",
  });
  const sourceTreeSha256 = digest("source-tree");
  return {
    ...base,
    goEvidence: {
      status: "GO",
      protocolVersion: FORMAL_SCREEN_PROTOCOL_VERSION,
      criticalConfigSha256,
      researchPlan: approval("PLAN-001", "plan"),
      ethicsDetermination: approval("ETHICS-001", "ethics"),
      preStimulusConsent: approval("CONSENT-001", "consent"),
      dataManagementPlan: approval("DATA-PLAN-001", "data-plan"),
      screenPilot: {
        ...approval("SCREEN-PILOT-001", "pilot"),
        completedSessions: 3,
        sourceTreeSha256,
        pilotConfigFileHash: digest("pilot-config"),
      },
      releaseVerification: {
        status: "GO",
        protocolVersion: FORMAL_SCREEN_PROTOCOL_VERSION,
        appVersion: "1.1.0",
        criticalConfigSha256,
        sourceTreeSha256,
        reviews: [
          {
            reviewId: "RELEASE-REVIEW-001",
            reviewerCode: "REV-0001",
            reviewVersion: "1.0",
            status: "GO",
            protocolVersion: FORMAL_SCREEN_PROTOCOL_VERSION,
            criticalConfigSha256,
            reviewedOn: "2026-07-22",
            applicableUntil: "2026-07-24",
            attestationSha256: digest("review-one"),
          },
          {
            reviewId: "RELEASE-REVIEW-002",
            reviewerCode: "REV-0002",
            reviewVersion: "1.0",
            status: "GO",
            protocolVersion: FORMAL_SCREEN_PROTOCOL_VERSION,
            criticalConfigSha256,
            reviewedOn: "2026-07-22",
            applicableUntil: "2026-07-24",
            attestationSha256: digest("review-two"),
          },
        ],
      },
    },
  };
}

describe("formal production config boundary", () => {
  it("keeps semantic and evidence hashes identical to the shared config contract", () => {
    const formal = parseFormalProductionConfig(formalSource());
    const shared = parseExperimentConfig(formalSource());
    expect(formal).toEqual(shared);
    expect(hashFormalProductionConfig(formal)).toBe(hashExperimentConfig(shared));
    expect(hashFormalProductionCriticalConfig(formal)).toBe(
      hashProductionCriticalConfig(shared),
    );
    expect(hashFormalProductionGoEvidence(formal)).toBe(hashProductionGoEvidence(shared));
  });

  it("strictly rejects non-formal modes and every legacy questionnaire integration field", () => {
    const source = formalSource();
    expect(() => parseFormalProductionConfig({ ...source, formUrl: "https://example.invalid" }))
      .toThrow();
    expect(() => parseFormalProductionConfig({ ...source, formAudit: {} })).toThrow();
    expect(() => parseFormalProductionConfig({
      ...source,
      device: { ...(source["device"] as Record<string, unknown>), mode: "mock" },
    })).toThrow();
  });

  it("loads only a current, fully bound formal config snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-formal-config-"));
    await mkdir(join(root, "config"));
    await writeFile(
      join(root, "config", "experiment.json"),
      JSON.stringify(formalSource()),
      "utf8",
    );
    await expect(loadFormalProductionConfig("config/experiment.json", {
      rootDirectory: root,
      currentDate: new Date("2026-07-23T03:00:00.000Z"),
    })).resolves.toMatchObject({
      config: { protocolVersion: FORMAL_SCREEN_PROTOCOL_VERSION, device: { mode: "screen" } },
      configHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });
});
