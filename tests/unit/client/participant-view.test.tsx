// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  UI_COPY,
  formatPresentationPosition,
  formatResponseCheckpointTitle,
} from "../../../src/shared/copy.js";
import { ParticipantView } from "../../../src/client/participant/ParticipantView.js";
import {
  parseParticipantSnapshot,
  type ParticipantSnapshot,
  type PresentationMode,
  type ProcessingLocation,
} from "../../../src/client/shared/model.js";

afterEach(() => {
  cleanup();
});

function snapshot(
  processing: ProcessingLocation,
  presentation: PresentationMode,
  overrides: Partial<ParticipantSnapshot> = {},
): ParticipantSnapshot {
  return {
    rehearsal: false,
    phase: "result",
    sequenceIndex: 0,
    condition: { processing, presentation },
    fixedState: { score: 72, label: "高ストレス" },
    pufferSurface: "physical",
    pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
    phaseStartedAt: "2026-07-19T12:00:00.000Z",
    phaseEndsAt: "2026-07-19T12:00:15.000Z",
    serverNow: "2026-07-19T12:00:00.000Z",
    remainingMs: 15_000,
    summary: [],
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

  it("renders the screen puffer result with identical C/D DOM and server-synchronised linear motion", () => {
    const screenMotion = {
      pufferSurface: "screen" as const,
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
      phaseStartedAt: "2026-07-19T12:00:00.000Z",
      serverNow: "2026-07-19T11:59:00.000Z",
      remainingMs: 12_000,
    };
    const cloud = render(<ParticipantView snapshot={snapshot("cloud", "puffer", screenMotion)} />);
    const cloudResult = within(cloud.container).getByTestId("result-panel");
    const cloudMarkup = cloudResult.outerHTML;
    const visual = within(cloudResult).getByTestId("screen-puffer-visual");
    const body = visual.querySelector<HTMLElement>(".screen-puffer-body");
    expect(body).not.toBeNull();
    expect(body?.style.animationName).toBe("screen-puffer-inflate");
    expect(body?.style.animationDuration).toBe("6000ms");
    expect(body?.style.animationDelay).toBe("-3000ms");
    expect(body?.style.animationTimingFunction).toBe("linear");
    expect(body?.style.getPropertyValue("--screen-puffer-expanded-scale")).toBe("1");
    expect(visual).toHaveAttribute("data-puffer-motion", "inflating");
    expect(visual).toHaveAttribute("data-motion-duration-ms", "6000");
    expect(cloudResult).toHaveTextContent(UI_COPY.result.pufferScreen.replace("\n", " "));
    expect(cloudResult).not.toHaveTextContent(UI_COPY.result.pufferPhysical.replace("\n", " "));
    expect(cloudResult).not.toHaveTextContent("0.6");
    cloud.unmount();

    const local = render(<ParticipantView snapshot={snapshot("local", "puffer", screenMotion)} />);
    expect(within(local.container).getByTestId("result-panel").outerHTML).toBe(cloudMarkup);
  });

  it("uses the same screen puffer to contract during reset", () => {
    render(<ParticipantView snapshot={snapshot("local", "puffer", {
      phase: "reset",
      pufferSurface: "screen",
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
      phaseStartedAt: "2026-07-19T12:00:15.000Z",
      phaseEndsAt: "2026-07-19T12:00:22.000Z",
      serverNow: "2026-07-19T12:05:00.000Z",
      remainingMs: 4_500,
    })} />);

    const visual = screen.getByTestId("screen-puffer-visual");
    const body = visual.querySelector<HTMLElement>(".screen-puffer-body");
    expect(body?.style.animationName).toBe("screen-puffer-deflate");
    expect(body?.style.animationDuration).toBe("6000ms");
    expect(body?.style.animationDelay).toBe("-2500ms");
    expect(visual).toHaveAttribute("data-puffer-motion", "deflating");
    expect(screen.getByRole("heading", { name: UI_COPY.reset.title })).toBeInTheDocument();
    expect(screen.getByText(UI_COPY.reset.waiting)).toBeInTheDocument();
  });

  it("derives puffer progress from monotonic remaining time despite wall-clock correction", () => {
    const duringRamp = snapshot("cloud", "puffer", {
      pufferSurface: "screen",
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
      phaseStartedAt: "2026-07-19T12:00:00.000Z",
      serverNow: "2026-07-19T12:20:00.000Z",
      remainingMs: 10_500,
    });
    const firstLoad = render(<ParticipantView snapshot={duringRamp} />);
    const firstVisual = within(firstLoad.container).getByTestId("screen-puffer-visual");
    expect(firstVisual).toHaveAttribute("data-puffer-motion", "inflating");
    expect(firstVisual.querySelector<HTMLElement>(".screen-puffer-body")?.style.animationDelay)
      .toBe("-4500ms");
    firstLoad.unmount();

    const reload = render(<ParticipantView snapshot={{
      ...duringRamp,
      serverNow: "2026-07-19T11:40:00.000Z",
      remainingMs: 8_000,
    }} />);
    const reloadedVisual = within(reload.container).getByTestId("screen-puffer-visual");
    expect(reloadedVisual).toHaveAttribute("data-puffer-motion", "holding");
    expect(reloadedVisual.querySelector<HTMLElement>(".screen-puffer-body")?.style.animationDelay)
      .toBe("-6000ms");
  });

  it("removes the inflated screen puffer immediately for interruption and error phases", () => {
    const interrupted = snapshot("local", "puffer", {
      pufferSurface: "screen",
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
      serverNow: "2026-07-19T12:00:08.000Z",
      phase: "aborted",
    });
    const view = render(<ParticipantView snapshot={interrupted} />);
    expect(screen.queryByTestId("screen-puffer-visual")).not.toBeInTheDocument();

    view.rerender(<ParticipantView snapshot={{ ...interrupted, phase: "error" }} />);
    expect(screen.queryByTestId("screen-puffer-visual")).not.toBeInTheDocument();

    view.rerender(<ParticipantView snapshot={{ ...interrupted, phase: "recovery" }} />);
    expect(screen.queryByTestId("screen-puffer-visual")).not.toBeInTheDocument();
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
    for (const row of localPanel.querySelectorAll("dl > div")) {
      expect([...row.children].map(({ tagName }) => tagName)).toEqual(["DT", "DD"]);
      expect(row.querySelector("dt > .field-icon")).not.toBeNull();
    }
  });

  it("never renders internal condition codes or participant controls on a result", () => {
    const { container } = render(<ParticipantView snapshot={snapshot("cloud", "puffer")} />);
    for (const code of ["A", "B", "C", "D"]) {
      expect(screen.queryByText(code, { exact: true })).not.toBeInTheDocument();
    }
    expect(container.querySelector("[data-condition-code]")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    ["missing condition", { condition: null }],
    ["missing sequence index", { sequenceIndex: null }],
    ["missing label fixed state", { fixedState: null }],
  ] as const)("fails closed for %s without showing either processing condition", (_label, overrides) => {
    render(<ParticipantView snapshot={snapshot("cloud", "label", overrides)} />);

    expect(screen.getByRole("heading", { name: UI_COPY.error.title })).toBeInTheDocument();
    expect(screen.getByText(UI_COPY.error.waiting)).toBeInTheDocument();
    expect(screen.queryByText(UI_COPY.handling.cloud.processing)).not.toBeInTheDocument();
    expect(screen.queryByText(UI_COPY.handling.local.processing)).not.toBeInTheDocument();
    expect(screen.queryByText(formatPresentationPosition(1))).not.toBeInTheDocument();
    expect(screen.queryByTestId("handling-panel")).not.toBeInTheDocument();
  });

  it("keeps the puffer result valid without exposing label-only fixed state", () => {
    render(<ParticipantView snapshot={snapshot("cloud", "puffer", { fixedState: null })} />);
    expect(screen.getByTestId("result-panel")).toHaveTextContent(
      UI_COPY.result.pufferPhysical.replace("\n", " "),
    );
    expect(screen.queryByRole("heading", { name: UI_COPY.error.title })).not.toBeInTheDocument();
  });

  it("uses fixed copy for the intro, result and footer", () => {
    const { rerender } = render(<ParticipantView snapshot={snapshot("local", "label", {
      phase: "intro",
      pufferSurface: "screen",
    })} />);
    expect(screen.getByRole("heading", { name: UI_COPY.intro.title })).toBeInTheDocument();
    expect(document.querySelector(".scenario-note")).toHaveTextContent(
      UI_COPY.intro.scenario.replace(/\s+/gu, " "),
    );
    const footer = document.querySelector(".participant-footer");
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByText(UI_COPY.footer.scenario)).toBeInTheDocument();
    expect(within(footer as HTMLElement).getByText(UI_COPY.footer.medical)).toBeInTheDocument();

    rerender(<ParticipantView snapshot={snapshot("local", "label")} />);
    expect(screen.getByText(UI_COPY.result.metric)).toBeInTheDocument();
    expect(screen.getByText("高ストレス")).toBeInTheDocument();
  });

  it("uses plain Japanese guidance for handling and processing without decorative orbit markup", () => {
    const view = render(<ParticipantView snapshot={snapshot("cloud", "label", { phase: "handling" })} />);

    const handlingMessage = view.container.querySelector(".handling-message-panel");
    expect(handlingMessage).not.toBeNull();
    expect(handlingMessage).toHaveTextContent(UI_COPY.footer.remember);
    expect(handlingMessage).toHaveAttribute("aria-live", "polite");
    expect(view.container.querySelector(".neutral-orbit, .neutral-panel")).toBeNull();

    view.rerender(<ParticipantView snapshot={snapshot("cloud", "label", { phase: "processing" })} />);
    const processingPanel = view.container.querySelector(".processing-panel");
    expect(processingPanel).not.toBeNull();
    expect(processingPanel).toHaveTextContent(UI_COPY.processing);
    expect(view.container.querySelector(".neutral-orbit, .neutral-panel")).toBeNull();
  });

  it("renders all participant-safe phases with the stable phase attribute", () => {
    const phases: readonly ParticipantSnapshot["phase"][] = [
      "idle", "setup", "intro", "handling", "processing", "result", "reset",
      "response", "summary", "completed", "aborted", "error", "recovery",
    ];
    const view = render(<ParticipantView snapshot={snapshot("local", "label", { phase: "idle" })} />);
    for (const phase of phases) {
      view.rerender(<ParticipantView snapshot={snapshot("local", "label", { phase })} />);
      expect(screen.getByTestId("participant-app")).toHaveAttribute("data-phase", phase);
    }
  });

  it("shows only neutral staff-waiting copy at each response checkpoint", () => {
    const view = render(<ParticipantView snapshot={snapshot("cloud", "label", {
      phase: "response",
      sequenceIndex: 2,
      condition: null,
      fixedState: null,
      phaseEndsAt: null,
      remainingMs: null,
    })} />);

    const message = view.container.querySelector(".participant-message-card");
    expect(message).not.toBeNull();
    expect(within(message as HTMLElement).getByRole("heading", {
      name: formatResponseCheckpointTitle(3),
    })).toBeInTheDocument();
    expect(within(message as HTMLElement).getByText(UI_COPY.response.waiting)).toBeInTheDocument();
    expect(message).toHaveTextContent(
      `${formatResponseCheckpointTitle(3)}${UI_COPY.response.waiting}`,
    );
    expect(view.container.querySelector(".participant-footer")).toBeNull();
    expect(view.container.textContent).toBe(
      `${formatResponseCheckpointTitle(3)}${UI_COPY.response.waiting}`,
    );
    expect(view.container.querySelector(
      ".condition-grid, [data-testid='result-panel'], [data-testid='screen-puffer-visual']",
    )).toBeNull();
    expect(view.container.textContent).not.toMatch(
      /高ストレス|72\s*\/\s*100|クラウド|この端末内|Googleフォーム|フォーム|QRコード|アンケート|回答済み|回答完了/iu,
    );
    expect(view.container.textContent).not.toMatch(/\b[ABCD]\b/u);
    expect(view.container.querySelectorAll("button, a, img")).toHaveLength(0);
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

  it("names the screen-puffer medium accurately in the summary", () => {
    const summary = [
      { processing: "local", presentation: "puffer" },
      { processing: "cloud", presentation: "label" },
      { processing: "cloud", presentation: "puffer" },
      { processing: "local", presentation: "label" },
    ] as const;
    render(<ParticipantView snapshot={snapshot("local", "label", {
      phase: "summary",
      pufferSurface: "screen",
      summary,
    })} />);

    const cards = screen.getAllByRole("listitem");
    expect(cards.map((card) => card.textContent)).toEqual([
      `${UI_COPY.summary.cards[0]}${UI_COPY.summary.screenPufferLabels.local}`,
      `${UI_COPY.summary.cards[1]}${UI_COPY.summary.conditionLabels.cloud.label}`,
      `${UI_COPY.summary.cards[2]}${UI_COPY.summary.screenPufferLabels.cloud}`,
      `${UI_COPY.summary.cards[3]}${UI_COPY.summary.conditionLabels.local.label}`,
    ]);
    expect(document.body).not.toHaveTextContent("A");
    expect(document.body).not.toHaveTextContent("B");
    expect(document.body).not.toHaveTextContent("C");
    expect(document.body).not.toHaveTextContent("D");
  });

  it("keeps the participant summary free of form destinations and response guidance", () => {
    const view = render(<ParticipantView snapshot={snapshot("local", "label", {
      phase: "summary",
      summary: [
        { processing: "cloud", presentation: "label" },
        { processing: "local", presentation: "label" },
        { processing: "cloud", presentation: "puffer" },
        { processing: "local", presentation: "puffer" },
      ],
    })} />);

    expect(view.container).toHaveTextContent("4つの提示は以上です。");
    expect(view.container).toHaveTextContent("研究スタッフの案内をお待ちください。");
    expect(view.container.textContent).not.toMatch(/Googleフォーム|フォーム|QRコード|アンケート|回答する/iu);
    expect(view.container.querySelectorAll("a, img")).toHaveLength(0);
  });

  it("labels a hardware-free rehearsal and removes every form instruction", () => {
    const summary = [
      { processing: "cloud", presentation: "label" },
      { processing: "local", presentation: "label" },
      { processing: "cloud", presentation: "puffer" },
      { processing: "local", presentation: "puffer" },
    ] as const;
    const view = render(<ParticipantView snapshot={snapshot("cloud", "label", {
      rehearsal: true,
      phase: "intro",
    })} />);

    expect(screen.getByRole("note")).toHaveTextContent(UI_COPY.rehearsal.title);
    expect(screen.getByRole("note")).toHaveTextContent(UI_COPY.rehearsal.body);
    expect(screen.getByTestId("participant-app")).toHaveAttribute("data-rehearsal", "true");

    view.rerender(<ParticipantView snapshot={snapshot("cloud", "label", {
      rehearsal: true,
      phase: "summary",
      summary,
    })} />);
    expect(view.container.querySelector(".summary-heading")).toHaveTextContent(
      UI_COPY.rehearsal.summary.replace("\n", " "),
    );
    expect(view.container.textContent).not.toMatch(/Googleフォーム|フォーム|QRコード|アンケート|回答する/iu);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    view.rerender(<ParticipantView snapshot={snapshot("cloud", "label", {
      rehearsal: true,
      phase: "completed",
    })} />);
    expect(screen.getByRole("heading", { name: UI_COPY.rehearsal.completedTitle })).toBeInTheDocument();
    expect(screen.getByText(UI_COPY.rehearsal.completedWaiting)).toBeInTheDocument();
  });
});

describe("participant snapshot boundary", () => {
  it("reads the public current field and maps its one-based position", () => {
    const parsed = parseParticipantSnapshot({
      phase: "result",
      current: { position: 3, processing: "cloud", presentation: "label" },
      fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
      pufferSurface: "physical",
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
      phaseStartedAt: "2026-07-19T12:00:00.000Z",
      recoveryRequired: false,
      phaseEndsAt: null,
      serverNow: null,
      remainingMs: null,
      summary: [],
      formUrl: "https://forms.gle/legacy-destination",
      conditionCode: "A",
      researchId: "must-not-cross-boundary",
    });

    expect(parsed).toMatchObject({
      rehearsal: false,
      phase: "result",
      sequenceIndex: 2,
      condition: { processing: "cloud", presentation: "label" },
    });
    expect(parsed).not.toHaveProperty("conditionCode");
    expect(parsed).not.toHaveProperty("researchId");
    expect(parsed).not.toHaveProperty("formUrl");
    expect(parsed?.fixedState).toEqual({ score: 72, label: "高ストレス" });
    expect(parsed?.fixedState).not.toHaveProperty("pufferLevel");
  });

  it("parses only an explicit rehearsal flag", () => {
    const parsed = parseParticipantSnapshot({
      rehearsal: true,
      phase: "intro",
      current: null,
      pufferSurface: "physical",
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
      phaseStartedAt: null,
      recoveryRequired: false,
      phaseEndsAt: null,
      serverNow: null,
      remainingMs: null,
      summary: [],
    });
    expect(parsed?.rehearsal).toBe(true);
  });

  it("shows the neutral recovery state when the server requires confirmation", () => {
    const parsed = parseParticipantSnapshot({
      phase: "result",
      current: { position: 1, processing: "local", presentation: "puffer" },
      fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
      pufferSurface: "physical",
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
      phaseStartedAt: "2026-07-19T12:00:00.000Z",
      recoveryRequired: true,
      phaseEndsAt: null,
      serverNow: null,
      remainingMs: null,
      summary: [],
    });
    expect(parsed?.phase).toBe("recovery");
  });
});
