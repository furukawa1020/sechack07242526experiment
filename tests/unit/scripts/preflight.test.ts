import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashProductionCriticalConfig } from "../../../src/shared/config-loader.js";

import {
  evaluatePreflightGates,
  formatByteCount,
  isApprovedGoogleFormsUrl,
  isWindowsComPath,
  parsePreflightArguments,
  resolveLogPath,
  runPreflight,
} from "../../../scripts/preflight.js";
import {
  SCREEN_PROTOCOL_VERSION,
  parseExperimentConfig,
  STUDY_FORM_URL,
  type ExperimentConfig,
} from "../../../src/shared/schemas.js";

const AUDIT_CONTENT_SHA256 = "087a88918e51f152e237a823b51a64e23e91e6f9fc328ac9796fe9475cdc1800";
const AUDIT_NOW = new Date("2026-07-21T12:00:00Z");

function fixtureDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function goFormAudit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "GO",
    protocolVersion: "test-protocol-v1",
    formUrl: STUDY_FORM_URL,
    auditedOn: "2026-07-21",
    contentSha256: AUDIT_CONTENT_SHA256,
    twoPersonVerified: true,
    ...overrides,
  };
}

function configSource(overrides: {
  readonly mode?: "mock" | "serial" | "screen";
  readonly protocolVersion?: string;
  readonly serialPath?: string;
  readonly allowMockInProduction?: boolean;
  readonly formUrl?: string;
  readonly formAudit?: Record<string, unknown>;
  readonly omitFormAudit?: boolean;
} = {}): Record<string, unknown> {
  const formUrl = overrides.formUrl ?? STUDY_FORM_URL;
  const mode = overrides.mode ?? "screen";
  const protocolVersion = overrides.protocolVersion ?? (mode === "screen"
    ? SCREEN_PROTOCOL_VERSION
    : "test-protocol-v1");
  const source: Record<string, unknown> = {
    schemaVersion: 1,
    protocolVersion,
    studyTitle: "合成テスト設定",
    bindHost: "127.0.0.1",
    port: 4173,
    researchIdPattern: mode === "screen" ? "^SH26-[0-9]{3}$" : "^TEST-[0-9]{3}$",
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
      serialPath: overrides.serialPath ?? (mode === "screen" ? "" : "COM3"),
      baudRate: 115_200,
      ackTimeout: 1_000,
      allowMockInProduction: overrides.allowMockInProduction ?? false,
    },
    formUrl,
    formAudit: overrides.formAudit ?? goFormAudit({ formUrl, protocolVersion }),
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: {
      allowLan: false,
      allowExternalRuntimeRequests: false,
    },
  };
  if (overrides.omitFormAudit === true) Reflect.deleteProperty(source, "formAudit");
  if (mode === "screen") {
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
    source["goEvidence"] = {
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
    };
  }
  return source;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("preflight argument parsing", () => {
  it("accepts mock mode and both config path forms", () => {
    expect(parsePreflightArguments(["--allow-mock", "--config", "config/lab.json"]))
      .toEqual({ allowMock: true, help: false, configPath: "config/lab.json" });
    expect(parsePreflightArguments(["--config=config/lab.json"]))
      .toEqual({ allowMock: false, help: false, configPath: "config/lab.json" });
  });

  it("rejects missing, duplicate, and unknown options", () => {
    expect(() => parsePreflightArguments(["--config"])).toThrow("requires a path");
    expect(() => parsePreflightArguments(["--config=a", "--config=b"])).toThrow("only be specified once");
    expect(() => parsePreflightArguments(["--production-ish"])).toThrow("Unknown option");
  });
});

