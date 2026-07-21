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
  type StartServerOptions,
} from "../../../src/server/index.js";
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
  it("verifies its own release root before starting the fixed packaged config", async () => {
    const releaseRoot = resolve("synthetic-production-release");
    const entryPath = join(releaseRoot, "dist-server", "index.js");
    const events: string[] = [];
    let startOptions: StartServerOptions | undefined;
    const expectedServer = fakeRunningServer();

    const server = await startProductionReleaseCli({
      entryPath,
      environment: {},
      async verifyRelease(directory) {
        events.push("verify");
        expect(directory).toBe(releaseRoot);
        return {
          errors: Object.freeze([]),
          manifestSha256: "a".repeat(64),
          sourceCommit: "b".repeat(40),
        };
      },
      async start(options) {
        events.push("start");
        startOptions = options;
        return expectedServer;
      },
    });

    expect(server).toBe(expectedServer);
    expect(events).toEqual(["verify", "start"]);
    expect(startOptions).toEqual({
      rootDirectory: releaseRoot,
      configPath: "config/experiment.json",
      mode: "production",
    });
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
});

describe("startServer production safeguards", () => {
  it("rejects the default MockDevice config whenever production mode is selected", async () => {
    const root = await createRehearsalFixture();
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "production",
    })).rejects.toThrow(/Mock device mode is unconditionally disabled in production/iu);
  });

  it("rejects production Mock mode even when a config attempts to opt in", async () => {
    const root = await createRehearsalFixture({ allowMockInProduction: true });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "production",
    })).rejects.toThrow(/unconditionally disabled/iu);
  });

  it("rejects Serial production startup before evaluating form-audit evidence", async () => {
    const root = await createRehearsalFixture({ deviceMode: "serial" });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "production",
    })).rejects.toThrow(/Production device policy.*serial-device-not-allowed/iu);
  });

  it("starts formal screen production without Serial hardware and auto-connects safely", async () => {
    const root = await createRehearsalFixture({
      deviceMode: "screen",
      formUrl: STUDY_FORM_URL,
      formAuditGo: true,
      loggingDirectory: "./data/sessions",
      researchIdPattern: "^SH26-[0-9]{3}$",
    });
    const server = await startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "production",
    });
    runningServers.push(server);

    const health = await fetch(`${server.url}/healthz`);
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      protocolVersion: SCREEN_PROTOCOL_VERSION,
      deviceMode: "screen",
    });
    const deviceStatus = await fetch(`${server.url}/api/device/status`);
    await expect(deviceStatus.json()).resolves.toMatchObject({
      status: { connected: true, state: "idle", level: 0, fault: null, mode: "screen" },
    });
  });

  it("treats a compiled entry as production even when NODE_ENV is test", () => {
    expect(inferServerMode(resolve("dist-server", "index.js"), "test")).toBe("production");
    expect(inferServerMode(resolve("src", "server", "index.ts"), "test"))
      .toBe("development");
    expect(inferServerMode(resolve("src", "server", "index.ts"), "production"))
      .toBe("production");
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

  it("does not let NODE_ENV=test turn a direct source start into test mode", async () => {
    const root = await createRehearsalFixture({
      deviceMode: "screen",
      formUrl: STUDY_FORM_URL,
      formAuditGo: true,
      loggingDirectory: "./data/sessions",
      researchIdPattern: "^SH26-[0-9]{3}$",
    });
    const previousNodeEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      await expect(startServer({
        rootDirectory: root,
        configPath: "config/rehearsal.json",
      })).rejects.toThrow(/Development mode requires the Mock device adapter/iu);
    } finally {
      if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnvironment;
    }
  });

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

    expect(inferServerMode(resolve("dist-server", "index.js"), "development"))
      .toBe("production");
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
