import { createServer, type Server } from "node:http";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { parseExperimentConfig } from "../../src/shared/index.js";
import { createApiApp } from "../../src/server/app.js";
import { MockPufferDevice } from "../../src/server/devices/index.js";
import type { ExperimentLogEvent, SessionLogSummary } from "../../src/server/logging/index.js";
import { SessionController } from "../../src/server/sessions/session-controller.js";
import { WebSocketHub } from "../../src/server/websocket/websocket-hub.js";

class EmptyLogger {
  public async append(event: ExperimentLogEvent): Promise<void> { void event; }
  public async exportCsv(): Promise<string> { return "sessionId\r\n"; }
  public async hasResearchId(researchId: string): Promise<boolean> { void researchId; return false; }
  public async listSessionSummaries(): Promise<readonly SessionLogSummary[]> { return []; }
}

function testConfig() {
  return parseExperimentConfig({
    schemaVersion: 1,
    protocolVersion: "test-v1",
    studyTitle: "テスト",
    bindHost: "127.0.0.1",
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
    network: { allowLan: false, allowExternalRuntimeRequests: false },
  });
}

interface RunningWebSocketTestServer {
  readonly controller: SessionController;
  readonly server: Server;
  readonly hub: WebSocketHub;
  readonly wsUrl: string;
}

async function start(operatorToken?: string): Promise<RunningWebSocketTestServer> {
  const config = testConfig();
  const controller = new SessionController({
    config,
    configHash: "0".repeat(64),
    appVersion: "1.0.0",
    device: new MockPufferDevice({ timingMode: "fast", initialConnected: true }),
    logger: new EmptyLogger(),
  });
  const app = createApiApp({ config, controller });
  const server = createServer(app);
  const hub = new WebSocketHub(server, controller, {
    ...(operatorToken === undefined ? {} : { operatorToken }),
    heartbeatTimeoutMs: 500,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not bind TCP.");
  return { controller, server, hub, wsUrl: `ws://127.0.0.1:${address.port}/ws` };
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message.")), 1_000);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as unknown);
    });
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

describe("WebSocket synchronization", () => {
  const runningServers: RunningWebSocketTestServer[] = [];

  afterEach(async () => {
    for (const running of runningServers.splice(0)) {
      running.hub.close();
      running.controller.dispose();
      await new Promise<void>((resolve) => running.server.close(() => resolve()));
    }
  });

  it("sends a participant-safe snapshot and rejects participant state changes", async () => {
    const running = await start();
    runningServers.push(running);
    const created = await running.controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    const socket = new WebSocket(`${running.wsUrl}?displayToken=${encodeURIComponent(created.displayToken)}`);
    const messagePromise = nextMessage(socket);
    await waitForOpen(socket);
    const initial = await messagePromise;
    const serialized = JSON.stringify(initial);
    expect(serialized).not.toMatch(/SH26|ABDC|conditionCode|researchId|sessionId/u);

    socket.send(JSON.stringify({ type: "display.ready" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(running.controller.getOperatorSnapshot(created.snapshot.id).displayConnected).toBe(true);

    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ type: "session.start" }));
    await expect(closed).resolves.toBe(1008);
  });

  it("requires the operator token on protected WebSocket connections", async () => {
    const running = await start("secret-token");
    runningServers.push(running);
    const denied = new WebSocket(`${running.wsUrl}?role=operator`);
    const deniedClose = waitForClose(denied);
    await expect(deniedClose).resolves.toBe(1008);

    const allowed = new WebSocket(`${running.wsUrl}?role=operator&operatorToken=secret-token`);
    await expect(waitForOpen(allowed)).resolves.toBeUndefined();
    allowed.close();
  });
});

