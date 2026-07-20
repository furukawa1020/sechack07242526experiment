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
    expect(screen.getByRole("button", { name: PUBLIC_DEMO_COPY.navigation.previous })).toBeDisabled();
    expect(document.querySelector(".public-demo-kicker")).toBeNull();
  });

  it("shows all four fixed presentations without exposing internal condition codes", () => {
    render(<PublicDemoApp />);
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
      expect(within(screen.getByTestId("handling-panel")).getByText(processing)).toBeInTheDocument();
      expect(within(screen.getByTestId("result-panel")).getByText(result)).toBeInTheDocument();
      for (const code of ["A", "B", "C", "D"]) {
        expect(within(stage).queryByText(code, { exact: true })).not.toBeInTheDocument();
      }
      expect(stage.querySelector("[data-condition-code]")).toBeNull();
    });
  });

  it("uses only in-memory navigation and ends without a form or QR", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const localStorageSet = vi.spyOn(Storage.prototype, "setItem");
    const webSocketConstructor = vi.fn();
    vi.stubGlobal("WebSocket", webSocketConstructor);
    render(<PublicDemoApp />);

    for (let index = 0; index < 5; index += 1) next();

    expect(screen.getByTestId("public-demo-summary")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: PUBLIC_DEMO_COPY.summary.title })).toBeInTheDocument();
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
