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
  parseExperimentConfig,
  type ExperimentConfig,
} from "../../../src/shared/schemas.js";

function configSource(overrides: {
  readonly mode?: "mock" | "serial";
  readonly serialPath?: string;
  readonly allowMockInProduction?: boolean;
  readonly formUrl?: string;
} = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocolVersion: "test-protocol-v1",
    studyTitle: "合成テスト設定",
    bindHost: "127.0.0.1",
    port: 4173,
    researchIdPattern: "^TEST-[0-9]{3}$",
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
      mode: overrides.mode ?? "serial",
      serialPath: overrides.serialPath ?? "COM3",
      baudRate: 115_200,
      ackTimeout: 1_000,
      allowMockInProduction: overrides.allowMockInProduction ?? false,
    },
    formUrl: overrides.formUrl ?? "https://docs.google.com/forms/d/example/viewform",
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: {
      allowLan: false,
      allowExternalRuntimeRequests: false,
    },
  };
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
    expect(isApprovedGoogleFormsUrl("https://forms.gle/example")).toBe(true);
    expect(isApprovedGoogleFormsUrl("https://docs.google.com/forms/")).toBe(false);
    expect(isApprovedGoogleFormsUrl("https://example.com/forms/example")).toBe(false);
    expect(isApprovedGoogleFormsUrl("http://forms.gle/example")).toBe(false);
  });

  it("accepts Windows COM paths and rejects non-COM device paths", () => {
    expect(isWindowsComPath("COM3")).toBe(true);
    expect(isWindowsComPath("com27")).toBe(true);
    expect(isWindowsComPath("\\\\.\\COM10")).toBe(true);
    expect(isWindowsComPath("COM0")).toBe(false);
    expect(isWindowsComPath("/dev/ttyUSB0")).toBe(false);
  });

  it("passes a complete Serial production configuration", () => {
    const config = parseExperimentConfig(configSource());
    expect(evaluatePreflightGates(config, false).filter((check) => check.status === "fail"))
      .toEqual([]);
  });

  it("fails Mock and missing form data in production but permits development Mock checking", () => {
    const mock = parseExperimentConfig(configSource({
      mode: "mock",
      serialPath: "",
      formUrl: "",
    }));
    const productionFailures = evaluatePreflightGates(mock, false)
      .filter((check) => check.status === "fail")
      .map((check) => check.name);
    expect(productionFailures).toEqual(expect.arrayContaining([
      "device.mode",
      "device.serialPath",
      "formUrl",
    ]));
    expect(evaluatePreflightGates(mock, true).some((check) => check.status === "fail"))
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
      JSON.stringify(configSource({ mode: "mock", serialPath: "", formUrl: "" })),
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
    expect(output.join("\n")).not.toContain(secret);
  });
});
