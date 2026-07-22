import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  hashExperimentConfig,
  hashProductionCriticalConfig,
  loadExperimentConfig,
} from "../../../src/shared/config-loader.js";
import {
  ExperimentConfigSchema,
  formatConfigError,
  isResearchIdValid,
  SCREEN_PROTOCOL_VERSION,
  parseExperimentConfig,
  STUDY_FORM_URL,
} from "../../../src/shared/schemas.js";

const AUDIT_CONTENT_SHA256 = "087a88918e51f152e237a823b51a64e23e91e6f9fc328ac9796fe9475cdc1800";

function fixtureDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocolVersion: "R8-010-2x2-mock-v3",
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
      mode: "mock",
      serialPath: "",
      baudRate: 115_200,
      ackTimeout: 1_000,
      allowMockInProduction: false,
    },
    formUrl: "",
    formAudit: {
      status: "NO-GO",
      protocolVersion: "R8-010-2x2-mock-v3",
      formUrl: "",
      auditedOn: "2026-07-21",
      contentSha256: AUDIT_CONTENT_SHA256,
      twoPersonVerified: false,
    },
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: { allowLan: false, allowExternalRuntimeRequests: false },
  };
}

function withApprovedGoEvidence(source: Record<string, unknown>): Record<string, unknown> {
  const protocolVersion = String(source["protocolVersion"]);
  const criticalConfigSha256 = hashProductionCriticalConfig(parseExperimentConfig(source));
  const approval = (documentId: string, contentSha256: string) => ({
    status: "GO",
    protocolVersion,
    documentId,
    documentVersion: "1.0",
    contentSha256,
    approvedOn: "2026-07-20",
    applicableUntil: "2026-07-22",
  });
  return {
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
  };
}

