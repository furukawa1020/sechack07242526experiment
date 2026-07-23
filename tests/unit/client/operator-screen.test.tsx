// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getDeviceStatus: vi.fn(),
  getOperatorConfig: vi.fn(),
  getSession: vi.fn(),
  sessionAction: vi.fn(),
}));

vi.mock("../../../src/client/shared/api.js", () => ({
  errorMessage: (error: unknown) => error instanceof Error ? error.message : "error",
  getOperatorToken: () => null,
  experimentApi: {
    getOperatorConfig: apiMocks.getOperatorConfig,
    getDeviceStatus: apiMocks.getDeviceStatus,
    getSession: apiMocks.getSession,
    sessionAction: apiMocks.sessionAction,
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
      protocolVersion: "R8-010-2x2-screen-v3",
      rehearsal: false,
    });
    apiMocks.getDeviceStatus.mockResolvedValue({
      mode: "screen",
      state: "idle",
      level: 0,
      fault: null,
      connected: true,
    });
    apiMocks.getSession.mockRejectedValue(new Error("no active session"));
    apiMocks.sessionAction.mockResolvedValue(null);
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
    expect(screen.getByText(/責任者が承認した提示前の手順を完了してください/u))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Googleフォーム|forms\.gle|QRコード/iu);
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
      protocolVersion: "R8-010-2x2-screen-v3",
      rehearsal: true,
    });
    render(<OperatorScreen />);

    expect(await screen.findByText("非参加者用の事前確認")).toBeInTheDocument();
    expect(screen.getByText("画面版・PILOT/テスト")).toBeInTheDocument();
    expect(screen.getByText(/本番参加者には使用しないでください/u)).toBeInTheDocument();
    expect(screen.getByText("リハーサル開始条件を確認済み")).toBeInTheDocument();
    expect(screen.queryByText("画面上のフグ・実機なし正式方式")).not.toBeInTheDocument();
    expect(screen.queryByText("参加者セッション")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Googleフォーム|forms\.gle|QRコード/iu);
  });

  it("uses a separate neutral confirmation action after each presentation", async () => {
    window.sessionStorage.setItem("sechack.active-session-id", "session-response");
    apiMocks.getSession.mockResolvedValue({
      rehearsal: false,
      phase: "response",
      sequenceIndex: 0,
      condition: { processing: "cloud", presentation: "label" },
      fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
      pufferSurface: "screen",
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
      phaseStartedAt: "2026-07-22T00:00:00.000Z",
      phaseEndsAt: null,
      serverNow: "2026-07-22T00:00:00.000Z",
      remainingMs: null,
      summary: [{ processing: "cloud", presentation: "label" }],
      sessionId: "session-response",
      researchId: "SH26-001",
      displayToken: "display-token",
      displayUrl: "/display/display-token",
      orderCode: "ABDC",
      conditionCode: "A",
      displayConnected: true,
      device: { mode: "screen", state: "idle", level: 0, fault: null, connected: true },
      protocolVersion: "R8-010-2x2-screen-v3",
      configVersion: "config-hash",
      recentEvents: [],
      errorCode: null,
      displayFullscreen: true,
    });

    render(<OperatorScreen />);

    expect(await screen.findByRole("heading", { name: "提示後のスタッフ確認" }))
      .toBeInTheDocument();
    expect(screen.getByText("参加者画面が待機表示になっていることを確認してください。"))
      .toBeInTheDocument();
    const next = screen.getByRole("button", { name: "待機表示を確認して次へ" });
    expect(next).toBeEnabled();
    expect(screen.queryByRole("checkbox", { name: "参加者への次の手順の案内を完了済み" }))
      .not.toBeInTheDocument();
    fireEvent.click(next);

    await waitFor(() => {
      expect(apiMocks.sessionAction).toHaveBeenCalledWith(
        "session-response",
        "confirm-response-checkpoint",
      );
    });
    expect(document.body.textContent).not.toMatch(/Googleフォーム|forms\.gle|QRコード|回答済み|回答完了/iu);
  });

  it("completes a summary only after the staff explicitly confirms the manual handoff", async () => {
    window.sessionStorage.setItem("sechack.active-session-id", "session-1");
    const summarySession = {
      rehearsal: false,
      phase: "summary",
      sequenceIndex: null,
      condition: null,
      fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
      pufferSurface: "screen",
      pufferRamp: { inflateMs: 6000, deflateMs: 6000 },
      phaseStartedAt: "2026-07-22T00:00:00.000Z",
      phaseEndsAt: null,
      serverNow: "2026-07-22T00:00:00.000Z",
      remainingMs: null,
      summary: [
        { processing: "cloud", presentation: "label" },
        { processing: "local", presentation: "label" },
        { processing: "cloud", presentation: "puffer" },
        { processing: "local", presentation: "puffer" },
      ],
      sessionId: "session-1",
      researchId: "SH26-001",
      displayToken: "display-token",
      displayUrl: "/display/display-token",
      orderCode: "ABDC",
      conditionCode: null,
      displayConnected: true,
      device: { mode: "screen", state: "idle", level: 0, fault: null, connected: true },
      protocolVersion: "R8-010-2x2-screen-v3",
      configVersion: "config-hash",
      recentEvents: [],
      errorCode: null,
      displayFullscreen: true,
    } as const;
    apiMocks.getSession.mockResolvedValue(summarySession);

    render(<OperatorScreen />);

    const confirmation = await screen.findByRole("checkbox", {
      name: "参加者への次の手順の案内を完了済み",
    });
    const complete = screen.getByRole("button", { name: "案内完了を確認してセッション完了" });
    expect(complete).toBeDisabled();
    fireEvent.click(confirmation);
    expect(complete).toBeEnabled();
    fireEvent.click(complete);

    await waitFor(() => {
      expect(apiMocks.sessionAction).toHaveBeenCalledWith("session-1", "confirm-staff-handoff");
    });
    expect(document.body.textContent).not.toMatch(/Googleフォーム|forms\.gle|QRコード/iu);
  });
});
