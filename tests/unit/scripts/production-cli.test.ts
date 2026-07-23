import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectProductionPreflightReport,
  isKnownCloudSyncPath,
  parseProductionPreflightArguments,
  PRODUCTION_CONFIG_PATH,
  PRODUCTION_MINIMUM_FREE_BYTES,
  resolveProductionLogPath,
} from "../../../scripts/production-preflight.js";
import {
  checkProductionHealth,
  parseProductionHealthcheckArguments,
  PRODUCTION_HEALTH_CONFIG_PATH,
  runProductionHealthcheck,
} from "../../../scripts/production-healthcheck.js";
import {
  loadFormalProductionConfig,
} from "../../../src/shared/formal-production-config.js";

const FIXED_NOW = new Date("2026-07-23T03:00:00.000Z");
const FIXED_DAY = "2026-07-23";
const PROTOCOL_VERSION = "R8-010-2x2-screen-v3";
const temporaryRoots: string[] = [];

function digest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function formalConfigSource(loggingDirectory = "./data/sessions"): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
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
    studyTitle: "本番専用CLI合成設定",
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
      directory: loggingDirectory,
      includeAbortedInOrderBalancing: true,
    },
    network: {
      allowLan: false,
      allowExternalRuntimeRequests: false,
    },
  };
}

async function createProductionRoot(options: {
  readonly directoryName?: string;
  readonly loggingDirectory?: string;
} = {}): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "sechack-production-cli-"));
  temporaryRoots.push(parent);
  const root = options.directoryName === undefined
    ? parent
    : join(parent, options.directoryName);
  if (root !== parent) await mkdir(root);
  await mkdir(join(root, "config"));
  await writeFile(
    join(root, "config", "experiment.json"),
    JSON.stringify(formalConfigSource(options.loggingDirectory)),
    "utf8",
  );
  return root;
}

function checkByName(
  report: Awaited<ReturnType<typeof collectProductionPreflightReport>>,
  name: string,
) {
  const check = report.checks.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`Missing preflight check: ${name}`);
  return check;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("formal production preflight arguments", () => {
  it("accepts only the fixed production config, including normalized spellings", () => {
    expect(parseProductionPreflightArguments([])).toEqual({
      configPath: PRODUCTION_CONFIG_PATH,
    });
    expect(parseProductionPreflightArguments(["--config", "./config/experiment.json"]))
      .toEqual({ configPath: PRODUCTION_CONFIG_PATH });
    expect(parseProductionPreflightArguments(["--config", "config\\experiment.json"]))
      .toEqual({ configPath: PRODUCTION_CONFIG_PATH });
  });

  it.each([
    ["--allow-mock"],
    ["--help"],
    ["--config=config/experiment.json"],
    ["--config", "config/other.json"],
    ["--config", "C:\\config\\experiment.json"],
    ["--config", "config/experiment.json", "--config", "config/experiment.json"],
  ])("rejects non-production arguments: %j", (...args: string[]) => {
    expect(() => parseProductionPreflightArguments(args)).toThrow();
  });
});

