import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inferServerMode,
  startProductionReleaseCli,
  startServer,
  type RunningExperimentServer,
  type VerifiedProductionStartOptions,
} from "../../../src/server/index.js";
import {
  loadExperimentConfig,
  type LoadedExperimentConfig,
} from "../../../src/shared/config-loader.js";
import {
  SCREEN_PROTOCOL_VERSION,
  STUDY_FORM_URL,
} from "../../../src/shared/schemas.js";

type JsonRecord = Record<string, unknown>;

const temporaryRoots: string[] = [];
const runningServers: RunningExperimentServer[] = [];

function fakeRunningServer(): RunningExperimentServer {
  return {
    host: "127.0.0.1",
    port: 4173,
    url: "http://127.0.0.1:4173",
    operatorToken: null,
    shutdownDeadlineMs: 20_000,
    async close(): Promise<void> {},
  };
}

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object.");
  }
  return value as JsonRecord;
}

function successfulVerification(loaded: LoadedExperimentConfig) {
  return {
    errors: Object.freeze([]),
    manifestSha256: "a".repeat(64),
    sourceCommit: "b".repeat(40),
    manifest: Object.freeze({
      appVersion: "9.8.7",
      protocolVersion: loaded.config.protocolVersion,
      configHash: loaded.configHash,
      configFileHash: loaded.configFileHash,
    }),
  } as const;
}

async function reservePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a rehearsal test port.");
  }
  return address.port;
}

