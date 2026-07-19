import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseExperimentConfig } from "../../../src/shared/index.js";
import { MockPufferDevice } from "../../../src/server/devices/index.js";
import type {
  ExperimentLogEvent,
  SessionLogSummary,
} from "../../../src/server/logging/index.js";
import { SessionController } from "../../../src/server/sessions/session-controller.js";

const CONFIG_HASH = "0".repeat(64);

function testConfig() {
  return parseExperimentConfig({
    schemaVersion: 1,
    protocolVersion: "test-v1",
    studyTitle: "テスト",
    bindHost: "127.0.0.1",
    port: 4173,
    researchIdPattern: "^SH26-[0-9]{3}$",
    orders: ["ABDC", "BCAD", "CDBA", "DACB"],
    fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
    timingMs: {
      handling: 10,
      processing: 10,
      result: 10,
      reset: 10,
      inflateRamp: 1,
      deflateRamp: 1,
    },
    device: {
      mode: "mock",
      serialPath: "",
      baudRate: 115200,
      ackTimeout: 100,
      allowMockInProduction: false,
    },
    formUrl: "",
    logging: { directory: "./data/test", includeAbortedInOrderBalancing: true },
    network: { allowLan: false, allowExternalRuntimeRequests: false },
  });
}

class MemoryLogger {
  public readonly events: ExperimentLogEvent[] = [];

  public async append(event: ExperimentLogEvent): Promise<void> {
    this.events.push(event);
  }

  public async exportCsv(): Promise<string> {
    return "sessionId\r\n";
  }

  public async hasResearchId(researchId: string): Promise<boolean> {
    return this.events.some((event) => event.researchId === researchId);
  }

  public async listSessionSummaries(): Promise<readonly SessionLogSummary[]> {
    return [];
  }
}

function makeController(orderSample = 0) {
  const device = new MockPufferDevice({ timingMode: "fast", initialConnected: true });
  const logger = new MemoryLogger();
  const controller = new SessionController({
    config: testConfig(),
    configHash: CONFIG_HASH,
    appVersion: "1.0.0",
    device,
    logger,
    random: () => orderSample,
    monotonicNow: () => Date.now(),
  });
  return { controller, device, logger };
}

async function preparedSession(
  controller: SessionController,
  orderCode: "ABDC" | "BCAD" | "CDBA" | "DACB" = "ABDC",
) {
  const created = await controller.create({
    researchId: "SH26-001",
    consentConfirmed: true,
    orderCode,
  });
  controller.markDisplayReady(created.displayToken, "display-1");
  await controller.prepare(created.snapshot.id);
  return created;
}

describe("SessionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs all four conditions using only server timers and exposes no internal code publicly", async () => {
    const { controller, logger } = makeController();
    const created = await preparedSession(controller, "ABDC");

    await controller.start(created.snapshot.id);
    await vi.advanceTimersByTimeAsync(4 * (10 + 10 + 10 + 10) + 10);

    const operator = controller.getOperatorSnapshot(created.snapshot.id);
    const participant = controller.getPublicSnapshot(created.displayToken);
    expect(operator.phase).toBe("summary");
    expect(participant.phase).toBe("summary");
    expect(participant.summary).toHaveLength(4);
    expect(JSON.stringify(participant)).not.toMatch(/SH26|ABDC|"A"|conditionCode|researchId|sessionId/u);
    expect(logger.events.filter((event) => event.eventType === "phase.result")).toHaveLength(4);

    const completed = await controller.confirmFormComplete(created.snapshot.id);
    expect(completed.phase).toBe("completed");
    expect(completed.result).toBe("ok");
    controller.dispose();
  });

  it("pauses a label phase on display loss and resumes only after an explicit command", async () => {
    const { controller } = makeController();
    const created = await preparedSession(controller, "ABDC");
    await controller.start(created.snapshot.id);

    await vi.advanceTimersByTimeAsync(4);
    controller.markDisplayDisconnected(created.displayToken, "display-1");
    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "handling",
      displayConnected: false,
      recoveryRequired: true,
      phaseEndsAt: null,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(controller.getOperatorSnapshot(created.snapshot.id).phase).toBe("handling");
    controller.markDisplayReady(created.displayToken, "display-2");
    expect(controller.getOperatorSnapshot(created.snapshot.id).recoveryRequired).toBe(true);
    await controller.resume(created.snapshot.id);
    await vi.advanceTimersByTimeAsync(7);
    expect(controller.getOperatorSnapshot(created.snapshot.id).phase).toBe("processing");
    controller.dispose();
  });

  it("uses STOP then DEFLATE and enters error when the display is lost during puffer output", async () => {
    const { controller, device } = makeController();
    const created = await preparedSession(controller, "CDBA");
    await controller.start(created.snapshot.id);
    await vi.advanceTimersByTimeAsync(21);
    expect(controller.getOperatorSnapshot(created.snapshot.id).phase).toBe("result");

    controller.markDisplayDisconnected(created.displayToken, "display-1");
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "error",
      result: "error",
      errorCode: "DISPLAY_LOST_DURING_PUFFER",
    });
    const safetyCommands = device.commandHistory
      .map((entry) => entry.command)
      .filter((command) => command === "stop" || command === "deflate");
    expect(safetyCommands.slice(-2)).toEqual(["stop", "deflate"]);
    controller.dispose();
  });

  it("rejects a reused research ID even after a setup session is deleted", async () => {
    const { controller } = makeController();
    const created = await controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    await controller.delete(created.snapshot.id);
    await expect(
      controller.create({ researchId: "SH26-001", consentConfirmed: true, orderCode: "ABDC" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_RESEARCH_ID", status: 409 });
    controller.dispose();
  });

  it("rejects start before the setup prerequisites and intro transition", async () => {
    const { controller } = makeController();
    const created = await controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    await expect(controller.start(created.snapshot.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
      status: 409,
    });
    controller.dispose();
  });

  it("makes emergency stop terminal and locks device tests until a new session", async () => {
    const { controller, device } = makeController();
    const created = await preparedSession(controller);
    await controller.start(created.snapshot.id);
    const stopped = await controller.emergencyStop(created.snapshot.id);
    expect(stopped).toMatchObject({ phase: "aborted", errorCode: "EMERGENCY_STOP" });
    expect(device.commandHistory.map((entry) => entry.command).slice(-2)).toEqual(["stop", "deflate"]);
    await expect(controller.testInflate(0.2)).rejects.toMatchObject({ code: "DEVICE_EMERGENCY_LOCKED" });
    controller.dispose();
  });
});
