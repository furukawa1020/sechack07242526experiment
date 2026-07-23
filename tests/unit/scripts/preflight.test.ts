import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  readonly allowExternalRuntimeRequests?: boolean;
  readonly allowLan?: boolean;
  readonly bindHost?: string;
  readonly mode?: "mock" | "serial" | "screen";
  readonly port?: number;
  readonly protocolVersion?: string;
  readonly serialPath?: string;
  readonly allowMockInProduction?: boolean;
  readonly formUrl?: string;
  readonly formAudit?: Record<string, unknown>;
  readonly omitFormAudit?: boolean;
} = {}): Record<string, unknown> {
  const formUrl = overrides.formUrl ?? "";
  const mode = overrides.mode ?? "screen";
  const protocolVersion = overrides.protocolVersion ?? (mode === "screen"
    ? SCREEN_PROTOCOL_VERSION
    : "test-protocol-v1");
  const source: Record<string, unknown> = {
    schemaVersion: 1,
    protocolVersion,
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
    studyTitle: "合成テスト設定",
    bindHost: overrides.bindHost ?? "127.0.0.1",
    port: overrides.port ?? 4173,
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
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: {
      allowLan: overrides.allowLan ?? false,
      allowExternalRuntimeRequests: overrides.allowExternalRuntimeRequests ?? false,
    },
  };
  if (overrides.formAudit !== undefined && overrides.omitFormAudit !== true) {
    source["formAudit"] = overrides.formAudit;
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
      (check) => check.name === "compliance.external",
    )?.status).toBe("pass");
  });

  it("does not require legacy approval evidence in external compliance mode", () => {
    const config = parseExperimentConfig(configSource({ mode: "screen" }));
    const checks = evaluatePreflightGates(config, false, AUDIT_NOW);
    expect(checks.find((check) => check.name === "formAudit")?.status).toBe("pass");
    expect(checks.find((check) => check.name === "compliance.external")?.status).toBe("pass");
  });

  it("rejects an arbitrary protocolVersion even when the remaining screen metadata is formal", () => {
    const base = parseExperimentConfig(configSource({ mode: "screen" }));
    const arbitrary = {
      ...base,
      protocolVersion: "arbitrary-screen-v3",
    } as ExperimentConfig;
    expect(evaluatePreflightGates(arbitrary, false, AUDIT_NOW).find(
      (check) => check.name === "protocolVersion",
    )).toMatchObject({ status: "fail" });
  });

  it("fails modified screen-v3 parameters only at the production gate", () => {
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

  it("rejects every non-empty Google Forms URL", () => {
    const differentUrl = "https://docs.google.com/forms/d/example/viewform";
    const config = parseExperimentConfig(configSource({
      formUrl: differentUrl,
    }));
    expect(evaluatePreflightGates(config, false, AUDIT_NOW).find(
      (check) => check.name === "formUrl",
    )?.status).toBe("fail");
  });

  it.each([
    ["GO", goFormAudit()],
    ["NO-GO", goFormAudit({ status: "NO-GO" })],
    ["protocol mismatch", goFormAudit({ protocolVersion: "other-protocol" })],
    ["stale", goFormAudit({ auditedOn: "2026-07-13" })],
  ] as const)("rejects %s legacy form audit evidence in production but permits Mock development", (
    _label,
    formAudit,
  ) => {
    const config = parseExperimentConfig(configSource({ formAudit }));
    expect(evaluatePreflightGates(config, false, AUDIT_NOW).find(
      (check) => check.name === "formAudit",
    )?.status).toBe("fail");
    expect(evaluatePreflightGates(config, true, AUDIT_NOW).find(
      (check) => check.name === "formAudit",
    )?.status).toBe("warning");
  });

  it("passes only when formAudit is absent", () => {
    const config = parseExperimentConfig(configSource({ omitFormAudit: true }));
    expect(evaluatePreflightGates(config, false, AUDIT_NOW).find(
      (check) => check.name === "formAudit",
    )?.status).toBe("pass");
  });

  it("fails Mock and legacy form-audit data in production but permits development Mock checking", () => {
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

  it.each([
    [
      "bindHost",
      { bindHost: "localhost" },
      "production-bind-host-not-127-0-0-1",
    ],
    ["port", { port: 4_174 }, "production-port-not-4173"],
    [
      "network.allowLan",
      { allowLan: true },
      "production-lan-access-enabled",
    ],
    [
      "network.allowExternalRuntimeRequests",
      { allowExternalRuntimeRequests: true },
      "production-external-runtime-requests-enabled",
    ],
  ] as const)("rejects a modified production %s boundary", (_label, overrides, issueCode) => {
    const config = issueCode === "production-external-runtime-requests-enabled"
      ? ({
          ...parseExperimentConfig(configSource()),
          network: {
            allowLan: false,
            allowExternalRuntimeRequests: true,
          },
        } as ExperimentConfig)
      : parseExperimentConfig(configSource(overrides));
    expect(evaluatePreflightGates(config, false, AUDIT_NOW).find(
      (check) => check.name === "network.productionBoundary",
    )).toMatchObject({
      status: "fail",
      detail: expect.stringContaining(issueCode),
    });
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
    expect(output.join("\n")).toContain("外部アンケート統合: 本番利用不可");
    expect(output.join("\n")).not.toContain(secret);
  });
});