describe("experiment config schema", () => {
  it("parses and deeply freezes the approved configuration", () => {
    const config = parseExperimentConfig(validConfig());
    expect(config.fixedState).toEqual({ score: 72, label: "高ストレス", pufferLevel: 0.6 });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.fixedState)).toBe(true);
    expect(Object.isFrozen(config.orders)).toBe(true);
    expect(Object.isFrozen(config.formAudit)).toBe(true);
    expect(isResearchIdValid(config, "SH26-001")).toBe(true);
    expect(isResearchIdValid(config, "SH26-01")).toBe(false);
    expect(isResearchIdValid(config, "SH26-001\nmail@example.test")).toBe(false);
    expect(isResearchIdValid(config, "X".repeat(65))).toBe(false);
  });

  it("rejects unknown keys, modified orders and unsafe network settings", () => {
    expect(() => parseExperimentConfig({ ...validConfig(), email: "person@example.test" })).toThrow();
    expect(() => parseExperimentConfig({ ...validConfig(), orders: ["ABDC", "ABDC", "CDBA", "DACB"] }))
      .toThrow(/orders/iu);
    expect(() => parseExperimentConfig({ ...validConfig(), bindHost: "0.0.0.0" }))
      .toThrow(/loopback/iu);
    expect(() => parseExperimentConfig({
      ...validConfig(),
      network: { allowLan: true, allowExternalRuntimeRequests: true },
    })).toThrow(/External runtime requests/iu);
  });

  it("validates serial, timing, URL and regular-expression fields", () => {
    expect(() => parseExperimentConfig({
      ...validConfig(),
      device: { ...(validConfig()["device"] as object), mode: "serial", serialPath: "" },
    })).toThrow(/serialPath/iu);
    expect(parseExperimentConfig({
      ...validConfig(),
      protocolVersion: SCREEN_PROTOCOL_VERSION,
      device: { ...(validConfig()["device"] as object), mode: "screen", serialPath: "" },
    }).device.mode).toBe("screen");
    expect(() => parseExperimentConfig({
      ...validConfig(),
      protocolVersion: SCREEN_PROTOCOL_VERSION,
      device: { ...(validConfig()["device"] as object), mode: "screen", serialPath: "COM3" },
    })).toThrow(/serialPath must be empty/iu);
    expect(() => parseExperimentConfig({
      ...validConfig(),
      device: { ...(validConfig()["device"] as object), mode: "screen", serialPath: "" },
    })).toThrow(/screen mode requires protocolVersion/iu);
    expect(parseExperimentConfig({
      ...validConfig(),
      protocolVersion: SCREEN_PROTOCOL_VERSION,
    }).device.mode).toBe("mock");
    expect(() => parseExperimentConfig({
      ...validConfig(),
      protocolVersion: SCREEN_PROTOCOL_VERSION,
      device: { ...(validConfig()["device"] as object), mode: "serial", serialPath: "COM3" },
    })).toThrow(/requires screen or mock device mode/iu);
    expect(() => parseExperimentConfig({
      ...validConfig(),
      timingMs: { ...(validConfig()["timingMs"] as object), reset: 1_000 },
    })).toThrow(/deflateRamp/iu);
    expect(() => parseExperimentConfig({
      ...validConfig(),
      timingMs: { ...(validConfig()["timingMs"] as object), result: 1_000 },
    })).toThrow(/inflateRamp/iu);
    expect(() => parseExperimentConfig({ ...validConfig(), formUrl: "http://example.test/form" }))
      .toThrow(/HTTPS/iu);
    expect(() => parseExperimentConfig({ ...validConfig(), formUrl: "not a url" }))
      .toThrow(/valid HTTPS URL/iu);
    expect(() => parseExperimentConfig({ ...validConfig(), formUrl: "https://example.test/form" }))
      .toThrow(/Google Forms/iu);
    expect(parseExperimentConfig({
      ...validConfig(),
      formUrl: "https://docs.google.com/forms/d/e/example/viewform",
    }).formUrl).toContain("docs.google.com/forms/");
    expect(parseExperimentConfig({
      ...validConfig(),
      formUrl: "https://forms.gle/BeShY7cY5zMjunto9",
    }).formUrl).toBe("https://forms.gle/BeShY7cY5zMjunto9");
    expect(() => parseExperimentConfig({ ...validConfig(), researchIdPattern: "[" }))
      .toThrow(/regular expression/iu);
  });

  it("validates the machine-readable form audit evidence shape", () => {
    const go = parseExperimentConfig({
      ...validConfig(),
      formUrl: STUDY_FORM_URL,
      formAudit: {
        status: "GO",
        protocolVersion: "R8-010-2x2-mock-v3",
        formUrl: STUDY_FORM_URL,
        auditedOn: "2026-07-21",
        contentSha256: AUDIT_CONTENT_SHA256,
        twoPersonVerified: true,
      },
    });
    expect(go.formAudit?.status).toBe("GO");

    expect(() => parseExperimentConfig({
      ...validConfig(),
      formAudit: {
        status: "NO-GO",
        protocolVersion: "R8-010-2x2-mock-v3",
        formUrl: "",
        auditedOn: "2026-02-30",
        contentSha256: AUDIT_CONTENT_SHA256,
        twoPersonVerified: false,
      },
    })).toThrow(/valid calendar date/iu);
    expect(() => parseExperimentConfig({
      ...validConfig(),
      formAudit: {
        status: "NO-GO",
        protocolVersion: "R8-010-2x2-mock-v3",
        formUrl: "",
        auditedOn: "2026-07-21",
        contentSha256: "not-a-sha256",
        twoPersonVerified: false,
      },
    })).toThrow(/SHA-256/iu);
    expect(() => parseExperimentConfig({
      ...validConfig(),
      formAudit: {
        status: "NO-GO",
        protocolVersion: "R8-010-2x2-mock-v3",
        formUrl: "",
        auditedOn: "2026-07-21",
        contentSha256: AUDIT_CONTENT_SHA256,
        twoPersonVerified: false,
        reviewerName: "must-not-be-stored",
      },
    })).toThrow(/unrecognized key/iu);
  });

  it("accepts only non-PII structured production GO evidence", () => {
    const screen = {
      ...validConfig(),
      protocolVersion: SCREEN_PROTOCOL_VERSION,
      device: { ...(validConfig()["device"] as object), mode: "screen", serialPath: "" },
    };
    const parsed = parseExperimentConfig(withApprovedGoEvidence(screen));
    expect(parsed.goEvidence?.screenPilot.completedSessions).toBe(3);
    expect(Object.isFrozen(parsed.goEvidence)).toBe(true);

    const withName = withApprovedGoEvidence(screen);
    (withName["goEvidence"] as Record<string, unknown>)["reviewerName"] = "must-not-be-stored";
    expect(() => parseExperimentConfig(withName)).toThrow(/unrecognized key/iu);
  });

  it("formats validation errors without exposing an exception object", () => {
    const parsed = ExperimentConfigSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatConfigError(parsed.error)[0]).toMatch(/^schemaVersion:/u);
    }
    expect(formatConfigError(new Error("plain failure"))).toEqual(["plain failure"]);
    expect(formatConfigError(null)).toEqual(["Unknown configuration error."]);
  });
});