describe("preflight production gates", () => {
  it("recognizes only approved Google Forms URL shapes", () => {
    expect(isApprovedGoogleFormsUrl("https://docs.google.com/forms/d/example/viewform")).toBe(true);
    expect(isApprovedGoogleFormsUrl(
      "https://docs.google.com/forms/d/e/example/viewform?usp=send_form",
    )).toBe(true);
    expect(isApprovedGoogleFormsUrl("https://forms.gle/example")).toBe(true);
    expect(isApprovedGoogleFormsUrl("https://docs.google.com/forms/")).toBe(false);
    expect(isApprovedGoogleFormsUrl("https://example.com/forms/example")).toBe(false);
    expect(isApprovedGoogleFormsUrl("http://forms.gle/example")).toBe(false);
    expect(isApprovedGoogleFormsUrl("https://forms.gle/example?entry.123=SH26-001")).toBe(false);
    expect(isApprovedGoogleFormsUrl("https://forms.gle/example?usp=pp_url")).toBe(false);
    expect(isApprovedGoogleFormsUrl("https://forms.gle/example#prefill")).toBe(false);
  });

  it("accepts Windows COM paths and rejects non-COM device paths", () => {
    expect(isWindowsComPath("COM3")).toBe(true);
    expect(isWindowsComPath("com27")).toBe(true);
    expect(isWindowsComPath("\\\\.\\COM10")).toBe(true);
    expect(isWindowsComPath("COM0")).toBe(false);
    expect(isWindowsComPath("/dev/ttyUSB0")).toBe(false);
  });

  it("rejects every Serial production configuration", () => {
    const config = parseExperimentConfig(configSource({ mode: "serial" }));
    const failures = evaluatePreflightGates(config, false, AUDIT_NOW)
      .filter((check) => check.status === "fail")
      .map((check) => check.name);
    expect(failures).toEqual(expect.arrayContaining([
      "device.mode",
      "device.serialPath",
      "protocolVersion",
      "protocol.fixedParameters",
    ]));
  });

  it("passes a complete screen production configuration without a Serial path", () => {
    const config = parseExperimentConfig(configSource({ mode: "screen" }));
    const deviceChecks = evaluatePreflightGates(config, false, AUDIT_NOW).filter(
      (check) => check.name.startsWith("device."),
    );
    expect(deviceChecks.every((check) => check.status === "pass")).toBe(true);
    expect(deviceChecks.find((check) => check.name === "device.serialPath")?.detail)
      .toContain("Serialポートを使用しません");
    expect(evaluatePreflightGates(config, false, AUDIT_NOW).find(
      (check) => check.name === "protocol.fixedParameters",
    )?.status).toBe("pass");
    expect(evaluatePreflightGates(config, false, AUDIT_NOW).find(
      (check) => check.name === "goEvidence",
    )?.status).toBe("pass");
  });

  it("rejects a GO form audit when the broader production evidence is absent", () => {
    const complete = parseExperimentConfig(configSource({ mode: "screen" }));
    const formOnly = { ...complete, goEvidence: undefined } as ExperimentConfig;
    const checks = evaluatePreflightGates(formOnly, false, AUDIT_NOW);
    expect(checks.find((check) => check.name === "formAudit")?.status).toBe("pass");
    expect(checks.find((check) => check.name === "goEvidence")?.status).toBe("fail");
  });

  it("rejects an arbitrary protocolVersion even when the remaining screen metadata is formal", () => {
    const base = parseExperimentConfig(configSource({ mode: "screen" }));
    const arbitrary = {
      ...base,
      protocolVersion: "arbitrary-screen-v2",
      formAudit: { ...base.formAudit!, protocolVersion: "arbitrary-screen-v2" },
    } as ExperimentConfig;
    expect(evaluatePreflightGates(arbitrary, false, AUDIT_NOW).find(
      (check) => check.name === "protocolVersion",
    )).toMatchObject({ status: "fail" });
  });

  it("fails modified screen-v1 parameters only at the production gate", () => {
    const base = parseExperimentConfig(configSource({ mode: "screen" }));
    const modified = {
      ...base,
      timingMs: { ...base.timingMs, result: 15_001 },
    } as ExperimentConfig;
    expect(evaluatePreflightGates(modified, false, AUDIT_NOW).find(
      (check) => check.name === "protocol.fixedParameters",
    )).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("screen-timing-mismatch"),
    });
    expect(evaluatePreflightGates(modified, true, AUDIT_NOW).find(
      (check) => check.name === "protocol.fixedParameters",
    )?.status).toBe("warning");
  });

  it("rejects a different Google Forms URL even when its shape and audit are valid", () => {
    const differentUrl = "https://docs.google.com/forms/d/example/viewform";
    const config = parseExperimentConfig(configSource({
      formUrl: differentUrl,
      formAudit: goFormAudit({ formUrl: differentUrl }),
    }));
    expect(evaluatePreflightGates(config, false, AUDIT_NOW).find(
      (check) => check.name === "formUrl",
    )?.status).toBe("fail");
  });

  it.each([
    ["NO-GO", { formAudit: goFormAudit({ status: "NO-GO" }) }],
    ["protocol mismatch", { formAudit: goFormAudit({ protocolVersion: "other-protocol" }) }],
    ["form URL mismatch", { formAudit: goFormAudit({ formUrl: "https://forms.gle/different" }) }],
    ["stale", { formAudit: goFormAudit({ auditedOn: "2026-07-13" }) }],
    ["missing", { omitFormAudit: true }],
    ["two-person false", { formAudit: goFormAudit({ twoPersonVerified: false }) }],
  ] as const)("rejects %s form audit evidence in production but permits Mock development", (
    _label,
    overrides,
  ) => {
    const config = parseExperimentConfig(configSource(overrides));
    expect(evaluatePreflightGates(config, false, AUDIT_NOW).find(
      (check) => check.name === "formAudit",
    )?.status).toBe("fail");
    expect(evaluatePreflightGates(config, true, AUDIT_NOW).find(
      (check) => check.name === "formAudit",
    )?.status).toBe("warning");
  });

  it("fails Mock and missing form data in production but permits development Mock checking", () => {
    const mock = parseExperimentConfig(configSource({
      mode: "mock",
      serialPath: "",
      formUrl: "",
      formAudit: goFormAudit({
        status: "NO-GO",
        formUrl: "",
        twoPersonVerified: false,
      }),
    }));
    const productionFailures = evaluatePreflightGates(mock, false, AUDIT_NOW)
      .filter((check) => check.status === "fail")
      .map((check) => check.name);
    expect(productionFailures).toEqual(expect.arrayContaining([
      "device.mode",
      "device.serialPath",
      "formUrl",
      "formAudit",
    ]));
    expect(evaluatePreflightGates(mock, true, AUDIT_NOW).some((check) => check.status === "fail"))
      .toBe(false);
  });


  it("always rejects production Mock permission and external runtime requests", () => {
    const allowsMock = parseExperimentConfig(configSource({ allowMockInProduction: true }));
    const externalRequests = {
      ...parseExperimentConfig(configSource()),
      network: {
        allowLan: false,
        allowExternalRuntimeRequests: true,
      },
    } as ExperimentConfig;
    expect(evaluatePreflightGates(allowsMock, true).find(
      (check) => check.name === "device.allowMockInProduction",
    )?.status).toBe("fail");
    expect(evaluatePreflightGates(externalRequests, true).find(
      (check) => check.name === "network.allowExternalRuntimeRequests",
    )?.status).toBe("fail");
  });

  it("rejects a Serial path on a screen production config", () => {
    const valid = parseExperimentConfig(configSource({ mode: "screen" }));
    const invalid = {
      ...valid,
      device: { ...valid.device, serialPath: "COM3" },
    } as ExperimentConfig;
    expect(evaluatePreflightGates(invalid, false, AUDIT_NOW).find(
      (check) => check.name === "device.serialPath",
    )?.status).toBe("fail");
  });
});

