// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import QRCode from "qrcode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_COPY } from "../../../src/shared/copy.js";
import { ParticipantView } from "../../../src/client/participant/ParticipantView.js";
import {
  parseParticipantSnapshot,
  type ParticipantSnapshot,
  type PresentationMode,
  type ProcessingLocation,
} from "../../../src/client/shared/model.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

function fieldIconDetails(panel: HTMLElement): readonly {
  readonly structure: {
    readonly wrapperTag: string;
    readonly wrapperClass: string;
    readonly svgTag: string;
    readonly viewBox: string | null;
    readonly ariaHidden: string | null;
    readonly focusable: string | null;
    readonly childTags: readonly string[];
  };
  readonly path: string | null;
}[] {
  const icons = [...panel.querySelectorAll<SVGSVGElement>(".field-icon > svg")];
  expect(icons).toHaveLength(3);
  return icons.map((icon) => {
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("focusable", "false");
    expect(icon.children).toHaveLength(1);
    expect(icon.firstElementChild?.localName).toBe("path");
    return {
      structure: {
        wrapperTag: icon.parentElement?.localName ?? "",
        wrapperClass: icon.parentElement?.className ?? "",
        svgTag: icon.localName,
        viewBox: icon.getAttribute("viewBox"),
        ariaHidden: icon.getAttribute("aria-hidden"),
        focusable: icon.getAttribute("focusable"),
        childTags: [...icon.children].map((child) => child.localName),
      },
      path: icon.firstElementChild?.getAttribute("d") ?? null,
    };
  });
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
    const cloudLocationValue = within(cloudPanel).getByText(UI_COPY.handling.cloud.processing);
    expect(cloudLocationValue).toBeInTheDocument();
    expect(cloudLocationValue.closest(".handling-row")).toHaveClass("handling-row-location");
    const cloudIcons = fieldIconDetails(cloudPanel);
    cloud.unmount();

    const local = render(<ParticipantView snapshot={snapshot("local", "label")} />);
    const localPanel = within(local.container).getByTestId("handling-panel");
    expect(localPanel.className).toBe(cloudClass);
    expect(localPanel).not.toHaveAttribute("data-processing");
    const localLocationValue = within(localPanel).getByText(UI_COPY.handling.local.processing);
    expect(localLocationValue).toBeInTheDocument();
    expect(localLocationValue.closest(".handling-row")).toHaveClass("handling-row-location");
    const localIcons = fieldIconDetails(localPanel);

    expect(localIcons.map(({ structure }) => structure)).toEqual(
      cloudIcons.map(({ structure }) => structure),
    );
    expect(localIcons[0]?.path).not.toBe(cloudIcons[0]?.path);
    expect(localIcons.slice(1).map(({ path }) => path)).toEqual(
      cloudIcons.slice(1).map(({ path }) => path),
    );
    expect(new Set(cloudIcons.map(({ structure }) => JSON.stringify(structure))).size).toBe(1);
    expect(new Set(localIcons.map(({ structure }) => JSON.stringify(structure))).size).toBe(1);
    expect(cloudPanel.querySelector("[data-icon-kind], [data-location]")).toBeNull();
    expect(localPanel.querySelector("[data-icon-kind], [data-location]")).toBeNull();
    expect([...cloudPanel.querySelectorAll(".handling-row")].map(({ className }) => className)).toEqual([
      "handling-row handling-row-location",
      "handling-row",
      "handling-row",
    ]);
    expect([...localPanel.querySelectorAll(".handling-row")].map(({ className }) => className)).toEqual([
      "handling-row handling-row-location",
      "handling-row",
      "handling-row",
    ]);
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

  it("uses the configured form URL verbatim only for the explicit link and local QR generation", async () => {
    const formUrl = "https://forms.gle/BeShY7cY5zMjunto9";
    const qrSpy = vi.spyOn(QRCode, "toDataURL");
    const locationBeforeRender = window.location.href;

    render(<ParticipantView snapshot={snapshot("local", "label", {
      phase: "summary",
      formUrl,
    })} />);

    const formLink = screen.getByRole("link", { name: UI_COPY.summary.formCta });
    expect(formLink).toHaveAttribute("href", formUrl);
    expect(formLink).toHaveAttribute("target", "_blank");
    expect(formLink).toHaveAttribute("rel", "noreferrer");
    await waitFor(() => expect(qrSpy).toHaveBeenCalledTimes(1));
    expect(qrSpy.mock.calls[0]?.[0]).toBe(formUrl);
    expect(window.location.href).toBe(locationBeforeRender);
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
