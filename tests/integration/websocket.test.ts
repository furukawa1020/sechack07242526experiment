import { createServer, type Server } from "node:http";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseExperimentConfig } from "../../src/shared/index.js";
import { createApiApp } from "../../src/server/app.js";
import { MockPufferDevice } from "../../src/server/devices/index.js";
import type {
  ExperimentLogEvent,
  ResearchIdReservationInput,
  SessionLogSummary,
} from "../../src/server/logging/index.js";
import { SessionController } from "../../src/server/sessions/session-controller.js";
import { WebSocketHub } from "../../src/server/websocket/websocket-hub.js";

class EmptyLogger {
  public async append(event: ExperimentLogEvent): Promise<void> { void event; }
  public async exportCsv(): Promise<string> { return "sessionId\r\n"; }
  public async hasResearchId(researchId: string): Promise<boolean> { void researchId; return false; }
  public async reserveResearchId(input: ResearchIdReservationInput): Promise<boolean> { void input; return true; }
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
      handling: 100,
      processing: 100,
      result: 500,
      reset: 100,
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
  readonly device: MockPufferDevice;
  readonly server: Server;
  readonly hub: WebSocketHub;
  readonly wsUrl: string;
}

async function start(
  operatorToken?: string,
  heartbeat: { readonly timeoutMs?: number; readonly checkIntervalMs?: number } = {},
): Promise<RunningWebSocketTestServer> {
  const config = testConfig();
  const device = new MockPufferDevice({ timingMode: "fast", initialConnected: true });
  const controller = new SessionController({
    config,
    configHash: "0".repeat(64),
    appVersion: "1.0.0",
    rehearsal: false,
    device,
    logger: new EmptyLogger(),
  });
  const app = createApiApp({
    config,
    controller,
    configHash: "a".repeat(64),
    appVersion: "1.0.0",
    mode: "test",
  });
  const server = createServer(app);
  const hub = new WebSocketHub(server, controller, {
    ...(operatorToken === undefined ? {} : { operatorToken }),
    heartbeatTimeoutMs: heartbeat.timeoutMs ?? 500,
    heartbeatCheckIntervalMs: heartbeat.checkIntervalMs ?? 25,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not bind TCP.");
  return { controller, device, server, hub, wsUrl: `ws://127.0.0.1:${address.port}/ws` };
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

function nextMessageOfType(socket: WebSocket, expectedType: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for WebSocket message ${expectedType}.`)),
      1_000,
    );
    const listener = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString()) as unknown;
      if (
        typeof message !== "object"
        || message === null
        || Array.isArray(message)
        || (message as Record<string, unknown>)["type"] !== expectedType
      ) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
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

interface MaintainedOperatorLease {
  readonly confirmed: Promise<void>;
  readonly stop: () => void;
}

function maintainOperatorLease(socket: WebSocket): MaintainedOperatorLease {
  let confirmed = false;
  let resolveConfirmed: (() => void) | undefined;
  let rejectConfirmed: ((error: Error) => void) | undefined;
  const confirmation = new Promise<void>((resolve, reject) => {
    resolveConfirmed = resolve;
    rejectConfirmed = reject;
  });
  const timeout = setTimeout(() => {
    rejectConfirmed?.(new Error("Timed out waiting for Operator lease confirmation."));
  }, 2_000);
  const listener = (data: WebSocket.RawData): void => {
    let message: unknown;
    try {
      message = JSON.parse(data.toString()) as unknown;
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    if (record["type"] === "operator.heartbeatAck") {
      if (!confirmed) {
        confirmed = true;
        clearTimeout(timeout);
        resolveConfirmed?.();
      }
      return;
    }
    if (record["type"] !== "operator.heartbeatChallenge") return;
    const payload = record["payload"];
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const nonce = (payload as Record<string, unknown>)["nonce"];
    if (typeof nonce !== "string" || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "operator.heartbeat", payload: { nonce } }));
  };
  socket.on("message", listener);
  return {
    confirmed: confirmation,
    stop(): void {
      socket.off("message", listener);
      clearTimeout(timeout);
    },
  };
}

async function connectOperator(wsUrl: string): Promise<{
  readonly socket: WebSocket;
  readonly lease: MaintainedOperatorLease;
}> {
  const socket = new WebSocket(`${wsUrl}?role=operator`);
  const lease = maintainOperatorLease(socket);
  await Promise.all([waitForOpen(socket), lease.confirmed]);
  return { socket, lease };
}

async function expectNoMessage(socket: WebSocket, waitMs = 25): Promise<void> {
  const received: unknown[] = [];
  const listener = (data: WebSocket.RawData): void => {
    received.push(JSON.parse(data.toString()) as unknown);
  };
  socket.on("message", listener);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  socket.off("message", listener);
  expect(received).toEqual([]);
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

  it("sends a participant-safe snapshot only after ready and rejects participant state changes", async () => {
    const running = await start();
    runningServers.push(running);
    const created = await running.controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    const socket = new WebSocket(`${running.wsUrl}?displayToken=${encodeURIComponent(created.displayToken)}`);
    await waitForOpen(socket);
    await expectNoMessage(socket);
    expect(running.controller.getOperatorSnapshot(created.snapshot.id).displayConnected).toBe(false);

    const messagePromise = nextMessage(socket);
    socket.send(JSON.stringify({ type: "display.ready" }));
    const initial = await messagePromise;
    const serialized = JSON.stringify(initial);
    expect(serialized).not.toMatch(/SH26|ABDC|conditionCode|researchId|sessionId/u);

    await vi.waitFor(() => {
      expect(running.controller.getOperatorSnapshot(created.snapshot.id).displayConnected).toBe(true);
    });
    socket.send(JSON.stringify({ type: "display.fullscreenState", payload: { fullscreen: true } }));
    await vi.waitFor(() => {
      expect(running.controller.getOperatorSnapshot(created.snapshot.id).displayFullscreen).toBe(true);
    });

    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ type: "session.start" }));
    await expect(closed).resolves.toBe(1008);
    await vi.waitFor(() => {
      expect(running.controller.getOperatorSnapshot(created.snapshot.id).displayConnected).toBe(false);
    });
  });

  it.each([
    ["heartbeat", { type: "display.heartbeat" }],
    ["fullscreen", { type: "display.fullscreenState", payload: { fullscreen: true } }],
  ] as const)("rejects %s before ready without marking the display connected", async (_name, message) => {
    const running = await start();
    runningServers.push(running);
    const created = await running.controller.create({
      researchId: "SH26-005",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    const socket = new WebSocket(`${running.wsUrl}?displayToken=${encodeURIComponent(created.displayToken)}`);
    await waitForOpen(socket);
    await expectNoMessage(socket);

    const closed = waitForClose(socket);
    socket.send(JSON.stringify(message));
    await expect(closed).resolves.toBe(1008);
    expect(running.controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      displayConnected: false,
      displayFullscreen: null,
    });
  });

  it("does not expose an active puffer snapshot to a duplicate display lease", async () => {
    const running = await start();
    runningServers.push(running);
    const operator = await connectOperator(running.wsUrl);
    const created = await running.controller.create({
      researchId: "SH26-006",
      consentConfirmed: true,
      orderCode: "CDBA",
    });
    const primary = new WebSocket(`${running.wsUrl}?displayToken=${encodeURIComponent(created.displayToken)}`);
    await waitForOpen(primary);
    const primarySnapshot = nextMessage(primary);
    primary.send(JSON.stringify({ type: "display.ready" }));
    await primarySnapshot;
    await running.controller.prepare(created.snapshot.id);
    await running.controller.start(created.snapshot.id);
    await vi.waitFor(() => {
      expect(running.controller.getOperatorSnapshot(created.snapshot.id).phase).toBe("result");
    }, { timeout: 1_000 });

    const duplicate = new WebSocket(`${running.wsUrl}?displayToken=${encodeURIComponent(created.displayToken)}`);
    await waitForOpen(duplicate);
    await expectNoMessage(duplicate);
    const duplicateMessages: unknown[] = [];
    duplicate.on("message", (data) => duplicateMessages.push(JSON.parse(data.toString()) as unknown));
    const closed = waitForClose(duplicate);
    duplicate.send(JSON.stringify({ type: "display.ready" }));
    await expect(closed).resolves.toBe(1008);
    expect(duplicateMessages).toEqual([]);
    expect(running.controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "result",
      displayConnected: true,
    });
    await running.controller.abort(created.snapshot.id);
    operator.lease.stop();
    operator.socket.close();
    primary.close();
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

  it("confirms a round-trip Operator lease and still requires REST for state changes", async () => {
    const running = await start(undefined, { timeoutMs: 100, checkIntervalMs: 10 });
    runningServers.push(running);
    const operator = await connectOperator(running.wsUrl);

    const protocolError = nextMessageOfType(operator.socket, "protocol.error");
    operator.socket.send(JSON.stringify({ type: "session.start" }));
    await expect(protocolError).resolves.toEqual({
      type: "protocol.error",
      payload: { code: "REST_REQUIRED" },
    });
    operator.lease.stop();
    operator.socket.close();
  });

  it("blocks prepare after the final Operator lease expires during setup", async () => {
    const running = await start(undefined, { timeoutMs: 100, checkIntervalMs: 10 });
    runningServers.push(running);
    const operator = await connectOperator(running.wsUrl);
    const created = await running.controller.create({
      researchId: "SH26-009",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    running.controller.markDisplayReady(created.displayToken, "manual-display");

    operator.lease.stop();
    const closed = waitForClose(operator.socket);
    await expect(closed).resolves.toBe(1006);
    await expect(running.controller.prepare(created.snapshot.id)).rejects.toMatchObject({
      code: "OPERATOR_CONNECTION_REQUIRED",
    });

    const replacement = await connectOperator(running.wsUrl);
    await expect(running.controller.prepare(created.snapshot.id)).resolves.toMatchObject({
      phase: "intro",
    });
    await running.controller.abort(created.snapshot.id);
    replacement.lease.stop();
    replacement.socket.close();
  });

  it("expires a silent final Operator lease and fails the active run safely", async () => {
    const running = await start(undefined, { timeoutMs: 100, checkIntervalMs: 10 });
    runningServers.push(running);
    const operator = await connectOperator(running.wsUrl);
    const created = await running.controller.create({
      researchId: "SH26-007",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    running.controller.markDisplayReady(created.displayToken, "manual-display");
    await running.controller.prepare(created.snapshot.id);
    await running.controller.start(created.snapshot.id);

    operator.lease.stop();
    const closed = waitForClose(operator.socket);
    await expect(closed).resolves.toBe(1006);
    await vi.waitFor(() => {
      expect(running.controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
        phase: "error",
        errorCode: "OPERATOR_CONNECTION_LOST",
      });
    });
    expect(running.device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
  });

  it("continues while one of multiple Operator leases is renewed, then fails when all expire", async () => {
    const running = await start(undefined, { timeoutMs: 300, checkIntervalMs: 10 });
    runningServers.push(running);
    const silentOperator = await connectOperator(running.wsUrl);
    const liveOperator = await connectOperator(running.wsUrl);
    const created = await running.controller.create({
      researchId: "SH26-008",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    running.controller.markDisplayReady(created.displayToken, "manual-display");
    await running.controller.prepare(created.snapshot.id);
    await running.controller.start(created.snapshot.id);

    silentOperator.lease.stop();
    const silentClosed = waitForClose(silentOperator.socket);
    await expect(silentClosed).resolves.toBe(1006);
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(running.controller.getOperatorSnapshot(created.snapshot.id).phase).not.toBe("error");

    liveOperator.lease.stop();
    const liveClosed = waitForClose(liveOperator.socket);
    await expect(liveClosed).resolves.toBe(1006);
    await vi.waitFor(() => {
      expect(running.controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
        phase: "error",
        errorCode: "OPERATOR_CONNECTION_LOST",
      });
    });
  });

  it("fails an active run safely when the final Operator connection is lost", async () => {
    const running = await start();
    runningServers.push(running);
    const operator = await connectOperator(running.wsUrl);
    const created = await running.controller.create({
      researchId: "SH26-002",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    const display = new WebSocket(`${running.wsUrl}?displayToken=${encodeURIComponent(created.displayToken)}`);
    await waitForOpen(display);
    display.send(JSON.stringify({ type: "display.ready" }));
    await vi.waitFor(() => {
      expect(running.controller.getOperatorSnapshot(created.snapshot.id).displayConnected).toBe(true);
    });
    await running.controller.prepare(created.snapshot.id);
    await running.controller.start(created.snapshot.id);

    operator.lease.stop();
    operator.socket.terminate();
    await vi.waitFor(() => {
      expect(running.controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
        phase: "error",
        errorCode: "OPERATOR_CONNECTION_LOST",
      });
    });
  });

  it("closes a deleted display lease on its next heartbeat and keeps serving new sessions", async () => {
    const running = await start();
    runningServers.push(running);
    const created = await running.controller.create({
      researchId: "SH26-003",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    const display = new WebSocket(`${running.wsUrl}?displayToken=${encodeURIComponent(created.displayToken)}`);
    await waitForOpen(display);
    display.send(JSON.stringify({ type: "display.ready" }));
    await vi.waitFor(() => {
      expect(running.controller.getOperatorSnapshot(created.snapshot.id).displayConnected).toBe(true);
    });
    await running.controller.delete(created.snapshot.id);

    const closed = waitForClose(display);
    display.send(JSON.stringify({ type: "display.heartbeat" }));
    await expect(closed).resolves.toBe(1008);
    await expect(running.controller.create({
      researchId: "SH26-004",
      consentConfirmed: true,
      orderCode: "BCAD",
    })).resolves.toBeDefined();
  });
});
