// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRealtime } from "../../../src/client/shared/realtime.js";

class TestWebSocket extends EventTarget {
  public static readonly OPEN = 1;
  public static readonly instances: TestWebSocket[] = [];

  public readonly sent: string[] = [];
  public readyState = 0;

  public constructor(public readonly url: string) {
    super();
    TestWebSocket.instances.push(this);
  }

  public open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  public close(): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close"));
  }
}

function OperatorRealtimeProbe(): null {
  useRealtime({
    query: "role=operator",
    announceOperator: true,
    onMessage: () => undefined,
  });
  return null;
}

describe("Operator realtime lease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestWebSocket.instances.splice(0);
    vi.stubGlobal("WebSocket", TestWebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renews the Operator lease only after a valid server round-trip challenge", () => {
    render(<OperatorRealtimeProbe />);
    const socket = TestWebSocket.instances[0];
    expect(socket?.url).toMatch(/\/ws\?role=operator$/u);

    act(() => socket?.open());
    expect(socket?.sent).toEqual([]);

    const nonce = "123e4567-e89b-42d3-a456-426614174000";
    act(() => socket?.receive({
      type: "operator.heartbeatChallenge",
      payload: { nonce },
    }));
    expect(socket?.sent).toEqual([
      JSON.stringify({ type: "operator.heartbeat", payload: { nonce } }),
    ]);

    act(() => socket?.receive({
      type: "operator.heartbeatChallenge",
      payload: { nonce: "not-a-valid-challenge" },
    }));
    act(() => vi.advanceTimersByTime(2_000));
    expect(socket?.sent).toHaveLength(1);
  });
});
