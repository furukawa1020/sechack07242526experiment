import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkHealth,
  healthcheckHost,
  parseHealthcheckArguments,
  runHealthcheck,
} from "../../../scripts/healthcheck.js";
import {
  hashExperimentConfig,
  hashProductionCriticalConfig,
} from "../../../src/shared/config-loader.js";
import {
  parseExperimentConfig,
  SCREEN_PROTOCOL_VERSION,
} from "../../../src/shared/schemas.js";

interface ConfigOverrides {
  readonly allowExternalRuntimeRequests?: boolean;
  readonly bindHost?: string;
  readonly allowLan?: boolean;
  readonly deviceMode?: "mock" | "serial" | "screen";
  readonly port?: number;
  readonly protocolVersion?: string;
}

const TODAY_IN_JAPAN = new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);

function fixtureDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function configSource(overrides: ConfigOverrides = {}): Record<string, unknown> {
  const deviceMode = overrides.deviceMode ?? "screen";
  const protocolVersion = overrides.protocolVersion
    ?? (deviceMode === "screen" ? SCREEN_PROTOCOL_VERSION : "health-test-v1");
  const source = {
    schemaVersion: 1,
    protocolVersion,
    studyTitle: "ヘルスチェック合成設定",
    bindHost: overrides.bindHost ?? "127.0.0.1",
    port: overrides.port ?? 4173,
    researchIdPattern: deviceMode === "screen" ? "^SH26-[0-9]{3}$" : "^TEST-[0-9]{3}$",
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
      mode: deviceMode,
      serialPath: deviceMode === "serial" ? "COM3" : "",
      baudRate: 115_200,
      ackTimeout: 1_000,
      allowMockInProduction: false,
    },
    formUrl: "",
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: {
      allowLan: overrides.allowLan ?? false,
      allowExternalRuntimeRequests: overrides.allowExternalRuntimeRequests ?? false,
    },
  };
  if (deviceMode !== "screen") return source;
  const criticalConfigSha256 = hashProductionCriticalConfig(parseExperimentConfig(source));
  const approval = (documentId: string, contentSha256: string) => ({
    status: "GO",
    protocolVersion,
    documentId,
    documentVersion: "1.0",
    contentSha256,
    approvedOn: TODAY_IN_JAPAN,
    applicableUntil: TODAY_IN_JAPAN,
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
            reviewedOn: TODAY_IN_JAPAN,
            applicableUntil: TODAY_IN_JAPAN,
            attestationSha256: fixtureDigest("release-attestation-1"),
          },
          {
            reviewId: "RELEASE-REVIEW-002",
            reviewerCode: "REV-0002",
            reviewVersion: "1.0",
            status: "GO",
            protocolVersion,
            criticalConfigSha256,
            reviewedOn: TODAY_IN_JAPAN,
            applicableUntil: TODAY_IN_JAPAN,
            attestationSha256: fixtureDigest("release-attestation-2"),
          },
        ],
      },
    },
  };
}

function validHealthPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    status: "ok",
    appVersion: "9.8.7",
    protocolVersion: SCREEN_PROTOCOL_VERSION,
    configHash: hashExperimentConfig(parseExperimentConfig(configSource())),
    deviceMode: "screen",
    ...overrides,
  };
}

const temporaryRoots: string[] = [];

async function createConfigRoot(overrides: ConfigOverrides = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sechack-healthcheck-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "config"));
  await writeFile(
    join(root, "config", "experiment.json"),
    JSON.stringify(configSource(overrides)),
    "utf8",
  );
  return root;
}

