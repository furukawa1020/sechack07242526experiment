import { useCallback, useEffect, useRef, useState } from "react";
import { payloadFromSocketMessage } from "./model.js";

export type RealtimeStatus = "connecting" | "open" | "closed";

interface RealtimeOptions {
  readonly query: string;
  readonly enabled?: boolean;
  /** Returning false rejects a message at the client boundary. */
  readonly onMessage: (type: string, payload: unknown) => boolean | void;
  readonly announceDisplay?: boolean;
  readonly announceOperator?: boolean;
}

interface RealtimeChannel {
  readonly status: RealtimeStatus;
  /** True only after this socket lease has received its post-ready snapshot. */
  readonly synchronized: boolean;
  readonly send: (type: string, payload?: Readonly<Record<string, unknown>>) => boolean;
}

function socketUrl(query: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws?${query}`;
}

function operatorChallengeNonce(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record["nonce"] !== "string") return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    record["nonce"],
  )
    ? record["nonce"]
    : null;
}

export function useRealtime({
  query,
  enabled = true,
  onMessage,
  announceDisplay = false,
  announceOperator = false,
}: RealtimeOptions): RealtimeChannel {
  const [status, setStatus] = useState<RealtimeStatus>(enabled ? "connecting" : "closed");
  const [synchronized, setSynchronized] = useState(!announceDisplay);
  const socketRef = useRef<WebSocket | null>(null);
  const synchronizedRef = useRef(!announceDisplay);
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
      synchronizedRef.current = !announceDisplay;
      return undefined;
    }

    let disposed = false;
    let retryTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let retryCount = 0;

    const connect = (): void => {
      if (disposed) return;
      let displaySynchronized = false;
      setStatus("connecting");
      synchronizedRef.current = !announceDisplay;
      setSynchronized(!announceDisplay);
      const socket = new WebSocket(socketUrl(query));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        retryCount = 0;
        setStatus("open");
        if (announceDisplay) {
          socket.send(JSON.stringify({ type: "display.ready" }));
        }
      });

      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data !== "string") return;
        try {
          const message = payloadFromSocketMessage(JSON.parse(event.data) as unknown);
          if (message !== null) {
            if (announceOperator && message.type === "operator.heartbeatChallenge") {
              const nonce = operatorChallengeNonce(message.payload);
              if (nonce !== null && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                  type: "operator.heartbeat",
                  payload: { nonce },
                }));
              }
              return;
            }
            const accepted = handlerRef.current(message.type, message.payload);
            if (
              announceDisplay
              && message.type === "session.snapshot"
              && accepted !== false
              && !displaySynchronized
            ) {
              displaySynchronized = true;
              synchronizedRef.current = true;
              setSynchronized(true);
              socket.send(JSON.stringify({
                type: "display.fullscreenState",
                payload: { fullscreen: document.fullscreenElement !== null },
              }));
              heartbeatTimer = window.setInterval(() => {
                if (socket.readyState === WebSocket.OPEN && displaySynchronized) {
                  socket.send(JSON.stringify({ type: "display.heartbeat" }));
                }
              }, 1_000);
            }
          }
        } catch {
          // Invalid messages are ignored; a valid server snapshot remains authoritative.
        }
      });

      socket.addEventListener("close", () => {
        if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
        socketRef.current = null;
        if (disposed) return;
        displaySynchronized = false;
        synchronizedRef.current = !announceDisplay;
        setSynchronized(!announceDisplay);
        setStatus("closed");
        const retryDelay = Math.min(1_000 * (2 ** retryCount), 8_000);
        retryCount += 1;
        retryTimer = window.setTimeout(connect, retryDelay);
      });

      socket.addEventListener("error", () => socket.close());
    };

    const onFullscreenChange = (): void => {
      const socket = socketRef.current;
      if (
        !announceDisplay
        || !synchronizedRef.current
        || socket?.readyState !== WebSocket.OPEN
      ) return;
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
  }, [announceDisplay, announceOperator, enabled, query]);

  return {
    status: enabled ? status : "closed",
    synchronized: enabled ? synchronized : !announceDisplay,
    send,
  };
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
