// @vitest-environment jsdom

import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PublicDeviceTestApp,
  PublicDisplayApp,
  PublicHealthApp,
  PublicOperatorApp,
} from "../../../src/client/public-demo/ReviewApps.js";

class FakeBroadcastChannel {
  static readonly instances = new Set<FakeBroadcastChannel>();

  readonly name: string;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.add(this);
  }

  postMessage(data: unknown): void {
    for (const instance of FakeBroadcastChannel.instances) {
      if (instance !== this && instance.name === this.name) {
        instance.onmessage?.({ data } as MessageEvent<unknown>);
      }
    }
  }

  close(): void {
    FakeBroadcastChannel.instances.delete(this);
  }
}

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
});

afterEach(() => {
  cleanup();
  FakeBroadcastChannel.instances.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public review routes", () => {
  it("synchronizes only a fixed display step through an in-memory browser channel", () => {
    const localStorageSet = vi.spyOn(Storage.prototype, "setItem");
    const operator = render(<PublicOperatorApp />);
    const display = render(<PublicDisplayApp />);

    expect(within(display.container).queryByText(/接続を待っています/u)).not.toBeInTheDocument();
    fireEvent.click(within(operator.container).getByRole("button", { name: "第1提示" }));

    expect(within(display.container).getByText("第1提示 / 4")).toBeInTheDocument();
    expect(within(display.container).getByRole("main", {
      name: "読み取り専用の参加者表示レビュー",
    })).toBeInTheDocument();
    expect(display.container.querySelectorAll("main")).toHaveLength(1);
    expect(within(display.container).getByText("クラウド", { exact: true })).toBeInTheDocument();
    expect(within(display.container).queryByRole("button")).not.toBeInTheDocument();
    expect(within(display.container).queryByRole("link")).not.toBeInTheDocument();
    expect(localStorageSet).not.toHaveBeenCalled();
  });

  it("connects a waiting display when the operator page opens later", () => {
    const display = render(<PublicDisplayApp />);

    expect(within(display.container).getByText(/接続を待っています/u)).toBeInTheDocument();
    const operator = render(<PublicOperatorApp />);

    expect(within(display.container).queryByText(/接続を待っています/u)).not.toBeInTheDocument();
    fireEvent.click(within(operator.container).getByRole("button", { name: "第2提示" }));
    expect(within(display.container).getByText("第2提示 / 4")).toBeInTheDocument();
  });

  it("keeps the public device page visual and hardware-free", () => {
    const view = render(<PublicDeviceTestApp />);

    expect(within(view.container).getByText("未接続", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(view.container).getByRole("button", { name: "模擬装置を接続" }));
    fireEvent.click(within(view.container).getByRole("button", { name: "膨張を模擬" }));
    expect(within(view.container).getByText("膨張状態を模擬中", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(view.container).getByRole("button", { name: /^停止$/u }));
    expect(within(view.container).getByText("停止済み", { exact: true })).toBeInTheDocument();
    for (const button of within(view.container).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("shows an accurate fallback when tab synchronization is unavailable", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("BroadcastChannel", undefined);
    const operator = render(<PublicOperatorApp />);
    const display = render(<PublicDisplayApp />);

    expect(
      within(operator.container).getByText(/タブ間同期を利用できません/u),
    ).toBeInTheDocument();
    expect(within(display.container).getByText(/タブ間同期を利用できません/u)).toBeInTheDocument();
    expect(
      within(display.container).getByRole("link", { name: "手動デモを開く" }),
    ).toHaveAttribute("href", "/");
  });

  it("falls back without crashing when the browser rejects channel creation", async () => {
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor() {
          throw new Error("BroadcastChannel construction failed");
        }
      },
    );
    const operator = render(<PublicOperatorApp />);
    const display = render(<PublicDisplayApp />);

    expect(
      await within(operator.container).findByText(/タブ間同期を利用できません/u),
    ).toBeInTheDocument();
    expect(
      await within(display.container).findByText(/タブ間同期を利用できません/u),
    ).toBeInTheDocument();
    expect(
      within(display.container).getByRole("link", { name: "手動デモを開く" }),
    ).toBeInTheDocument();
  });

  it("falls back without crashing when the browser rejects channel messages", async () => {
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

        postMessage(): void {
          throw new Error("BroadcastChannel post failed");
        }

        close(): void {}
      },
    );
    const operator = render(<PublicOperatorApp />);
    const display = render(<PublicDisplayApp />);

    expect(
      await within(operator.container).findByText(/タブ間同期を利用できません/u),
    ).toBeInTheDocument();
    expect(
      await within(display.container).findByText(/タブ間同期を利用できません/u),
    ).toBeInTheDocument();
    expect(
      within(display.container).getByRole("link", { name: "手動デモを開く" }),
    ).toBeInTheDocument();
  });

  it("renders a static health page without collecting input", () => {
    const view = render(<PublicHealthApp />);

    expect(
      within(view.container).getByRole("heading", {
        name: "公開レビュー版は正常に配信されています",
      }),
    ).toBeInTheDocument();
    expect(within(view.container).queryByRole("textbox")).not.toBeInTheDocument();
  });
});