describe("preflight report safety", () => {
  it("keeps the log target inside data and formats available capacity", () => {
    expect(resolveLogPath("C:\\repo", ".\\data\\sessions").safe).toBe(true);
    expect(resolveLogPath("C:\\repo", "..\\outside").safe).toBe(false);
    expect(formatByteCount(1_610_612_736n)).toBe("1.50 GiB");
  });

  it("runs the development Mock check without printing unrelated secret environment values", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-preflight-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "config"));
    await mkdir(join(root, "data"));
    await writeFile(
      join(root, "config", "experiment.json"),
      JSON.stringify(configSource({
        mode: "mock",
        serialPath: "",
        formUrl: "",
        formAudit: goFormAudit({
          status: "NO-GO",
          formUrl: "",
          twoPersonVerified: false,
        }),
      })),
      "utf8",
    );
    const output: string[] = [];
    const secret = "do-not-print-this-operator-token";

    const exitCode = await runPreflight({
      args: ["--allow-mock"],
      rootDirectory: root,
      environment: { OPERATOR_TOKEN: secret },
      writeLine: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("結果: PASS");
    expect(output.join("\n")).toContain("SHA-256");
    expect(output.join("\n")).toContain("フォーム監査: NO-GO");
    expect(output.join("\n")).not.toContain(secret);
  });
});
