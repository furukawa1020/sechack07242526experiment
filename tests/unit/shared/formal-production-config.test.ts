import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
  formatFormalProductionConfigError,
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

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} is not an object.`);
  }
  return value as Record<string, unknown>;
}

async function writeFormalSource(
  source: Record<string, unknown>,
): Promise<{ readonly configPath: string; readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), "sechack-formal-config-"));
  const configDirectory = join(root, "config");
  const configPath = join(configDirectory, "experiment.json");
  await mkdir(configDirectory);
  await writeFile(configPath, JSON.stringify(source), "utf8");
  return { configPath, root };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the operation to reject.");
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

  it("formats schema, root-level, Error, and unknown failures without leaking mutable arrays", () => {
    const invalidTitle = formalSource();
    invalidTitle["studyTitle"] = "";
    let fieldError: unknown;
    try {
      parseFormalProductionConfig(invalidTitle);
    } catch (error) {
      fieldError = error;
    }
    const fieldMessages = formatFormalProductionConfigError(fieldError);
    expect(fieldMessages).toEqual([
      expect.stringContaining("studyTitle:"),
    ]);
    expect(Object.isFrozen(fieldMessages)).toBe(true);

    let rootError: unknown;
    try {
      parseFormalProductionConfig(null);
    } catch (error) {
      rootError = error;
    }
    expect(formatFormalProductionConfigError(rootError)[0]).toMatch(/^config:/u);
    expect(formatFormalProductionConfigError(new Error("read failed"))).toEqual([
      "read failed",
    ]);
    expect(formatFormalProductionConfigError("not-an-error")).toEqual([
      "Unknown configuration error.",
    ]);
  });

  it("reports every fail-closed GO evidence class with parse-valid opaque metadata", async () => {
    const source = formalSource();
    const evidence = recordAt(source, "goEvidence");
    const wrongDigest = digest("wrong-critical-config");
    const repeatedDigest = "ab".repeat(32);
    evidence["status"] = "NO-GO";
    evidence["protocolVersion"] = "OTHER-PROTOCOL";
    evidence["criticalConfigSha256"] = wrongDigest;

    const approvalKeys = [
      "researchPlan",
      "ethicsDetermination",
      "preStimulusConsent",
      "dataManagementPlan",
      "screenPilot",
    ] as const;
    approvalKeys.forEach((key, index) => {
      const approval = recordAt(evidence, key);
      const pending = index % 2 === 0;
      approval["status"] = "NO-GO";
      approval["protocolVersion"] = "OTHER-PROTOCOL";
      approval["contentSha256"] = pending ? "0".repeat(64) : repeatedDigest;
      approval["documentId"] = pending
        ? `DOCUMENT-PENDING-${String(index)}`
        : `DOCUMENT-EXAMPLE-${String(index)}`;
      approval["documentVersion"] = pending ? "PENDING" : "EXAMPLE";
    });

    const researchPlan = recordAt(evidence, "researchPlan");
    researchPlan["approvedOn"] = null;
    researchPlan["applicableUntil"] = null;
    const ethicsDetermination = recordAt(evidence, "ethicsDetermination");
    ethicsDetermination["approvedOn"] = "2026-07-24";
    ethicsDetermination["applicableUntil"] = "2026-07-25";
    const preStimulusConsent = recordAt(evidence, "preStimulusConsent");
    preStimulusConsent["approvedOn"] = "2026-07-22";
    preStimulusConsent["applicableUntil"] = "2026-07-21";
    const dataManagementPlan = recordAt(evidence, "dataManagementPlan");
    dataManagementPlan["approvedOn"] = "2026-01-01";
    dataManagementPlan["applicableUntil"] = "2026-01-02";

    const screenPilot = recordAt(evidence, "screenPilot");
    screenPilot["completedSessions"] = null;
    screenPilot["sourceTreeSha256"] = repeatedDigest;
    screenPilot["pilotConfigFileHash"] = "0".repeat(64);

    const releaseVerification = recordAt(evidence, "releaseVerification");
    releaseVerification["status"] = "NO-GO";
    releaseVerification["protocolVersion"] = "OTHER-PROTOCOL";
    releaseVerification["appVersion"] = "PLACEHOLDER";
    releaseVerification["criticalConfigSha256"] = wrongDigest;
    releaseVerification["sourceTreeSha256"] = "0".repeat(64);
    const reviewsValue = releaseVerification["reviews"];
    if (!Array.isArray(reviewsValue) || reviewsValue.length !== 2) {
      throw new Error("releaseVerification.reviews must contain two records.");
    }
    reviewsValue.forEach((value, index) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("release review is not an object.");
      }
      const review = value as Record<string, unknown>;
      review["reviewId"] = "RELEASE-PENDING-001";
      review["reviewerCode"] = "REV-PENDING";
      review["reviewVersion"] = index === 0 ? "PENDING" : "EXAMPLE";
      review["status"] = "NO-GO";
      review["protocolVersion"] = "OTHER-PROTOCOL";
      review["criticalConfigSha256"] = wrongDigest;
      review["reviewedOn"] = "2026-01-01";
      review["applicableUntil"] = "2026-01-02";
      review["attestationSha256"] = "0".repeat(64);
    });

    const parsed = parseFormalProductionConfig(source);
    expect(hashFormalProductionGoEvidence(parsed)).toMatch(/^[a-f0-9]{64}$/u);
    const { root } = await writeFormalSource(source);
    const message = await rejectionMessage(loadFormalProductionConfig(undefined, {
      rootDirectory: root,
      currentDate: new Date("2026-07-23T03:00:00.000Z"),
    }));
    for (const issue of [
      "status-not-go",
      "protocol-version-mismatch",
      "critical-config-sha256-mismatch",
      "content-sha256-unapproved",
      "document-id-pending",
      "document-id-placeholder",
      "document-version-pending",
      "document-version-placeholder",
      "approval-date-missing",
      "applicability-deadline-missing",
      "approval-date-in-future",
      "invalid-applicability-range",
      "applicability-expired-",
      "screenPilot:completed-sessions-missing",
      "screenPilot:source-tree-sha256-unapproved",
      "screenPilot:pilot-config-file-hash-unapproved",
      "releaseVerification:app-version-placeholder",
      "releaseVerification:source-tree-sha256-unapproved",
      "screenPilot:source-tree-sha256-mismatch",
      "attestation-sha256-unapproved",
      "review-id-pending",
      "review-version-placeholder",
      "review-stale-",
      "duplicate-review-id",
      "duplicate-reviewer-code",
      "review-version-mismatch",
      "duplicate-attestation-sha256",
    ]) {
      expect(message).toContain(issue);
    }
  });

  it("rejects an invalid wall clock instead of treating dated evidence as current", async () => {
    const { root } = await writeFormalSource(formalSource());
    await expect(loadFormalProductionConfig(undefined, {
      rootDirectory: root,
      currentDate: new Date(Number.NaN),
    })).rejects.toThrow("clock:calendar-date-invalid");
  });

  it("enforces lexical, symbolic-link, and resolved-path config boundaries", async () => {
    const { configPath, root } = await writeFormalSource(formalSource());
    await expect(loadFormalProductionConfig("../outside.json", {
      rootDirectory: root,
    })).rejects.toThrow("inside the allowed config directory");

    await expect(loadFormalProductionConfig(configPath, {
      allowedDirectory: configPath,
      currentDate: new Date("2026-07-23T03:00:00.000Z"),
    })).resolves.toMatchObject({ path: configPath });

    const outsideDirectory = join(root, "outside");
    await mkdir(outsideDirectory);
    await writeFile(
      join(outsideDirectory, "experiment.json"),
      JSON.stringify(formalSource()),
      "utf8",
    );
    await symlink(outsideDirectory, join(root, "config", "direct-link"), "junction");
    await expect(loadFormalProductionConfig("config/direct-link", {
      rootDirectory: root,
    })).rejects.toThrow("must not be a symbolic link or junction");

    await symlink(outsideDirectory, join(root, "config", "nested-link"), "junction");
    await expect(loadFormalProductionConfig("config/nested-link/experiment.json", {
      rootDirectory: root,
    })).rejects.toThrow("resolved outside the allowed config directory");
  });

  it("wraps malformed JSON with a stable production configuration error", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-formal-invalid-json-"));
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "experiment.json"), "{", "utf8");
    await expect(loadFormalProductionConfig(undefined, {
      rootDirectory: root,
    })).rejects.toThrow("Experiment config is not valid JSON");
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