async function createRehearsalFixture(overrides: {
  readonly bindHost?: string;
  readonly allowLan?: boolean;
  readonly allowExternalRuntimeRequests?: boolean;
  readonly deviceMode?: "mock" | "serial" | "screen";
  readonly allowMockInProduction?: boolean;
  readonly formUrl?: string;
  readonly loggingDirectory?: string;
  readonly researchIdPattern?: string;
  readonly formAuditGo?: boolean;
} = {}): Promise<string> {
  const source = record(JSON.parse(
    await readFile(resolve("config", "experiment.e2e.json"), "utf8"),
  ) as unknown);
  const timing = record(source["timingMs"]);
  const device = record(source["device"]);
  const network = record(source["network"]);
  const logging = record(source["logging"]);
  const root = await mkdtemp(join(tmpdir(), "sechack-rehearsal-server-"));
  temporaryRoots.push(root);
  await Promise.all([
    mkdir(join(root, "config"), { recursive: true }),
    mkdir(join(root, "dist"), { recursive: true }),
  ]);
  await writeFile(
    join(root, "dist", "index.html"),
    "<!doctype html><html><body>built-rehearsal-client</body></html>",
    "utf8",
  );
  const deviceMode = overrides.deviceMode ?? "mock";
  const protocolVersion = deviceMode === "screen"
    ? SCREEN_PROTOCOL_VERSION
    : deviceMode === "serial"
      ? "serial-start-server-test-v1"
      : source["protocolVersion"];
  const formUrl = overrides.formUrl ?? "";
  const formalScreenProduction = deviceMode === "screen" && overrides.formAuditGo === true;
  await writeFile(
    join(root, "config", "rehearsal.json"),
    `${JSON.stringify({
      ...source,
      protocolVersion,
      researchIdPattern: overrides.researchIdPattern ?? "^DEMO-[0-9]{3}$",
      bindHost: overrides.bindHost ?? "127.0.0.1",
      port: await reservePort(),
      timingMs: formalScreenProduction
        ? {
            handling: 8_000,
            processing: 3_000,
            result: 15_000,
            reset: 7_000,
            inflateRamp: 6_000,
            deflateRamp: 6_000,
          }
        : {
            ...timing,
            result: 500,
            reset: 500,
            inflateRamp: 250,
            deflateRamp: 250,
          },
      device: {
        ...device,
        mode: deviceMode,
        serialPath: deviceMode === "serial" ? "COM7" : "",
        allowMockInProduction: overrides.allowMockInProduction ?? false,
      },
      formUrl,
      // Form-audit evidence is a production-release gate and deliberately
      // optional for this synthetic server-mode fixture.
      formAudit: overrides.formAuditGo === true
        ? {
            status: "GO",
            protocolVersion,
            formUrl,
            auditedOn: "2026-07-21",
            contentSha256: "a".repeat(64),
            twoPersonVerified: true,
          }
        : undefined,
      logging: {
        ...logging,
        directory: overrides.loggingDirectory ?? "./data/mock-sessions",
      },
      network: {
        ...network,
        allowLan: overrides.allowLan ?? false,
        allowExternalRuntimeRequests: overrides.allowExternalRuntimeRequests ?? false,
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("production release CLI seal", () => {
  it("verifies, loads once, binds, and starts from the same fixed config snapshot", async () => {
    const releaseRoot = resolve("synthetic-production-release");
    const entryPath = join(releaseRoot, "dist-server", "index.js");
    const events: string[] = [];
    const loaded = await loadExperimentConfig("config/experiment.e2e.json");
    let startOptions: VerifiedProductionStartOptions | undefined;
    const expectedServer = fakeRunningServer();

    const server = await startProductionReleaseCli({
      entryPath,
      environment: {},
      async verifyRelease(directory) {
        events.push("verify");
        expect(directory).toBe(releaseRoot);
        return successfulVerification(loaded);
      },
      async loadConfig(path, options) {
        events.push("load");
        expect(path).toBe("config/experiment.json");
        expect(options).toMatchObject({ rootDirectory: releaseRoot, production: true });
        return loaded;
      },
      async start(options) {
        events.push("start");
        startOptions = options;
        return expectedServer;
      },
    });

    expect(server).toBe(expectedServer);
    expect(events).toEqual(["verify", "load", "start"]);
    expect(startOptions?.rootDirectory).toBe(releaseRoot);
    expect(startOptions?.loadedConfig).toBe(loaded);
    expect(startOptions?.appVersion).toBe("9.8.7");
  });

  it("fails closed when a verifier reports success without a manifest binding", async () => {
    await expect(startProductionReleaseCli({
      entryPath: resolve("synthetic-production-release", "dist-server", "index.js"),
      environment: {},
      async verifyRelease() {
        return {
          errors: Object.freeze([]),
          manifestSha256: "a".repeat(64),
          sourceCommit: "b".repeat(40),
          manifest: null,
        };
      },
    })).rejects.toThrow(/no manifest binding/iu);
  });

  it("fails closed when the release manifest verification reports any error", async () => {
    let started = false;
    await expect(startProductionReleaseCli({
      entryPath: resolve("sealed-release", "dist-server", "index.js"),
      environment: {},
      async verifyRelease() {
        return {
          errors: Object.freeze(["SHA-256 mismatch: config/experiment.json"]),
          manifestSha256: "a".repeat(64),
          sourceCommit: "b".repeat(40),
          manifest: null,
        };
      },
      async start() {
        started = true;
        return fakeRunningServer();
      },
    })).rejects.toThrow(/Production release verification failed.*SHA-256 mismatch/iu);
    expect(started).toBe(false);
  });

  it.each([
    ["EXPERIMENT_CONFIG_PATH", { EXPERIMENT_CONFIG_PATH: "config/other.json" }],
    ["DATA_DIRECTORY", { DATA_DIRECTORY: "data/other" }],
  ] as const)("rejects the %s production environment override before verification", async (
    variableName,
    environment,
  ) => {
    let verified = false;
    let started = false;
    await expect(startProductionReleaseCli({
      entryPath: resolve("sealed-release", "dist-server", "index.js"),
      environment,
      async verifyRelease() {
        verified = true;
          return {
            errors: Object.freeze([]),
            manifestSha256: "a".repeat(64),
            sourceCommit: "b".repeat(40),
            manifest: null,
          };
      },
      async start() {
        started = true;
        return fakeRunningServer();
      },
    })).rejects.toThrow(new RegExp(variableName, "u"));
    expect(verified).toBe(false);
    expect(started).toBe(false);
  });

  it("rejects a production entry outside the fixed dist-server/index.js location", async () => {
    let verified = false;
    await expect(startProductionReleaseCli({
      entryPath: resolve("dist-server", "renamed.js"),
      environment: {},
      async verifyRelease() {
        verified = true;
        return {
          errors: Object.freeze([]),
          manifestSha256: "a".repeat(64),
          sourceCommit: "b".repeat(40),
          manifest: null,
        };
      },
    })).rejects.toThrow(/must run as dist-server\/index\.js/iu);
    expect(verified).toBe(false);
  });

  it("rejects an unpackaged compiled entry when no deployment manifest exists", async () => {
    const releaseRoot = await mkdtemp(join(tmpdir(), "sechack-unsealed-production-"));
    temporaryRoots.push(releaseRoot);
    await mkdir(join(releaseRoot, "dist-server"), { recursive: true });

    await expect(startProductionReleaseCli({
      entryPath: join(releaseRoot, "dist-server", "index.js"),
      environment: {},
      async start() {
        return fakeRunningServer();
      },
    })).rejects.toThrow(/Production release verification failed.*manifest/iu);
  });

  it.each(["configFileHash", "configHash", "protocolVersion"] as const)(
    "rejects a loaded config whose %s differs from the verified manifest",
    async (field) => {
      const loaded = await loadExperimentConfig("config/experiment.e2e.json");
      const verified = successfulVerification(loaded);
      const manifest = {
        ...verified.manifest,
        [field]: field === "protocolVersion" ? "different-protocol" : "0".repeat(64),
      };
      let started = false;

      await expect(startProductionReleaseCli({
        entryPath: resolve("synthetic-production-release", "dist-server", "index.js"),
        environment: {},
        async verifyRelease() {
          return { ...verified, manifest };
        },
        async loadConfig() {
          return loaded;
        },
        async start() {
          started = true;
          return fakeRunningServer();
        },
      })).rejects.toThrow(new RegExp(field, "u"));
      expect(started).toBe(false);
    },
  );
});

describe("startServer production safeguards", () => {
  it("rejects direct production startup before trusting the default Mock config", async () => {
    const root = await createRehearsalFixture();
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "production",
    })).rejects.toThrow(/verified sealed release CLI/iu);
  });

  it("rejects direct production even when a Mock config attempts to opt in", async () => {
    const root = await createRehearsalFixture({ allowMockInProduction: true });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "production",
    })).rejects.toThrow(/verified sealed release CLI/iu);
  });

  it("rejects direct Serial production before reading its self-asserted audit evidence", async () => {
    const root = await createRehearsalFixture({ deviceMode: "serial" });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "production",
    })).rejects.toThrow(/verified sealed release CLI/iu);
  });

  it("rejects a direct formal-looking screen config without a verified release capability", async () => {
    const root = await createRehearsalFixture({
      deviceMode: "screen",
      formUrl: STUDY_FORM_URL,
      formAuditGo: true,
      loggingDirectory: "./data/sessions",
      researchIdPattern: "^SH26-[0-9]{3}$",
    });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "production",
    })).rejects.toThrow(/verified sealed release CLI/iu);
  });

  it("rejects a formal Google Form and GO evidence in nonparticipant test mode", async () => {
    const root = await createRehearsalFixture({
      deviceMode: "screen",
      formUrl: STUDY_FORM_URL,
      formAuditGo: true,
      loggingDirectory: "./data/sessions",
      researchIdPattern: "^SH26-[0-9]{3}$",
    });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "test",
      serveBuiltAssets: true,
    })).rejects.toThrow(/Test mode prohibits a real Google Form destination/iu);
  });

  it("rejects a production log-directory override in test mode", async () => {
    const root = await createRehearsalFixture();
    const previousDataDirectory = process.env.DATA_DIRECTORY;
    process.env.DATA_DIRECTORY = "./data/sessions";
    try {
      await expect(startServer({
        rootDirectory: root,
        configPath: "config/rehearsal.json",
        mode: "test",
      })).rejects.toThrow(/prohibits overriding its isolated test log directory/iu);
    } finally {
      if (previousDataDirectory === undefined) delete process.env.DATA_DIRECTORY;
      else process.env.DATA_DIRECTORY = previousDataDirectory;
    }
  });

  it("rejects the formal participant ID namespace in test mode", async () => {
    const root = await createRehearsalFixture({ researchIdPattern: "^SH26-[0-9]{3}$" });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "test",
    })).rejects.toThrow(/TEST-001 or DEMO-001 research ID format/iu);
  });

  it("rejects the Serial adapter in test mode", async () => {
    const root = await createRehearsalFixture({ deviceMode: "serial" });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "test",
    })).rejects.toThrow(/Test mode prohibits the Serial device adapter/iu);
  });

  it("rejects self-asserted GO form evidence in test mode", async () => {
    const root = await createRehearsalFixture({
      deviceMode: "screen",
      formUrl: "https://docs.google.com/forms/d/e/TEST_FORM_ID/viewform",
      formAuditGo: true,
    });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "test",
    })).rejects.toThrow(/Test mode prohibits GO form-audit evidence/iu);
  });

  it("rejects a production log directory in test-mode configuration", async () => {
    const root = await createRehearsalFixture({ loggingDirectory: "./data/sessions" });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "test",
    })).rejects.toThrow(/Test mode requires an isolated test log directory/iu);
  });

  it("rejects LAN and external-runtime configurations in test mode", async () => {
    const lanRoot = await createRehearsalFixture({ bindHost: "0.0.0.0", allowLan: true });
    await expect(startServer({
      rootDirectory: lanRoot,
      configPath: "config/rehearsal.json",
      mode: "test",
    })).rejects.toThrow(/Test mode must bind to a loopback host/iu);

    const externalRoot = await createRehearsalFixture({ allowExternalRuntimeRequests: true });
    await expect(startServer({
      rootDirectory: externalRoot,
      configPath: "config/rehearsal.json",
      mode: "test",
    })).rejects.toThrow(/External runtime requests are prohibited/iu);
  });

  it("treats a compiled entry as production even when NODE_ENV is test", () => {
    expect(inferServerMode(resolve("dist-server", "index.js"))).toBe("production");
    expect(inferServerMode(resolve("src", "server", "index.ts"))).toBe("development");
  });

  it.each(["screen", "serial"] as const)(
    "rejects a %s adapter in development before it can bypass production gates",
    async (deviceMode) => {
      const root = await createRehearsalFixture({
        deviceMode,
        ...(deviceMode === "screen"
          ? {
              formUrl: STUDY_FORM_URL,
              formAuditGo: true,
              loggingDirectory: "./data/sessions",
              researchIdPattern: "^SH26-[0-9]{3}$",
            }
          : {}),
      });

      await expect(startServer({
        rootDirectory: root,
        configPath: "config/rehearsal.json",
        mode: "development",
      })).rejects.toThrow(/Development mode requires the Mock device adapter/iu);
    },
  );

  it("keeps a valid source development runtime visibly nonparticipant", async () => {
    const root = await createRehearsalFixture({
      researchIdPattern: "^DEV-[0-9]{3}$",
      loggingDirectory: "./data/dev-sessions",
    });
    const server = await startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "development",
    });
    runningServers.push(server);

    const operatorConfig = await fetch(`${server.url}/api/operator/config`);
    await expect(operatorConfig.json()).resolves.toMatchObject({
      researchIdPattern: "^DEV-[0-9]{3}$",
      rehearsal: true,
    });
    const created = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        researchId: "DEV-001",
        consentConfirmed: true,
        orderCode: "ABDC",
      }),
    });
    expect(created.status).toBe(201);
    const payload = record(await created.json());
    expect(record(payload["snapshot"])["rehearsal"]).toBe(true);
    expect(record(payload["snapshot"])["formUrl"]).toBeNull();
  });

  it("rejects a real form, formal ID, and production log path in development mode", async () => {
    const formRoot = await createRehearsalFixture({
      formUrl: STUDY_FORM_URL,
      researchIdPattern: "^DEV-[0-9]{3}$",
      loggingDirectory: "./data/dev-sessions",
    });
    await expect(startServer({
      rootDirectory: formRoot,
      configPath: "config/rehearsal.json",
      mode: "development",
    })).rejects.toThrow(/Development mode prohibits a Google Form destination/iu);

    const idRoot = await createRehearsalFixture({
      researchIdPattern: "^SH26-[0-9]{3}$",
      loggingDirectory: "./data/dev-sessions",
    });
    await expect(startServer({
      rootDirectory: idRoot,
      configPath: "config/rehearsal.json",
      mode: "development",
    })).rejects.toThrow(/Development mode requires the DEV-001 research ID format/iu);

    const logRoot = await createRehearsalFixture({
      researchIdPattern: "^DEV-[0-9]{3}$",
      loggingDirectory: "./data/sessions",
    });
    await expect(startServer({
      rootDirectory: logRoot,
      configPath: "config/rehearsal.json",
      mode: "development",
    })).rejects.toThrow(/isolated data\/dev-sessions log directory/iu);
  });

  it("rejects LAN and GO audit evidence in development mode", async () => {
    const lanRoot = await createRehearsalFixture({
      bindHost: "0.0.0.0",
      allowLan: true,
      researchIdPattern: "^DEV-[0-9]{3}$",
      loggingDirectory: "./data/dev-sessions",
    });
    await expect(startServer({
      rootDirectory: lanRoot,
      configPath: "config/rehearsal.json",
      mode: "development",
    })).rejects.toThrow(/Development mode must bind to a loopback host/iu);

    const auditRoot = await createRehearsalFixture({
      formAuditGo: true,
      researchIdPattern: "^DEV-[0-9]{3}$",
      loggingDirectory: "./data/dev-sessions",
    });
    await expect(startServer({
      rootDirectory: auditRoot,
      configPath: "config/rehearsal.json",
      mode: "development",
    })).rejects.toThrow(/Development mode prohibits GO form-audit evidence/iu);
  });

  it.each(["test", "production"])(
    "does not let NODE_ENV=%s change a direct source start out of development mode",
    async (nodeEnvironment) => {
      const root = await createRehearsalFixture({
        deviceMode: "screen",
        formUrl: STUDY_FORM_URL,
        formAuditGo: true,
        loggingDirectory: "./data/sessions",
        researchIdPattern: "^SH26-[0-9]{3}$",
      });
      const previousNodeEnvironment = process.env.NODE_ENV;
      process.env.NODE_ENV = nodeEnvironment;
      try {
        await expect(startServer({
          rootDirectory: root,
          configPath: "config/rehearsal.json",
        })).rejects.toThrow(/Development mode requires the Mock device adapter/iu);
      } finally {
        if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnvironment;
      }
    },
  );

  it("shares one safe shutdown operation across repeated close calls", async () => {
    const root = await createRehearsalFixture();
    const server = await startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "test",
    });
    const firstClose = server.close();
    expect(server.close()).toBe(firstClose);
    await firstClose;
  });

  it("serves built assets, auto-connects Mock, and keeps real-time motion in rehearsal", async () => {
    const root = await createRehearsalFixture();
    const server = await startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "rehearsal",
    });
    runningServers.push(server);
    expect(server.host).toBe("127.0.0.1");
    expect(server.operatorToken).toBeNull();

    const operator = await fetch(`${server.url}/operator`);
    expect(operator.status).toBe(200);
    expect(operator.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(operator.headers.get("x-dns-prefetch-control")).toBe("off");
    await expect(operator.text()).resolves.toContain("built-rehearsal-client");

    const initialStatus = await fetch(`${server.url}/api/device/status`);
    expect(initialStatus.status).toBe(200);
    await expect(initialStatus.json()).resolves.toMatchObject({
      status: { connected: true, state: "idle", level: 0, fault: null, mode: "mock" },
    });

    const inflate = await fetch(`${server.url}/api/device/inflate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(inflate.status).toBe(200);
    await expect(inflate.json()).resolves.toMatchObject({
      status: { connected: true, state: "inflating", mode: "mock" },
      ack: { ok: true, state: "inflating" },
    });
  });

  it("rejects a serial adapter in rehearsal without weakening production selection", async () => {
    const root = await createRehearsalFixture({ deviceMode: "serial" });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "rehearsal",
    })).rejects.toThrow(/Rehearsal mode requires the Mock device adapter/iu);

    expect(inferServerMode(resolve("dist-server", "index.js"))).toBe("production");
  });

  it("keeps rehearsal Mock-only when the formal screen adapter is configured", async () => {
    const root = await createRehearsalFixture({ deviceMode: "screen" });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "rehearsal",
    })).rejects.toThrow(/Rehearsal mode requires the Mock device adapter/iu);
  });

  it("rejects LAN and external-runtime configurations in rehearsal", async () => {
    const lanRoot = await createRehearsalFixture({ bindHost: "0.0.0.0", allowLan: true });
    await expect(startServer({
      rootDirectory: lanRoot,
      configPath: "config/rehearsal.json",
      mode: "rehearsal",
    })).rejects.toThrow(/Rehearsal mode prohibits LAN access/iu);

    const externalRoot = await createRehearsalFixture({ allowExternalRuntimeRequests: true });
    await expect(startServer({
      rootDirectory: externalRoot,
      configPath: "config/rehearsal.json",
      mode: "rehearsal",
    })).rejects.toThrow(/External runtime requests are prohibited/iu);
  });

  it("rejects form destinations and non-isolated log directories in rehearsal", async () => {
    const formRoot = await createRehearsalFixture({
      formUrl: "https://forms.gle/BeShY7cY5zMjunto9",
    });
    await expect(startServer({
      rootDirectory: formRoot,
      configPath: "config/rehearsal.json",
      mode: "rehearsal",
    })).rejects.toThrow(/prohibits a Google Form destination/iu);

    const logRoot = await createRehearsalFixture({ loggingDirectory: "./data/sessions" });
    await expect(startServer({
      rootDirectory: logRoot,
      configPath: "config/rehearsal.json",
      mode: "rehearsal",
    })).rejects.toThrow(/isolated data\/mock-sessions log directory/iu);

    const idRoot = await createRehearsalFixture({ researchIdPattern: "^SH26-[0-9]{3}$" });
    await expect(startServer({
      rootDirectory: idRoot,
      configPath: "config/rehearsal.json",
      mode: "rehearsal",
    })).rejects.toThrow(/DEMO-001 research ID format/iu);
  });
});
