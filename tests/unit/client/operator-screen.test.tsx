// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getDeviceStatus: vi.fn(),
  getOperatorConfig: vi.fn(),
}));

vi.mock("../../../src/client/shared/api.js", () => ({
  errorMessage: (error: unknown) => error instanceof Error ? error.message : "error",
  getOperatorToken: () => null,
  experimentApi: {
    getOperatorConfig: apiMocks.getOperatorConfig,
    getDeviceStatus: apiMocks.getDeviceStatus,
  },
}));

vi.mock("../../../src/client/shared/realtime.js", () => ({
  useRealtime: () => ({ status: "open", send: () => true }),
  useRemainingSeconds: () => null,
}));

import { OperatorScreen } from "../../../src/client/operator/OperatorScreen.js";

describe("operator screen-mode guidance", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    apiMocks.getOperatorConfig.mockResolvedValue({
      researchIdPattern: "^SH26-[0-9]{3}$",
      protocolVersion: "R8-010-2x2-screen-v1",
      rehearsal: false,
    });
    apiMocks.getDeviceStatus.mockResolvedValue({
      mode: "screen",
      state: "idle",
      level: 0,
      fault: null,
      connected: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("identifies screen as a formal hardware-free mode and requires pre-presentation consent", async () => {
    render(<OperatorScreen />);

    expect(await screen.findByText("画面上のフグ・実機なし正式方式")).toBeInTheDocument();
    expect(screen.getByText("提示開始前に、承認済み手順で研究説明・参加同意を確認済み"))
      .toBeInTheDocument();
    expect(screen.getByText(/Googleフォームで事後送信する方式は、責任者承認済みの手順に限ります/u))
      .toBeInTheDocument();
    expect(screen.queryByText("非参加者用の事前確認")).not.toBeInTheDocument();
    expect(screen.queryByText(/本番参加者には使用しないでください/u)).not.toBeInTheDocument();
  });

  it("retains the explicit rehearsal warning for Mock", async () => {
    apiMocks.getDeviceStatus.mockResolvedValue({
      mode: "mock",
      state: "idle",
      level: 0,
      fault: null,
      connected: true,
    });
    render(<OperatorScreen />);

    expect(await screen.findByText("非参加者用の事前確認")).toBeInTheDocument();
    expect(screen.getByText(/本番参加者には使用しないでください/u)).toBeInTheDocument();
    expect(screen.getByText("リハーサル開始条件を確認済み")).toBeInTheDocument();
    expect(screen.queryByText("画面上のフグ・実機なし正式方式")).not.toBeInTheDocument();
  });

  it("keeps a screen-based test runtime visibly nonparticipant", async () => {
    apiMocks.getOperatorConfig.mockResolvedValue({
      researchIdPattern: "^TEST-[0-9]{3}$",
      protocolVersion: "R8-010-2x2-screen-v1",
      rehearsal: true,
    });
    render(<OperatorScreen />);

    expect(await screen.findByText("非参加者用の事前確認")).toBeInTheDocument();
    expect(screen.getByText("画面版・PILOT/テスト")).toBeInTheDocument();
    expect(screen.getByText(/本番参加者には使用しないでください/u)).toBeInTheDocument();
    expect(screen.getByText("リハーサル開始条件を確認済み")).toBeInTheDocument();
    expect(screen.queryByText("画面上のフグ・実機なし正式方式")).not.toBeInTheDocument();
    expect(screen.queryByText("参加者セッション")).not.toBeInTheDocument();
    expect(screen.queryByText(/Googleフォームの回答完了/u)).not.toBeInTheDocument();
  });
});
