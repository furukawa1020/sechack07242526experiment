// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UI_COPY } from "../../../src/shared/copy.js";
import { ParticipantView } from "../../../src/client/participant/ParticipantView.js";
import {
  parseParticipantSnapshot,
  type ParticipantSnapshot,
  type PresentationMode,
  type ProcessingLocation,
} from "../../../src/client/shared/model.js";

afterEach(cleanup);

function snapshot(
  processing: ProcessingLocation,
  presentation: PresentationMode,
  overrides: Partial<ParticipantSnapshot> = {},
): ParticipantSnapshot {
  return {
    phase: "result",
    sequenceIndex: 0,
    condition: { processing, presentation },
    fixedState: { score: 72, label: "高ストレス" },
    phaseEndsAt: "2026-07-19T12:00:15.000Z",
    serverNow: "2026-07-19T12:00:00.000Z",
    summary: [],
    formUrl: null,
    ...overrides,
  };
}

function resultMarkup(processing: ProcessingLocation, presentation: PresentationMode): string {
  const view = render(<ParticipantView snapshot={snapshot(processing, presentation)} />);
  const markup = within(view.container).getByTestId("result-panel").outerHTML;
  view.unmount();
  return markup;
}

describe("participant presentation invariants", () => {
  it("renders the label result with byte-for-byte identical right DOM for cloud and local", () => {
    expect(resultMarkup("cloud", "label")).toBe(resultMarkup("local", "label"));
  });

  it("renders the puffer result with byte-for-byte identical right DOM for cloud and local", () => {
    expect(resultMarkup("cloud", "puffer")).toBe(resultMarkup("local", "puffer"));
  });

  it("changes only handling values between cloud and local", () => {
    const cloud = render(<ParticipantView snapshot={snapshot("cloud", "label")} />);
    const cloudPanel = within(cloud.container).getByTestId("handling-panel");
    const cloudClass = cloudPanel.className;
    expect(within(cloudPanel).getByText(UI_COPY.handling.cloud.processing)).toBeInTheDocument();
    cloud.unmount();

    const local = render(<ParticipantView snapshot={snapshot("local", "label")} />);
    const localPanel = within(local.container).getByTestId("handling-panel");
    expect(localPanel.className).toBe(cloudClass);
    expect(localPanel).not.toHaveAttribute("data-processing");
    expect(within(localPanel).getByText(UI_COPY.handling.local.processing)).toBeInTheDocument();
  });

  it("never renders internal condition codes or participant controls on a result", () => {
    const { container } = render(<ParticipantView snapshot={snapshot("cloud", "puffer")} />);
    for (const code of ["A", "B", "C", "D"]) {
      expect(screen.queryByText(code, { exact: true })).not.toBeInTheDocument();
    }
    expect(container.querySelector("[data-condition-code]")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("uses fixed copy for the intro, result and footer", () => {
    const { rerender } = render(<ParticipantView snapshot={snapshot("local", "label", { phase: "intro" })} />);
    expect(screen.getByRole("heading", { name: UI_COPY.intro.title })).toBeInTheDocument();
    expect(document.querySelector(".scenario-note")).toHaveTextContent(UI_COPY.intro.scenario.replace("\n", " "));
    const footer = document.querySelector(".participant-footer");
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByText(UI_COPY.footer.scenario)).toBeInTheDocument();
    expect(within(footer as HTMLElement).getByText(UI_COPY.footer.medical)).toBeInTheDocument();

    rerender(<ParticipantView snapshot={snapshot("local", "label")} />);
    expect(screen.getByText(UI_COPY.result.metric)).toBeInTheDocument();
    expect(screen.getByText("高ストレス")).toBeInTheDocument();
  });

  it("renders all participant-safe phases with the stable phase attribute", () => {
    const phases: readonly ParticipantSnapshot["phase"][] = [
      "idle", "setup", "intro", "handling", "processing", "result", "reset",
      "summary", "completed", "aborted", "error", "recovery",
    ];
    const view = render(<ParticipantView snapshot={snapshot("local", "label", { phase: "idle" })} />);
    for (const phase of phases) {
      view.rerender(<ParticipantView snapshot={snapshot("local", "label", { phase })} />);
      expect(screen.getByTestId("participant-app")).toHaveAttribute("data-phase", phase);
    }
  });

  it("keeps the summary in actual presentation order without exposing internal codes", () => {
    const summary = [
      { processing: "local", presentation: "puffer" },
      { processing: "cloud", presentation: "label" },
      { processing: "cloud", presentation: "puffer" },
      { processing: "local", presentation: "label" },
    ] as const;
    render(<ParticipantView snapshot={snapshot("local", "label", { phase: "summary", summary })} />);
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(4);
    expect(cards.map((card) => card.textContent)).toEqual([
      `${UI_COPY.summary.cards[0]}${UI_COPY.summary.conditionLabels.local.puffer}`,
      `${UI_COPY.summary.cards[1]}${UI_COPY.summary.conditionLabels.cloud.label}`,
      `${UI_COPY.summary.cards[2]}${UI_COPY.summary.conditionLabels.cloud.puffer}`,
      `${UI_COPY.summary.cards[3]}${UI_COPY.summary.conditionLabels.local.label}`,
    ]);
  });
});

describe("participant snapshot boundary", () => {
  it("reads the public current field and maps its one-based position", () => {
    const parsed = parseParticipantSnapshot({
      phase: "result",
      current: { position: 3, processing: "cloud", presentation: "label" },
      fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
      recoveryRequired: false,
      phaseEndsAt: null,
      summary: [],
      formUrl: null,
      conditionCode: "A",
      researchId: "must-not-cross-boundary",
    });

    expect(parsed).toMatchObject({
      phase: "result",
      sequenceIndex: 2,
      condition: { processing: "cloud", presentation: "label" },
    });
    expect(parsed).not.toHaveProperty("conditionCode");
    expect(parsed).not.toHaveProperty("researchId");
    expect(parsed?.fixedState).toEqual({ score: 72, label: "高ストレス" });
    expect(parsed?.fixedState).not.toHaveProperty("pufferLevel");
  });

  it("shows the neutral recovery state when the server requires confirmation", () => {
    const parsed = parseParticipantSnapshot({
      phase: "result",
      current: { position: 1, processing: "local", presentation: "puffer" },
      fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
      recoveryRequired: true,
      phaseEndsAt: null,
      summary: [],
      formUrl: null,
    });
    expect(parsed?.phase).toBe("recovery");
  });
});
