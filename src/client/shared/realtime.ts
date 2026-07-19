import { useCallback, useEffect, useRef, useState } from "react";
import { payloadFromSocketMessage } from "./model.js";

export type RealtimeStatus = "connecting" | "open" | "closed";

interface RealtimeOptions {
  readonly query: string;
  readonly enabled?: boolean;
  readonly onMessage: (type: string, payload: unknown) => void;
  readonly announceDisplay?: boolean;
}

interface RealtimeChannel {
  readonly status: RealtimeStatus;
  readonly send: (type: string, payload?: Readonly<Record<string, unknown>>) => boolean;
}

function socketUrl(query: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws?${query}`;
}

export function useRealtime({ query, enabled = true, onMessage, announceDisplay = false }: RealtimeOptions): RealtimeChannel {
  const [status, setStatus] = useState<RealtimeStatus>(enabled ? "connecting" : "closed");
  const socketRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);

  useEffect(() => {
    handlerRef.current = onMessage;
  }, [onMessage]);

  const send = useCallback((type: string, payload?: Readonly<Record<string, unknown>>): boolean => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload === undefined ? { type } : { type, payload }));
    return true;
  }, []);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let disposed = false;
    let retryTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let retryCount = 0;

    const connect = (): void => {
      if (disposed) return;
      setStatus("connecting");
      const socket = new WebSocket(socketUrl(query));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        retryCount = 0;
        setStatus("open");
        if (announceDisplay) {
          socket.send(JSON.stringify({ type: "display.ready" }));
          socket.send(JSON.stringify({
            type: "display.fullscreenState",
            payload: { fullscreen: document.fullscreenElement !== null },
          }));
          heartbeatTimer = window.setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "display.heartbeat" }));
            }
          }, 1_000);
        }
      });

      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data !== "string") return;
        try {
          const message = payloadFromSocketMessage(JSON.parse(event.data) as unknown);
          if (message !== null) handlerRef.current(message.type, message.payload);
        } catch {
          // Invalid messages are ignored; a valid server snapshot remains authoritative.
        }
      });

      socket.addEventListener("close", () => {
        if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
        socketRef.current = null;
        if (disposed) return;
        setStatus("closed");
        const retryDelay = Math.min(1_000 * (2 ** retryCount), 8_000);
        retryCount += 1;
        retryTimer = window.setTimeout(connect, retryDelay);
      });

      socket.addEventListener("error", () => socket.close());
    };

    const onFullscreenChange = (): void => {
      const socket = socketRef.current;
      if (!announceDisplay || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
        type: "display.fullscreenState",
        payload: { fullscreen: document.fullscreenElement !== null },
      }));
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    connect();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      socketRef.current?.close(1000, "view unmounted");
      socketRef.current = null;
    };
  }, [announceDisplay, enabled, query]);

  return { status, send };
}

export function useRemainingSeconds(phaseEndsAt: string | null, serverNow: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (phaseEndsAt === null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [phaseEndsAt]);

  if (phaseEndsAt === null) return null;
  const end = Date.parse(phaseEndsAt);
  if (!Number.isFinite(end)) return null;
  // `serverNow` travels with the snapshot for audit/debug display; both clocks use
  // ISO wall time, while this interval only redraws the server-owned deadline.
  void serverNow;
  return Math.max(0, Math.ceil((end - now) / 1_000));
}
