import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inferServerMode,
  startServer,
  type RunningExperimentServer,
} from "../../../src/server/index.js";

type JsonRecord = Record<string, unknown>;

const temporaryRoots: string[] = [];
const runningServers: RunningExperimentServer[] = [];

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
  readonly deviceMode?: "mock" | "serial";
  readonly allowMockInProduction?: boolean;
  readonly formUrl?: string;
  readonly loggingDirectory?: string;
  readonly researchIdPattern?: string;
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
  await writeFile(
    join(root, "config", "rehearsal.json"),
    `${JSON.stringify({
      ...source,
      researchIdPattern: overrides.researchIdPattern ?? "^DEMO-[0-9]{3}$",
      bindHost: overrides.bindHost ?? "127.0.0.1",
      port: await reservePort(),
      timingMs: {
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
      formUrl: overrides.formUrl ?? "",
      // Form-audit evidence is a production-release gate and deliberately
      // optional for this synthetic server-mode fixture.
      formAudit: undefined,
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

  it("rejects Serial production startup when form-audit GO evidence is missing", async () => {
    const root = await createRehearsalFixture({ deviceMode: "serial" });
    await expect(startServer({
      rootDirectory: root,
      configPath: "config/rehearsal.json",
      mode: "production",
    })).rejects.toThrow(/Google Form audit gate.*missing/iu);
  });

  it("treats a compiled entry as production even when NODE_ENV is test", () => {
    expect(inferServerMode(resolve("dist-server", "index.js"), "test")).toBe("production");
    expect(inferServerMode(resolve("src", "server", "index.ts"), "test")).toBe("test");
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
