// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantSnapshot } from "../../../src/client/shared/model.js";

interface RealtimeOptionsProbe {
  readonly enabled?: boolean;
  readonly onMessage: (type: string, payload: unknown) => void;
}

const apiMocks = vi.hoisted(() => ({
  getDisplay: vi.fn(),
}));

const realtimeProbe = vi.hoisted(() => ({
  status: "open" as "connecting" | "open" | "closed",
  synchronized: false,
  options: null as RealtimeOptionsProbe | null,
}));

vi.mock("../../../src/client/shared/api.js", () => ({
  experimentApi: { getDisplay: apiMocks.getDisplay },
}));

vi.mock("../../../src/client/shared/realtime.js", () => ({
  useRealtime: (options: RealtimeOptionsProbe) => {
    realtimeProbe.options = options;
    return {
      status: realtimeProbe.status,
      synchronized: realtimeProbe.synchronized,
      send: () => true,
    };
  },
}));

import { ParticipantScreen } from "../../../src/client/participant/ParticipantScreen.js";

const ACTIVE_PUFFER_SNAPSHOT: ParticipantSnapshot = {
  rehearsal: false,
  phase: "result",
  sequenceIndex: 0,
  condition: { processing: "local", presentation: "puffer" },
  fixedState: null,
  pufferSurface: "screen",
  pufferRamp: { inflateMs: 6_000, deflateMs: 6_000 },
  phaseStartedAt: "2026-07-21T00:00:00.000Z",
  phaseEndsAt: "2026-07-21T00:00:15.000Z",
  serverNow: "2026-07-21T00:00:03.000Z",
  remainingMs: 12_000,
  summary: [],
  formUrl: null,
};

describe("ParticipantScreen synchronization boundary", () => {
  beforeEach(() => {
    realtimeProbe.status = "open";
    realtimeProbe.synchronized = false;
    realtimeProbe.options = null;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps the stimulus hidden until REST completes and this socket receives its ready snapshot", async () => {
    let resolveDisplay: ((snapshot: ParticipantSnapshot) => void) | undefined;
    apiMocks.getDisplay.mockReturnValue(new Promise<ParticipantSnapshot>((resolve) => {
      resolveDisplay = resolve;
    }));

    const view = render(<ParticipantScreen displayToken="display-token" />);
    expect(realtimeProbe.options?.enabled).toBe(false);
    expect(screen.queryByTestId("screen-puffer-visual")).not.toBeInTheDocument();

    await act(async () => {
      resolveDisplay?.(ACTIVE_PUFFER_SNAPSHOT);
      await Promise.resolve();
    });
    await waitFor(() => expect(realtimeProbe.options?.enabled).toBe(true));
    expect(screen.queryByTestId("screen-puffer-visual")).not.toBeInTheDocument();
    expect(screen.getByTestId("participant-app")).toHaveAttribute("data-phase", "recovery");

    realtimeProbe.synchronized = true;
    act(() => {
      realtimeProbe.options?.onMessage("session.snapshot", ACTIVE_PUFFER_SNAPSHOT);
    });
    expect(await screen.findByTestId("screen-puffer-visual")).toBeVisible();
    expect(screen.getByTestId("participant-app")).toHaveAttribute("data-phase", "result");

    realtimeProbe.status = "closed";
    realtimeProbe.synchronized = false;
    view.rerender(<ParticipantScreen displayToken="display-token" />);
    expect(screen.queryByTestId("screen-puffer-visual")).not.toBeInTheDocument();
    expect(screen.getByTestId("participant-app")).toHaveAttribute("data-phase", "recovery");

    realtimeProbe.status = "open";
    view.rerender(<ParticipantScreen displayToken="display-token" />);
    expect(screen.queryByTestId("screen-puffer-visual")).not.toBeInTheDocument();
    expect(screen.getByTestId("participant-app")).toHaveAttribute("data-phase", "recovery");
  });
});