describe("config file loading", () => {
  it("loads the repository config and returns a stable SHA-256", async () => {
    const loaded = await loadExperimentConfig();
    expect(loaded.config.protocolVersion).toBe(SCREEN_PROTOCOL_VERSION);
    expect(loaded.configHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashExperimentConfig(loaded.config)).toBe(loaded.configHash);
    const sourceBytes = await readFile(loaded.path);
    expect(Buffer.from(loaded.sourceBytes)).toEqual(sourceBytes);
    expect(loaded.configFileHash).toBe(
      createHash("sha256").update(sourceBytes).digest("hex"),
    );
  });

  it("blocks path traversal and production MockDevice misuse", async () => {
    await expect(loadExperimentConfig("../outside.json")).rejects.toThrow(/allowed config directory/iu);
    await expect(loadExperimentConfig("config/experiment.json", { production: true }))
      .rejects.toThrow(/Mock device mode is unconditionally disabled/iu);
  });

  it("fails production loading closed unless a current, bound two-person GO exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-production-audit-"));
    const configDirectory = join(root, "config");
    await mkdir(configDirectory);
    const source = {
      ...validConfig(),
      protocolVersion: SCREEN_PROTOCOL_VERSION,
      formUrl: STUDY_FORM_URL,
      device: {
        ...(validConfig()["device"] as Record<string, unknown>),
        mode: "screen",
        serialPath: "",
      },
      formAudit: {
        status: "NO-GO",
        protocolVersion: SCREEN_PROTOCOL_VERSION,
        formUrl: STUDY_FORM_URL,
        auditedOn: "2026-07-21",
        contentSha256: AUDIT_CONTENT_SHA256,
        twoPersonVerified: false,
      },
    };
    const configPath = join(configDirectory, "production.json");
    await writeFile(configPath, JSON.stringify(source), "utf8");

    await expect(loadExperimentConfig("config/production.json", {
      rootDirectory: root,
      production: true,
      currentDate: new Date("2026-07-21T12:00:00Z"),
    })).rejects.toThrow(/status-not-go/iu);

    await writeFile(configPath, JSON.stringify({
      ...source,
      formAudit: {
        ...(source.formAudit as Record<string, unknown>),
        status: "GO",
        twoPersonVerified: true,
      },
    }), "utf8");
    await expect(loadExperimentConfig("config/production.json", {
      rootDirectory: root,
      production: true,
      currentDate: new Date("2026-07-21T12:00:00Z"),
    })).rejects.toThrow(/GO evidence gate.*missing/iu);

    await writeFile(configPath, JSON.stringify(withApprovedGoEvidence({
      ...source,
      formAudit: {
        ...(source.formAudit as Record<string, unknown>),
        status: "GO",
        twoPersonVerified: true,
      },
    })), "utf8");
    await expect(loadExperimentConfig("config/production.json", {
      rootDirectory: root,
      production: true,
      currentDate: new Date("2026-07-21T12:00:00Z"),
    })).resolves.toMatchObject({
      config: { protocolVersion: SCREEN_PROTOCOL_VERSION, device: { mode: "screen" } },
    });

    const withoutAudit: Record<string, unknown> = { ...source };
    Reflect.deleteProperty(withoutAudit, "formAudit");
    await writeFile(configPath, JSON.stringify(withoutAudit), "utf8");
    await expect(loadExperimentConfig("config/production.json", {
      rootDirectory: root,
      production: true,
      currentDate: new Date("2026-07-21T12:00:00Z"),
    })).rejects.toThrow(/missing/iu);
  });

  it("applies the same production device policy during direct config loading", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-production-device-policy-"));
    const configDirectory = join(root, "config");
    await mkdir(configDirectory);
    const approvedScreenAudit = {
      status: "GO",
      protocolVersion: SCREEN_PROTOCOL_VERSION,
      formUrl: STUDY_FORM_URL,
      auditedOn: "2026-07-21",
      contentSha256: AUDIT_CONTENT_SHA256,
      twoPersonVerified: true,
    };
    const screenBase = {
      ...validConfig(),
      protocolVersion: SCREEN_PROTOCOL_VERSION,
      formUrl: STUDY_FORM_URL,
      formAudit: approvedScreenAudit,
    };
    const configPath = join(configDirectory, "production.json");

    await writeFile(configPath, JSON.stringify(withApprovedGoEvidence({
      ...screenBase,
      device: {
        ...(validConfig()["device"] as Record<string, unknown>),
        mode: "screen",
        serialPath: "",
      },
    })), "utf8");
    await expect(loadExperimentConfig("config/production.json", {
      rootDirectory: root,
      production: true,
      currentDate: new Date("2026-07-21T12:00:00Z"),
    })).resolves.toMatchObject({ config: { device: { mode: "screen", serialPath: "" } } });

    await writeFile(configPath, JSON.stringify({
      ...screenBase,
      fixedState: {
        ...(validConfig()["fixedState"] as Record<string, unknown>),
        score: 71,
      },
      device: {
        ...(validConfig()["device"] as Record<string, unknown>),
        mode: "screen",
        serialPath: "",
      },
    }), "utf8");
    await expect(loadExperimentConfig("config/production.json", {
      rootDirectory: root,
      production: true,
      currentDate: new Date("2026-07-21T12:00:00Z"),
    })).rejects.toThrow(/screen-fixed-state-mismatch/iu);

    await writeFile(configPath, JSON.stringify({
      ...validConfig(),
      formUrl: STUDY_FORM_URL,
      formAudit: {
        ...approvedScreenAudit,
        protocolVersion: "R8-010-2x2-mock-v3",
      },
      device: {
        ...(validConfig()["device"] as Record<string, unknown>),
        mode: "serial",
        serialPath: "COM0",
      },
    }), "utf8");
    await expect(loadExperimentConfig("config/production.json", {
      rootDirectory: root,
      production: true,
      currentDate: new Date("2026-07-21T12:00:00Z"),
    })).rejects.toThrow(/serial-device-not-allowed/iu);

    await writeFile(configPath, JSON.stringify({
      ...screenBase,
      device: {
        ...(validConfig()["device"] as Record<string, unknown>),
        mode: "screen",
        serialPath: "",
        allowMockInProduction: true,
      },
    }), "utf8");
    await expect(loadExperimentConfig("config/production.json", {
      rootDirectory: root,
      production: true,
      currentDate: new Date("2026-07-21T12:00:00Z"),
    })).rejects.toThrow(/allow-mock-in-production-enabled/iu);
  });

  it("reports malformed JSON from an allowed temporary config directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-config-"));
    const configDirectory = join(root, "config");
    await mkdir(configDirectory);
    await writeFile(join(configDirectory, "broken.json"), "{ broken", "utf8");
    await expect(loadExperimentConfig("config/broken.json", { rootDirectory: root }))
      .rejects.toThrow(/not valid JSON/iu);
  });
});
