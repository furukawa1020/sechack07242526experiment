import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { parseExperimentConfig } from "../../src/shared/index.js";
import { createApiApp } from "../../src/server/app.js";
import { MockPufferDevice } from "../../src/server/devices/index.js";
import type { ExperimentLogEvent, SessionLogSummary } from "../../src/server/logging/index.js";
import { SessionController } from "../../src/server/sessions/session-controller.js";

class EmptyLogger {
  public async append(event: ExperimentLogEvent): Promise<void> { void event; }
  public async exportCsv(): Promise<string> { return "sessionId\r\n"; }
  public async hasResearchId(researchId: string): Promise<boolean> { void researchId; return false; }
  public async listSessionSummaries(): Promise<readonly SessionLogSummary[]> { return []; }
}

function config(allowLan = false) {
  return parseExperimentConfig({
    schemaVersion: 1,
    protocolVersion: "test-v1",
    studyTitle: "テスト",
    bindHost: allowLan ? "0.0.0.0" : "127.0.0.1",
    port: 4173,
    researchIdPattern: "^SH26-[0-9]{3}$",
    orders: ["ABDC", "BCAD", "CDBA", "DACB"],
    fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
    timingMs: {
      handling: 10,
      processing: 10,
      result: 10,
      reset: 10,
      inflateRamp: 1,
      deflateRamp: 1,
    },
    device: {
      mode: "mock",
      serialPath: "",
      baudRate: 115200,
      ackTimeout: 100,
      allowMockInProduction: false,
    },
    formUrl: "",
    logging: { directory: "./data/test", includeAbortedInOrderBalancing: true },
    network: { allowLan, allowExternalRuntimeRequests: false },
  });
}

async function listen(allowLan = false, operatorToken?: string) {
  const parsedConfig = config(allowLan);
  const controller = new SessionController({
    config: parsedConfig,
    configHash: "0".repeat(64),
    appVersion: "1.0.0",
    rehearsal: false,
    device: new MockPufferDevice({ timingMode: "fast", initialConnected: true }),
    logger: new EmptyLogger(),
  });
  const app = createApiApp({
    config: parsedConfig,
    controller,
    configHash: "a".repeat(64),
    appVersion: "1.0.0",
    mode: "test",
    ...(operatorToken === undefined ? {} : { operatorToken }),
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not bind TCP.");
  return { controller, server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("server HTTP security", () => {
  const servers: Server[] = [];
  const controllers: SessionController[] = [];

  afterEach(async () => {
    controllers.splice(0).forEach((controller) => controller.dispose());
    await Promise.all(servers.splice(0).map(close));
  });

  it("serves healthz with a restrictive CSP and never opens CORS", async () => {
    const running = await listen();
    servers.push(running.server);
    controllers.push(running.controller);
    const response = await fetch(`${running.url}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      appVersion: "1.0.0",
      protocolVersion: "test-v1",
      configHash: "a".repeat(64),
      deviceMode: "mock",
    });
    expect(response.headers.get("content-security-policy")).not.toContain("ws:");
  });

  it("rejects cross-origin requests and invalid JSON input", async () => {
    const running = await listen();
    servers.push(running.server);
    controllers.push(running.controller);
    const crossOrigin = await fetch(`${running.url}/api/device/status`, {
      headers: { Origin: "https://example.invalid" },
    });
    expect(crossOrigin.status).toBe(403);

    const invalid = await fetch(`${running.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ researchId: "not-an-id", consentConfirmed: false, extra: "forbidden" }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "入力内容が正しくありません。", code: "INVALID_INPUT" });

    const invalidResearchId = await fetch(`${running.url}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ researchId: "bad", consentConfirmed: true, orderCode: "ABDC" }),
    });
    expect(invalidResearchId.status).toBe(400);
    await expect(invalidResearchId.json()).resolves.toEqual({
      error: "研究用IDの形式が正しくありません。",
      code: "INVALID_RESEARCH_ID",
    });

    const unavailableTestHook = await fetch(`${running.url}/api/test/mock-device/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "inflate" }),
    });
    expect(unavailableTestHook.status).toBe(404);
    await expect(unavailableTestHook.json()).resolves.toEqual({
      error: "APIが見つかりません。",
      code: "API_NOT_FOUND",
    });
  });

  it("refuses test-only device hooks outside explicit test mode", () => {
    const parsedConfig = config();
    const controller = new SessionController({
      config: parsedConfig,
      configHash: "0".repeat(64),
      appVersion: "1.0.0",
      rehearsal: false,
      device: new MockPufferDevice({ timingMode: "fast", initialConnected: true }),
      logger: new EmptyLogger(),
    });
    controllers.push(controller);
    const testHooks = {
      injectUnexpectedMockDisconnect(): void {},
      readMockDeviceCommands(): readonly string[] { return []; },
    };

    for (const mode of ["development", "production", "rehearsal"] as const) {
      expect(() => createApiApp({
        config: parsedConfig,
        controller,
        configHash: "a".repeat(64),
        appVersion: "1.0.0",
        mode,
        testHooks,
      })).toThrow("API test hooks are available only in explicit test mode.");
    }
  });

  it("requires the random operator token on LAN operator APIs", async () => {
    const running = await listen(true, "test-operator-token");
    servers.push(running.server);
    controllers.push(running.controller);
    const denied = await fetch(`${running.url}/api/device/status`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${running.url}/api/device/status`, {
      headers: { "X-Operator-Token": "test-operator-token" },
    });
    expect(allowed.status).toBe(200);
    const configDenied = await fetch(`${running.url}/api/operator/config`);
    expect(configDenied.status).toBe(401);
  });

  it("serves the authoritative research-ID pattern and exact device ACK without caching", async () => {
    const running = await listen();
    servers.push(running.server);
    controllers.push(running.controller);

    const operatorConfig = await fetch(`${running.url}/api/operator/config`);
    expect(operatorConfig.status).toBe(200);
    expect(operatorConfig.headers.get("cache-control")).toBe("no-store");
    await expect(operatorConfig.json()).resolves.toEqual({
      researchIdPattern: "^SH26-[0-9]{3}$",
      protocolVersion: "test-v1",
    });

    const inflate = await fetch(`${running.url}/api/device/inflate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(inflate.status).toBe(200);
    const payload = await inflate.json() as {
      readonly status: { readonly mode: string };
      readonly ack: { readonly requestId: string; readonly ok: boolean; readonly state: string };
    };
    expect(payload.status.mode).toBe("mock");
    expect(payload.ack).toMatchObject({ ok: true, state: "inflating" });
    expect(payload.ack.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
