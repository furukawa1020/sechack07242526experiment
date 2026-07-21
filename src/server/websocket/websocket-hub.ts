import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";

import type { ServerEvent } from "../contracts.js";
import type { SessionController } from "../sessions/session-controller.js";

const DisplayMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("display.ready") }).strict(),
  z.object({ type: z.literal("display.heartbeat") }).strict(),
  z
    .object({
      type: z.literal("display.fullscreenState"),
      payload: z.object({ fullscreen: z.boolean() }).strict(),
    })
    .strict(),
]);

interface BaseClient {
  readonly id: string;
  readonly socket: WebSocket;
  lastHeartbeatAt: number;
}

interface OperatorClient extends BaseClient {
  readonly role: "operator";
}

interface DisplayClient extends BaseClient {
  readonly role: "display";
  readonly displayToken: string;
  readonly sessionId: string;
  ready: boolean;
}

type ConnectedClient = OperatorClient | DisplayClient;

export interface WebSocketHubOptions {
  readonly heartbeatTimeoutMs?: number;
  readonly operatorToken?: string;
  readonly allowLan?: boolean;
}

function parseUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

function originMatchesHost(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host.toLowerCase() === request.headers.host?.toLowerCase();
  } catch {
    return false;
  }
}

function websocketHostAllowed(request: IncomingMessage, allowLan: boolean): boolean {
  if (allowLan) return true;
  const host = request.headers.host?.toLowerCase();
  if (host === undefined) return false;
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":", 1)[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function rejectUpgrade(socket: Duplex, status: 400 | 403 | 404): void {
  const reason = status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Bad Request";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function safeSend(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function rawDataToText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export class WebSocketHub {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly heartbeatTimeoutMs: number;
  private readonly operatorToken: string | undefined;
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private readonly unsubscribeController: () => void;
  private readonly upgradeListener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private closing = false;

  public constructor(
    private readonly httpServer: HttpServer,
    private readonly controller: SessionController,
    options: WebSocketHubOptions = {},
  ) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 5_000;
    this.operatorToken = options.operatorToken;
    this.upgradeListener = (request, socket, head) => {
      let url: URL;
      try {
        url = parseUrl(request);
      } catch {
        rejectUpgrade(socket, 400);
        return;
      }
      if (url.pathname !== "/ws") {
        rejectUpgrade(socket, 404);
        return;
      }
      if (!originMatchesHost(request) || !websocketHostAllowed(request, options.allowLan ?? false)) {
        rejectUpgrade(socket, 403);
        return;
      }
      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        this.server.emit("connection", webSocket, request);
      });
    };
    this.httpServer.on("upgrade", this.upgradeListener);
    this.server.on("connection", (socket, request) => this.handleConnection(socket, request));
    this.unsubscribeController = this.controller.subscribe((event) => this.broadcastControllerEvent(event));
    this.heartbeatTimer = setInterval(() => this.expireStaleDisplays(), 1_000);
    this.heartbeatTimer.unref?.();
  }

  public close(): void {
    this.closing = true;
    clearInterval(this.heartbeatTimer);
    this.unsubscribeController();
    this.httpServer.off("upgrade", this.upgradeListener);
    // Terminate instead of waiting for browser close handshakes. Otherwise a
    // reconnecting participant page can keep HTTP server shutdown pending.
    for (const client of this.clients.values()) client.socket.terminate();
    this.clients.clear();
    this.server.close();
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = parseUrl(request);
    const id = randomUUID();
    const displayToken = url.searchParams.get("displayToken");
    let client: ConnectedClient;
    if (displayToken !== null) {
      let sessionId: string;
      try {
        sessionId = this.controller.resolveDisplayToken(displayToken);
      } catch {
        socket.close(1008, "Invalid display token");
        return;
      }
      client = {
        id,
        role: "display",
        socket,
        displayToken,
        sessionId,
        ready: false,
        lastHeartbeatAt: performance.now(),
      };
    } else if (url.searchParams.get("role") === "operator") {
      if (
        this.operatorToken !== undefined &&
        url.searchParams.get("operatorToken") !== this.operatorToken
      ) {
        socket.close(1008, "Operator token is required");
        return;
      }
      client = { id, role: "operator", socket, lastHeartbeatAt: performance.now() };
      const snapshot = this.controller.getActiveOperatorSnapshot();
      if (snapshot !== null) safeSend(socket, { type: "session.snapshot", payload: snapshot });
    } else {
      socket.close(1008, "A valid role or display token is required");
      return;
    }

    this.clients.set(id, client);
    socket.on("message", (data, isBinary) => this.handleMessage(client, data, isBinary));
    socket.on("close", () => this.removeClient(client));
    socket.on("error", () => this.removeClient(client));
  }

  private handleMessage(client: ConnectedClient, data: WebSocket.RawData, isBinary: boolean): void {
    const text = rawDataToText(data);
    if (isBinary || Buffer.byteLength(text, "utf8") > 8 * 1024) {
      client.socket.close(1008, "Invalid message");
      return;
    }
    if (client.role === "operator") {
      // All state-changing operator actions use validated REST endpoints.
      safeSend(client.socket, { type: "protocol.error", payload: { code: "REST_REQUIRED" } });
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text) as unknown;
    } catch {
      client.socket.close(1008, "Invalid JSON");
      return;
    }
    const parsed = DisplayMessageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      // This also rejects any attempt by the participant display to change session state.
      client.socket.close(1008, "Display is read-only");
      return;
    }

    try {
      switch (parsed.data.type) {
        case "display.ready":
          if (client.ready) {
            client.socket.close(1008, "Display is already ready");
            return;
          }
          this.controller.markDisplayReady(client.displayToken, client.id);
          client.ready = true;
          client.lastHeartbeatAt = performance.now();
          // A display receives its first authoritative snapshot only after the
          // controller has accepted this exact connection lease. In
          // particular, a reconnect must never render an active puffer phase
          // before the previous lease has been failed closed.
          safeSend(client.socket, {
            type: "session.snapshot",
            payload: this.controller.getPublicSnapshot(client.displayToken),
          });
          break;
        case "display.heartbeat":
          if (!client.ready) {
            client.socket.close(1008, "Display ready is required");
            return;
          }
          this.controller.noteDisplayHeartbeat(client.displayToken, client.id);
          client.lastHeartbeatAt = performance.now();
          break;
        case "display.fullscreenState":
          if (!client.ready) {
            client.socket.close(1008, "Display ready is required");
            return;
          }
          // Fullscreen state is deliberately transient and is not participant research data.
          this.controller.noteDisplayHeartbeat(client.displayToken, client.id);
          this.controller.markDisplayFullscreen(client.displayToken, client.id, parsed.data.payload.fullscreen);
          client.lastHeartbeatAt = performance.now();
          break;
      }
    } catch {
      client.socket.close(1008, "Display session is unavailable");
    }
  }

  private removeClient(client: ConnectedClient): void {
    if (!this.clients.delete(client.id)) return;
    if (
      !this.closing
      && client.role === "operator"
      && ![...this.clients.values()].some((candidate) => candidate.role === "operator")
    ) {
      this.controller.markOperatorDisconnected();
    }
    if (client.role === "display" && client.ready) {
      this.controller.markDisplayDisconnected(client.displayToken, client.id);
    }
  }

  private expireStaleDisplays(): void {
    const deadline = performance.now() - this.heartbeatTimeoutMs;
    for (const client of this.clients.values()) {
      if (client.role === "display" && client.ready && client.lastHeartbeatAt < deadline) {
        client.socket.terminate();
        this.removeClient(client);
      }
    }
  }

  private broadcastControllerEvent(event: ServerEvent): void {
    for (const client of this.clients.values()) {
      if (event.type === "device.status") {
        if (client.role === "operator") {
          safeSend(client.socket, {
            type: event.type,
            payload:
              event.deviceStatus === undefined
                ? undefined
                : { ...event.deviceStatus, mode: this.controller.getDeviceMode() },
          });
        }
        continue;
      }
      if (event.sessionId === undefined) continue;
      if (client.role === "operator") {
        try {
          safeSend(client.socket, { type: event.type, payload: this.controller.getOperatorSnapshot(event.sessionId) });
        } catch {
          // A deliberately deleted setup session has no snapshot to broadcast.
        }
      } else if (client.ready && client.sessionId === event.sessionId) {
        safeSend(client.socket, { type: event.type, payload: this.controller.getPublicSnapshot(client.displayToken) });
      }
    }
  }
}