function healthResponse(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("healthcheck argument validation", () => {
  it("uses safe defaults and accepts both option forms", () => {
    expect(parseHealthcheckArguments([])).toEqual({
      help: false,
      mockRehearsal: false,
      timeoutMs: 5_000,
    });
    expect(parseHealthcheckArguments(["--config", "config/site.json", "--timeout=1250"])).toEqual({
      help: false,
      mockRehearsal: false,
      timeoutMs: 1_250,
      configPath: "config/site.json",
    });
    expect(parseHealthcheckArguments(["--config=config/site.json", "--timeout", "60000"])).toEqual({
      help: false,
      mockRehearsal: false,
      timeoutMs: 60_000,
      configPath: "config/site.json",
    });
  });

  it("rejects missing, duplicate, unknown, fractional, and out-of-range values", () => {
    expect(() => parseHealthcheckArguments(["--config"])).toThrow("requires a value");
    expect(() => parseHealthcheckArguments(["--config=a", "--config=b"])).toThrow(
      "only be specified once",
    );
    expect(() => parseHealthcheckArguments(["--timeout"])).toThrow("requires a value");
    expect(() => parseHealthcheckArguments(["--timeout=99"])).toThrow("between 100 and 60000");
    expect(() => parseHealthcheckArguments(["--timeout=60001"])).toThrow("between 100 and 60000");
    expect(() => parseHealthcheckArguments(["--timeout=100.5"])).toThrow("integer");
    expect(() => parseHealthcheckArguments(["--timeout=not-a-number"])).toThrow("integer");
    expect(() => parseHealthcheckArguments(["--unknown"])).toThrow("Unknown option");
    expect(() => parseHealthcheckArguments(["--mock-rehearsal", "--mock-rehearsal"]))
      .toThrow("only be specified once");
    expect(parseHealthcheckArguments(["--mock-rehearsal"])).toMatchObject({
      mockRehearsal: true,
    });
  });
});

describe("healthcheck host selection", () => {
  it("checks wildcard listeners through loopback and formats IPv6 literals", () => {
    expect(healthcheckHost("0.0.0.0")).toBe("127.0.0.1");
    expect(healthcheckHost("::")).toBe("[::1]");
    expect(healthcheckHost("::1")).toBe("[::1]");
    expect(healthcheckHost("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("health payload validation", () => {
  it("returns only a matching healthy payload and uses non-caching, non-redirecting fetch", async () => {
    const root = await createConfigRoot();
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetchImplementation: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify(validHealthPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await expect(
      checkHealth({
        configPath: "config/experiment.json",
        rootDirectory: root,
        timeoutMs: 500,
        fetchImplementation,
      }),
    ).resolves.toEqual({
      url: "http://127.0.0.1:4173/healthz",
      appVersion: "9.8.7",
      protocolVersion: SCREEN_PROTOCOL_VERSION,
      configHash: hashExperimentConfig(parseExperimentConfig(configSource())),
      deviceMode: "screen",
    });
    expect(requestedUrl).toBe("http://127.0.0.1:4173/healthz");
    expect(requestedInit?.cache).toBe("no-store");
    expect(requestedInit?.redirect).toBe("error");
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts a matching screen device health payload", async () => {
    const source = configSource({ deviceMode: "screen" });
    const root = await createConfigRoot({ deviceMode: "screen" });
    await expect(checkHealth({
      configPath: "config/experiment.json",
      rootDirectory: root,
      timeoutMs: 500,
      fetchImplementation: healthResponse({
        status: "ok",
        appVersion: "9.8.7",
        protocolVersion: SCREEN_PROTOCOL_VERSION,
        configHash: hashExperimentConfig(parseExperimentConfig(source)),
        deviceMode: "screen",
      }),
    })).resolves.toMatchObject({
      protocolVersion: SCREEN_PROTOCOL_VERSION,
      deviceMode: "screen",
    });
  });

  it("rejects Serial and Mock configs unless Mock rehearsal is explicitly selected", async () => {
    const serialRoot = await createConfigRoot({ deviceMode: "serial" });
    let serialFetchCalled = false;
    await expect(checkHealth({
      configPath: "config/experiment.json",
      rootDirectory: serialRoot,
      timeoutMs: 500,
      fetchImplementation: (async () => {
        serialFetchCalled = true;
        return new Response();
      }) as typeof fetch,
    })).rejects.toThrow(/serial-device-not-allowed|production-protocol-version-not-screen/iu);
    expect(serialFetchCalled).toBe(false);

    const mockRoot = await createConfigRoot({ deviceMode: "mock" });
    await expect(checkHealth({
      configPath: "config/experiment.json",
      rootDirectory: mockRoot,
      timeoutMs: 500,
      fetchImplementation: healthResponse({}),
    })).rejects.toThrow(/Mock device mode/iu);

    const mockSource = configSource({ deviceMode: "mock" });
    await expect(checkHealth({
      configPath: "config/experiment.json",
      rootDirectory: mockRoot,
      timeoutMs: 500,
      mockRehearsal: true,
      fetchImplementation: healthResponse({
        status: "ok",
        appVersion: "9.8.7",
        protocolVersion: "health-test-v1",
        configHash: hashExperimentConfig(parseExperimentConfig(mockSource)),
        deviceMode: "mock",
      }),
    })).resolves.toMatchObject({ deviceMode: "mock" });
  });

  it("does not let --mock-rehearsal weaken a formal screen healthcheck", async () => {
    const root = await createConfigRoot();
    await expect(checkHealth({
      configPath: "config/experiment.json",
      rootDirectory: root,
      timeoutMs: 500,
      mockRehearsal: true,
      fetchImplementation: healthResponse({}),
    })).rejects.toThrow(/device\.mode/iu);
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
  ] as const)("rejects a modified production %s boundary before fetching", async (
    _label,
    overrides,
    issueCode,
  ) => {
    const root = await createConfigRoot(overrides);
    let fetchCalled = false;
    await expect(checkHealth({
      configPath: "config/experiment.json",
      rootDirectory: root,
      timeoutMs: 500,
      fetchImplementation: (async () => {
        fetchCalled = true;
        return new Response();
      }) as typeof fetch,
    })).rejects.toThrow(issueCode);
    expect(fetchCalled).toBe(false);
  });


  it.each([
    [null, "invalid response"],
    [validHealthPayload({ status: "not-ok" }), "invalid response"],
    [validHealthPayload({ appVersion: null }), "invalid response"],
    [validHealthPayload({ protocolVersion: 1 }), "invalid response"],
    [validHealthPayload({ configHash: null }), "invalid response"],
    [validHealthPayload({ deviceMode: "invalid" }), "invalid response"],
  ] as const)("rejects malformed payload %#", async (payload, expectedMessage) => {
    const root = await createConfigRoot();
    await expect(
      checkHealth({
        configPath: "config/experiment.json",
        rootDirectory: root,
        timeoutMs: 500,
        fetchImplementation: healthResponse(payload),
      }),
    ).rejects.toThrow(expectedMessage);
  });

  it("rejects non-success HTTP status", async () => {
    const root = await createConfigRoot();
    await expect(
      checkHealth({
        configPath: "config/experiment.json",
        rootDirectory: root,
        timeoutMs: 500,
        fetchImplementation: healthResponse({ error: "synthetic" }, 503),
      }),
    ).rejects.toThrow("HTTP 503");
  });

  it("rejects protocol version, config hash, and device mode mismatches", async () => {
    const root = await createConfigRoot();
    await expect(
      checkHealth({
        configPath: "config/experiment.json",
        rootDirectory: root,
        timeoutMs: 500,
        fetchImplementation: healthResponse(
          validHealthPayload({
            protocolVersion: "different-version",
          }),
        ),
      }),
    ).rejects.toThrow("protocolVersion does not match");

    await expect(
      checkHealth({
        configPath: "config/experiment.json",
        rootDirectory: root,
        timeoutMs: 500,
        fetchImplementation: healthResponse(
          validHealthPayload({
            configHash: "0".repeat(64),
          }),
        ),
      }),
    ).rejects.toThrow("config hash does not match");

    await expect(
      checkHealth({
        configPath: "config/experiment.json",
        rootDirectory: root,
        timeoutMs: 500,
        fetchImplementation: healthResponse(
          validHealthPayload({
            deviceMode: "mock",
          }),
        ),
      }),
    ).rejects.toThrow("device mode does not match");
  });

  it("aborts an unresponsive request at the configured timeout", async () => {
    const root = await createConfigRoot();
    let receivedSignal: AbortSignal | undefined;
    const fetchImplementation: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          reject(new Error("missing abort signal"));
          return;
        }
        receivedSignal = signal;
        const rejectForAbort = (): void => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
        };
        if (signal.aborted) {
          rejectForAbort();
          return;
        }
        signal.addEventListener("abort", rejectForAbort, { once: true });
      });

    const startedAt = performance.now();
    await expect(
      checkHealth({
        configPath: "config/experiment.json",
        rootDirectory: root,
        timeoutMs: 100,
        fetchImplementation,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    const elapsedMs = performance.now() - startedAt;
    expect(receivedSignal?.aborted).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(75);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("returns exit code one and a concise failure for version mismatch", async () => {
    const root = await createConfigRoot();
    const output: string[] = [];
    const exitCode = await runHealthcheck({
      args: ["--timeout", "500"],
      rootDirectory: root,
      environment: { EXPERIMENT_CONFIG_PATH: "config/experiment.json" },
      fetchImplementation: healthResponse(
        validHealthPayload({
          protocolVersion: "different-version",
        }),
      ),
      writeLine: (line) => output.push(line),
    });

    expect(exitCode).toBe(1);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("結果: FAIL");
    expect(output[0]).toContain("protocolVersion");
  });
});