describe("formal production preflight operational checks", () => {
  it("keeps logs under data, validates existing logs, syncs a probe and removes it", async () => {
    const root = await createProductionRoot();
    const report = await collectProductionPreflightReport({
      rootDirectory: root,
      currentDate: FIXED_NOW,
    });

    expect(resolveProductionLogPath(root, "./data/sessions")).toEqual({
      path: join(root, "data", "sessions"),
      safe: true,
    });
    expect(checkByName(report, "logging.directory").status).toBe("pass");
    expect(checkByName(report, "logging.integrity").status).toBe("pass");
    expect(report.logSessionCount).toBe(0);
    expect(await readdir(join(root, "data", "sessions"))).toEqual([]);
    expect(checkByName(report, "disk.freeSpace").status).toBe(
      report.availableBytes !== null && report.availableBytes >= PRODUCTION_MINIMUM_FREE_BYTES
        ? "pass"
        : "fail",
    );
  });

  it("fails before creating data when the repository is cloud-synced", async () => {
    const root = await createProductionRoot({ directoryName: "OneDrive" });
    const report = await collectProductionPreflightReport({
      rootDirectory: root,
      currentDate: FIXED_NOW,
    });

    expect(isKnownCloudSyncPath(root)).toBe(true);
    expect(checkByName(report, "logging.cloudSyncPath").status).toBe("fail");
    expect(checkByName(report, "logging.directory").status).toBe("fail");
    await expect(access(join(root, "data"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses ExperimentLogger validation and rejects a malformed existing JSONL log", async () => {
    const root = await createProductionRoot();
    const dateDirectory = join(root, "data", "sessions", FIXED_DAY);
    await mkdir(dateDirectory, { recursive: true });
    await writeFile(join(dateDirectory, "invalid.jsonl"), "not-json\n", "utf8");

    const report = await collectProductionPreflightReport({
      rootDirectory: root,
      currentDate: FIXED_NOW,
    });
    expect(checkByName(report, "logging.directory").status).toBe("pass");
    expect(checkByName(report, "logging.integrity")).toMatchObject({ status: "fail" });
  });
});

describe("formal production healthcheck", () => {
  it("accepts only the fixed config and a bounded integer timeout", () => {
    expect(parseProductionHealthcheckArguments([])).toEqual({
      configPath: PRODUCTION_HEALTH_CONFIG_PATH,
      timeoutMs: 5_000,
    });
    expect(parseProductionHealthcheckArguments([
      "--timeout",
      "60000",
      "--config",
      "./config/experiment.json",
    ])).toEqual({
      configPath: PRODUCTION_HEALTH_CONFIG_PATH,
      timeoutMs: 60_000,
    });
    expect(() => parseProductionHealthcheckArguments(["--timeout", "99"])).toThrow();
    expect(() => parseProductionHealthcheckArguments(["--timeout", "100.5"])).toThrow();
    expect(() => parseProductionHealthcheckArguments(["--mock-rehearsal"])).toThrow();
    expect(() => parseProductionHealthcheckArguments(["--config", "config/other.json"]))
      .toThrow();
    expect(() => parseProductionHealthcheckArguments(["--config=config/experiment.json"]))
      .toThrow();
  });

  it("GETs only loopback healthz and validates protocol, config hash and screen mode", async () => {
    const root = await createProductionRoot();
    const loaded = await loadFormalProductionConfig(PRODUCTION_HEALTH_CONFIG_PATH, {
      rootDirectory: root,
      currentDate: FIXED_NOW,
    });
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const result = await checkProductionHealth({
      rootDirectory: root,
      currentDate: FIXED_NOW,
      timeoutMs: 1_000,
      fetchImplementation: (async (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(JSON.stringify({
          status: "ok",
          appVersion: "1.1.0",
          protocolVersion: loaded.config.protocolVersion,
          configHash: loaded.configHash,
          deviceMode: "screen",
        }), { status: 200 });
      }) as typeof fetch,
    });

    expect(requestedUrl).toBe("http://127.0.0.1:4173/healthz");
    expect(requestedInit).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      url: "http://127.0.0.1:4173/healthz",
      protocolVersion: PROTOCOL_VERSION,
      configHash: loaded.configHash,
      deviceMode: "screen",
    });
  });

  it("rejects a mismatched health payload and never provides a mock escape hatch", async () => {
    const root = await createProductionRoot();
    await expect(checkProductionHealth({
      rootDirectory: root,
      currentDate: FIXED_NOW,
      fetchImplementation: (async () => new Response(JSON.stringify({
        status: "ok",
        appVersion: "1.1.0",
        protocolVersion: PROTOCOL_VERSION,
        configHash: digest("wrong-config"),
        deviceMode: "screen",
      }), { status: 200 })) as typeof fetch,
    })).rejects.toThrow("config hash");

    let fetchCalled = false;
    const lines: string[] = [];
    await expect(runProductionHealthcheck({
      args: ["--mock-rehearsal"],
      rootDirectory: root,
      currentDate: FIXED_NOW,
      fetchImplementation: (async () => {
        fetchCalled = true;
        return new Response();
      }) as typeof fetch,
      writeLine: (line) => lines.push(line),
    })).resolves.toBe(1);
    expect(fetchCalled).toBe(false);
    expect(lines.join("\n")).toContain("FAIL");
  });
});
