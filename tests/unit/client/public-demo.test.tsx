// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicDemoApp } from "../../../src/client/public-demo/PublicDemoApp.js";
import { PUBLIC_DEMO_COPY } from "../../../src/client/public-demo/content.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function next(): void {
  fireEvent.click(screen.getByRole("button", { name: PUBLIC_DEMO_COPY.navigation.next }));
}

describe("public demo", () => {
  it("clearly identifies the hardware-free, no-data public demo", () => {
    render(<PublicDemoApp />);

    expect(screen.getByText(PUBLIC_DEMO_COPY.notice.title)).toBeInTheDocument();
    expect(screen.getByText(PUBLIC_DEMO_COPY.notice.research)).toBeInTheDocument();
    expect(screen.getByText(PUBLIC_DEMO_COPY.notice.data)).toBeInTheDocument();
    expect(screen.getByText(PUBLIC_DEMO_COPY.notice.device)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: PUBLIC_DEMO_COPY.intro.title })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: PUBLIC_DEMO_COPY.navigation.previous }),
    ).toBeDisabled();
    expect(document.querySelector(".public-demo-kicker")).toBeNull();
  });

  it("shows all four fixed presentations without exposing internal condition codes", () => {
    render(<PublicDemoApp />);
    let cloudIconPath: string | null = null;
    let localIconPath: string | null = null;
    const expected = [
      ["クラウド", "高ストレス"],
      ["この端末内", "高ストレス"],
      ["クラウド", "状態はフグ型デバイスに 反映されています"],
      ["この端末内", "状態はフグ型デバイスに 反映されています"],
    ] as const;

    expected.forEach(([processing, result], index) => {
      next();
      const stage = screen.getByLabelText("固定模擬データの表示確認");
      expect(stage.querySelector("[data-scene='result']")).not.toBeNull();
      expect(within(stage).getByText(`第${index + 1}提示 / 4`)).toBeInTheDocument();
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

  it("keeps paired right-side results identical after adding location pictograms", () => {
    render(<PublicDemoApp />);

    next();
    const cloudLabel = screen.getByTestId("result-panel").innerHTML;
    next();
    const localLabel = screen.getByTestId("result-panel").innerHTML;
    next();
    const cloudPuffer = screen.getByTestId("result-panel").innerHTML;
    next();
    const localPuffer = screen.getByTestId("result-panel").innerHTML;

    expect(cloudLabel).toBe(localLabel);
    expect(cloudPuffer).toBe(localPuffer);
  });

  it("uses only in-memory navigation and ends without a form or QR", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const localStorageSet = vi.spyOn(Storage.prototype, "setItem");
    const webSocketConstructor = vi.fn();
    vi.stubGlobal("WebSocket", webSocketConstructor);
    render(<PublicDemoApp />);

    for (let index = 0; index < 5; index += 1) next();

    expect(screen.getByTestId("public-demo-summary")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: PUBLIC_DEMO_COPY.summary.title }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
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
    expect(screen.getByText("第2提示 / 4（3 / 6画面）")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: PUBLIC_DEMO_COPY.navigation.previous }));

    expect(screen.getByText("第1提示 / 4（2 / 6画面）")).toBeInTheDocument();
    expect(document.querySelector("[data-scene='result']")).not.toBeNull();
  });
});
