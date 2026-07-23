// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicDemoApp } from "../../../src/client/public-demo/PublicDemoApp.js";
import {
  PUBLIC_DEMO_COPY,
  PUBLIC_DEMO_REHEARSAL_TIMING_MS,
} from "../../../src/client/public-demo/content.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function next(): void {
  fireEvent.click(screen.getByRole("button", { name: PUBLIC_DEMO_COPY.navigation.next }));
}

function startRehearsal(): void {
  fireEvent.click(screen.getByRole("button", { name: PUBLIC_DEMO_COPY.rehearsal.start }));
}

function advance(milliseconds: number): void {
  act(() => vi.advanceTimersByTime(milliseconds));
}

describe("public demo", () => {
  it("clearly identifies the hardware-free, no-data public demo", () => {
    render(<PublicDemoApp />);

    expect(PUBLIC_DEMO_COPY.notice.title).toBe("公開デモ（模擬表示）");
    expect(screen.getByText(PUBLIC_DEMO_COPY.notice.title)).toBeInTheDocument();
    expect(screen.getByText(PUBLIC_DEMO_COPY.notice.research)).toBeInTheDocument();
    expect(screen.getByText(PUBLIC_DEMO_COPY.notice.data)).toBeInTheDocument();
    expect(screen.getByText(PUBLIC_DEMO_COPY.notice.device)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: PUBLIC_DEMO_COPY.intro.title })).toBeInTheDocument();
    expect(screen.getByText(/あなた自身を測定したものではありません/u)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: PUBLIC_DEMO_COPY.navigation.previous }),
    ).toBeDisabled();
    expect(document.querySelector(".public-demo-kicker")).toBeNull();
    expect(screen.queryByText("公開Mockデモ")).not.toBeInTheDocument();
  });

  it("uses one main landmark and a level-one scene heading before level-two panels", () => {
    render(<PublicDemoApp />);

    const main = screen.getByRole("main", { name: "固定模擬データの表示確認" });
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(within(main).getByRole("heading", { level: 1 })).toHaveTextContent(
      PUBLIC_DEMO_COPY.intro.title,
    );
    expect(main.querySelector("main")).toBeNull();

    next();

    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(within(main).getByRole("heading", { level: 1 })).toHaveTextContent("第1提示 / 3");
    expect(within(main).getAllByRole("heading", { level: 2 })).toHaveLength(2);
    expect(main.querySelector("main")).toBeNull();
    expect(document.querySelector("article main")).toBeNull();

    for (let index = 0; index < 3; index += 1) next();

    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(within(main).getByRole("heading", { level: 1 })).toHaveTextContent(
      PUBLIC_DEMO_COPY.summary.title,
    );
    expect(main.querySelector("main")).toBeNull();
  });

  it("shows all three fixed presentations without exposing internal condition codes", () => {
    render(<PublicDemoApp />);
    let cloudIconPath: string | null = null;
    let localIconPath: string | null = null;
    const expected = [
      ["クラウド", "高ストレス"],
      ["この端末内", "高ストレス"],
      ["この端末内", "状態は画面上のフグの ふくらみで表されています"],
    ] as const;

    expected.forEach(([processing, result], index) => {
      next();
      const stage = screen.getByLabelText("固定模擬データの表示確認");
      expect(stage.querySelector("[data-scene='result']")).not.toBeNull();
      expect(within(stage).getByText(`第${index + 1}提示 / 3`)).toBeInTheDocument();
      const handlingPanel = screen.getByTestId("handling-panel");
      const processingValue = within(handlingPanel).getByText(processing);
      expect(processingValue).toBeInTheDocument();
      expect(processingValue.closest(".public-demo-processing-location")).not.toBeNull();
      const processingIconKind = processing === "クラウド" ? "cloud" : "local";
      const otherProcessingIconKind = processingIconKind === "cloud" ? "local" : "cloud";
      const processingIcon = handlingPanel.querySelector(
        `[data-icon-kind='${processingIconKind}']`,
      );
      expect(processingIcon).not.toBeNull();
      expect(
        handlingPanel.querySelector(`[data-icon-kind='${otherProcessingIconKind}']`),
      ).toBeNull();

      const handlingIcons = Array.from(
        handlingPanel.querySelectorAll(".public-demo-handling-icon"),
      );
      expect(handlingIcons.map((icon) => icon.getAttribute("data-icon-kind"))).toEqual([
        processingIconKind,
        "storage",
        "audience",
      ]);
      handlingIcons.forEach((icon) => {
        expect(icon).toHaveAttribute("aria-hidden", "true");
        expect(icon).toHaveAttribute("fill", "none");
        expect(icon).toHaveAttribute("focusable", "false");
        expect(icon).toHaveAttribute("stroke", "currentColor");
        expect(icon).toHaveAttribute("stroke-width", "2.4");
        expect(icon).toHaveAttribute("viewBox", "0 0 64 64");
        expect(icon.children).toHaveLength(1);
        expect(icon.firstElementChild?.tagName.toLowerCase()).toBe("path");
      });
      for (const row of handlingPanel.querySelectorAll("dl > div")) {
        expect(row.children[0]?.tagName).toBe("DT");
        expect(row.children[1]?.tagName).toBe("DD");
      }
      const processingPath = processingIcon?.querySelector("path")?.getAttribute("d") ?? null;
      if (processingIconKind === "cloud") cloudIconPath = processingPath;
      else localIconPath = processingPath;

      expect(within(screen.getByTestId("result-panel")).getByText(result)).toBeInTheDocument();
      for (const code of ["A", "B", "C", "D"]) {
        expect(within(stage).queryByText(code, { exact: true })).not.toBeInTheDocument();
      }
      expect(stage.querySelector("[data-condition-code]")).toBeNull();
    });

    expect(cloudIconPath).not.toBeNull();
    expect(localIconPath).not.toBeNull();
    expect(cloudIconPath).not.toBe(localIconPath);
  });

  it("keeps the two label results identical and shows one local puffer result", () => {
    render(<PublicDemoApp />);

    next();
    const cloudLabel = screen.getByTestId("result-panel").innerHTML;
    next();
    const localLabel = screen.getByTestId("result-panel").innerHTML;
    next();
    const localPuffer = screen.getByTestId("result-panel");

    expect(cloudLabel).toBe(localLabel);
    expect(localPuffer).toHaveTextContent(PUBLIC_DEMO_COPY.result.puffer.replace("\n", " "));
  });

  it("uses only in-memory navigation and ends without a form or QR", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const localStorageSet = vi.spyOn(Storage.prototype, "setItem");
    const webSocketConstructor = vi.fn();
    vi.stubGlobal("WebSocket", webSocketConstructor);
    render(<PublicDemoApp />);

    for (let index = 0; index < 4; index += 1) next();

    expect(screen.getByTestId("public-demo-summary")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: PUBLIC_DEMO_COPY.summary.title }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /QR/u })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: PUBLIC_DEMO_COPY.navigation.next })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webSocketConstructor).not.toHaveBeenCalled();
    expect(localStorageSet).not.toHaveBeenCalled();
  });

  it("can move backward without leaving the static demo", () => {
    render(<PublicDemoApp />);
    next();
    next();
    expect(screen.getByText("第2提示 / 3（3 / 5画面）")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: PUBLIC_DEMO_COPY.navigation.previous }));

    expect(screen.getByText("第1提示 / 3（2 / 5画面）")).toBeInTheDocument();
    expect(document.querySelector("[data-scene='result']")).not.toBeNull();
  });

  it("returns to the top on every visible scene transition", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    render(<PublicDemoApp />);
    scrollTo.mockClear();
    document.documentElement.scrollTop = 480;
    document.body.scrollTop = 480;

    next();

    expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 0 });
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    expect(screen.getByText(PUBLIC_DEMO_COPY.notice.research)).toBeInTheDocument();
  });

  it("automatically replays the three timed presentation phases and ends at the summary", () => {
    vi.useFakeTimers();
    render(<PublicDemoApp />);

    expect(PUBLIC_DEMO_REHEARSAL_TIMING_MS).toEqual({
      handling: 8_000,
      processing: 3_000,
      result: 15_000,
      reset: 7_000,
      pufferInflate: 6_000,
      pufferDeflate: 6_000,
    });

    startRehearsal();
    const app = screen.getByTestId("public-demo-app");
    const stage = screen.getByLabelText("固定模擬データの表示確認");
    expect(app).toHaveAttribute("data-rehearsal-mode", "automatic");
    expect(
      screen.getByRole("button", { name: PUBLIC_DEMO_COPY.navigation.previous }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: PUBLIC_DEMO_COPY.navigation.next })).toBeDisabled();

    for (let position = 1; position <= 3; position += 1) {
      expect(stage).toHaveAttribute("data-rehearsal-position", String(position));
      expect(stage).toHaveAttribute("data-rehearsal-phase", "handling");
      advance(7_999);
      expect(stage).toHaveAttribute("data-rehearsal-phase", "handling");
      advance(1);
      expect(stage).toHaveAttribute("data-rehearsal-phase", "processing");
      expect(document.querySelector(".public-demo-rehearsal-spinner")).toBeNull();
      advance(3_000);
      expect(stage).toHaveAttribute("data-rehearsal-phase", "result");
      advance(15_000);
      expect(stage).toHaveAttribute("data-rehearsal-phase", "reset");
      advance(7_000);
    }

    expect(app).toHaveAttribute("data-rehearsal-mode", "manual");
    expect(screen.getByTestId("public-demo-summary")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: PUBLIC_DEMO_COPY.rehearsal.stop }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: PUBLIC_DEMO_COPY.rehearsal.start }),
    ).toBeInTheDocument();
  });

  it("keeps automatic label results identical and uses the six-second puffer motion", () => {
    vi.useFakeTimers();
    render(<PublicDemoApp />);
    startRehearsal();

    advance(8_000);
    advance(3_000);
    const firstLabelResult = screen.getByTestId("result-panel").innerHTML;
    advance(15_000);
    advance(7_000);
    advance(8_000);
    advance(3_000);
    const secondLabelResult = screen.getByTestId("result-panel").innerHTML;
    expect(secondLabelResult).toBe(firstLabelResult);

    advance(15_000);
    advance(7_000);
    advance(8_000);
    advance(3_000);
    let puffer = screen.getByTestId("public-demo-puffer");
    expect(puffer).toHaveAttribute("data-puffer-motion", "inflating");
    expect(puffer).toHaveAttribute("data-motion-duration-ms", "6000");
    advance(5_999);
    expect(puffer).toHaveAttribute("data-puffer-motion", "inflating");
    advance(1);
    expect(puffer).toHaveAttribute("data-puffer-motion", "holding");

    advance(9_000);
    puffer = screen.getByTestId("public-demo-puffer");
    expect(puffer).toHaveAttribute("data-puffer-motion", "deflating");
    expect(puffer).toHaveAttribute("data-motion-duration-ms", "6000");
    advance(6_000);
    expect(puffer).toHaveAttribute("data-puffer-motion", "resting");
  });

  it("runs automatic rehearsal only in memory without network, storage, forms, or device APIs", () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const localStorageSet = vi.spyOn(Storage.prototype, "setItem");
    const sessionStorageSet = vi.spyOn(window.sessionStorage, "setItem");
    const webSocketConstructor = vi.fn();
    vi.stubGlobal("WebSocket", webSocketConstructor);
    render(<PublicDemoApp />);

    startRehearsal();
    for (let position = 0; position < 3; position += 1) {
      advance(8_000);
      advance(3_000);
      advance(15_000);
      advance(7_000);
    }

    expect(screen.getByTestId("public-demo-summary")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webSocketConstructor).not.toHaveBeenCalled();
    expect(localStorageSet).not.toHaveBeenCalled();
    expect(sessionStorageSet).not.toHaveBeenCalled();
  });
});
