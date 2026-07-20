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
import { hashExperimentConfig } from "../../../src/shared/config-loader.js";
import { parseExperimentConfig } from "../../../src/shared/schemas.js";

interface ConfigOverrides {
  readonly bindHost?: string;
  readonly allowLan?: boolean;
  readonly deviceMode?: "mock" | "serial";
  readonly protocolVersion?: string;
}

function configSource(overrides: ConfigOverrides = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocolVersion: overrides.protocolVersion ?? "health-test-v1",
    studyTitle: "ヘルスチェック合成設定",
    bindHost: overrides.bindHost ?? "127.0.0.1",
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
      mode: overrides.deviceMode ?? "serial",
      serialPath: overrides.deviceMode === "mock" ? "" : "COM3",
      baudRate: 115_200,
      ackTimeout: 1_000,
      allowMockInProduction: false,
    },
    formUrl: "https://docs.google.com/forms/d/example/viewform",
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: {
      allowLan: overrides.allowLan ?? false,
      allowExternalRuntimeRequests: false,
    },
  };
}

function validHealthPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    status: "ok",
    appVersion: "9.8.7",
    protocolVersion: "health-test-v1",
    configHash: hashExperimentConfig(parseExperimentConfig(configSource())),
    deviceMode: "serial",
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
      timeoutMs: 5_000,
    });
    expect(parseHealthcheckArguments(["--config", "config/site.json", "--timeout=1250"])).toEqual({
      help: false,
      timeoutMs: 1_250,
      configPath: "config/site.json",
    });
    expect(parseHealthcheckArguments(["--config=config/site.json", "--timeout", "60000"])).toEqual({
      help: false,
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
      protocolVersion: "health-test-v1",
      configHash: hashExperimentConfig(parseExperimentConfig(configSource())),
      deviceMode: "serial",
    });
    expect(requestedUrl).toBe("http://127.0.0.1:4173/healthz");
    expect(requestedInit?.cache).toBe("no-store");
    expect(requestedInit?.redirect).toBe("error");
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal);
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
