import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseExperimentConfig } from "../../../src/shared/index.js";
import {
  MockPufferDevice,
  type DeflateInput,
  type DeviceAck,
  type DeviceStatus,
  type InflateInput,
  type StopInput,
} from "../../../src/server/devices/index.js";
import type {
  ExperimentLogEvent,
  SessionLogSummary,
} from "../../../src/server/logging/index.js";
import { SessionController } from "../../../src/server/sessions/session-controller.js";

const CONFIG_HASH = "0".repeat(64);

function testConfig(formUrl = "") {
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
    formUrl,
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

class ResultAuditGateLogger extends MemoryLogger {
  private resolveResultAuditStarted: (() => void) | null = null;
  private releaseResultAuditGate: (() => void) | null = null;
  public readonly resultAuditStarted = new Promise<void>((resolve) => {
    this.resolveResultAuditStarted = resolve;
  });
  private readonly resultAuditGate = new Promise<void>((resolve) => {
    this.releaseResultAuditGate = resolve;
  });

  public override async append(event: ExperimentLogEvent): Promise<void> {
    if (event.eventType === "phase.result") {
      this.resolveResultAuditStarted?.();
      await this.resultAuditGate;
    }
    await super.append(event);
  }

  public releaseResultAudit(): void {
    this.releaseResultAuditGate?.();
  }
}

class FailOnceLogger extends MemoryLogger {
  private failed = false;

  public constructor(private readonly failingEventType: string) {
    super();
  }

  public override async append(event: ExperimentLogEvent): Promise<void> {
    if (!this.failed && event.eventType === this.failingEventType) {
      this.failed = true;
      throw new Error("injected audit storage failure");
    }
    await super.append(event);
  }
}

class EventGateLogger extends MemoryLogger {
  private resolveStarted: (() => void) | null = null;
  private releaseGate: (() => void) | null = null;
  public readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  public constructor(private readonly gatedEventType: string) {
    super();
  }

  public override async append(event: ExperimentLogEvent): Promise<void> {
    if (event.eventType === this.gatedEventType) {
      this.resolveStarted?.();
      await this.gate;
    }
    await super.append(event);
  }

  public release(): void {
    this.releaseGate?.();
  }
}

class SummaryLogger extends MemoryLogger {
  public override async listSessionSummaries(): Promise<readonly SessionLogSummary[]> {
    return [{
      schemaVersion: 1,
      protocolVersion: "test-v1",
      appVersion: "1.0.0",
      configHash: CONFIG_HASH,
      sessionId: "prior-session",
      researchId: "SH26-999",
      orderCode: "ABDC",
      startedAt: "2026-07-18T00:00:00.000Z",
      endedAt: "2026-07-18T00:01:00.000Z",
      result: "ok",
      presentationsStarted: 4,
      fixedScore: 72,
      pufferLevel: 0.6,
      deviceMode: "mock",
      errorCode: null,
      eventCount: 20,
    }];
  }
}

class RejectingInflateDevice extends MockPufferDevice {
  public override async inflate(_input: InflateInput): Promise<DeviceAck> {
    void _input;
    throw Object.assign(new Error("injected inflate rejection"), { code: "INFLATE_REJECTED" });
  }
}

class UnsafeAfterDeflateDevice extends MockPufferDevice {
  private reportUnsafe = false;

  public override async deflate(input: DeflateInput): Promise<DeviceAck> {
    const ack = await super.deflate(input);
    this.reportUnsafe = true;
    return ack;
  }

  public override async getStatus(): Promise<DeviceStatus> {
    const status = await super.getStatus();
    return this.reportUnsafe
      ? Object.freeze({ ...status, state: "stopped" as const, level: 0.6 })
      : status;
  }
}

class FailingSafetyDevice extends MockPufferDevice {
  public stopAttempts = 0;
  public deflateAttempts = 0;

  public override async stop(_input: StopInput): Promise<DeviceAck> {
    void _input;
    this.stopAttempts += 1;
    throw Object.assign(new Error("injected STOP failure"), { code: "STOP_FAILED" });
  }

  public override async deflate(_input: DeflateInput): Promise<DeviceAck> {
    void _input;
    this.deflateAttempts += 1;
    throw Object.assign(new Error("injected DEFLATE failure"), { code: "DEFLATE_FAILED" });
  }
}

function makeController(
  orderSample = 0,
  options: {
    readonly logger?: MemoryLogger;
    readonly device?: MockPufferDevice;
    readonly formUrl?: string;
    readonly rehearsal?: boolean;
  } = {},
) {
  const device = options.device ?? new MockPufferDevice({ timingMode: "fast", initialConnected: true });
  const logger = options.logger ?? new MemoryLogger();
  const controller = new SessionController({
    config: testConfig(options.formUrl),
    configHash: CONFIG_HASH,
    appVersion: "1.0.0",
    rehearsal: options.rehearsal ?? false,
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

function waitForSessionError(controller: SessionController): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = controller.subscribe((event) => {
      if (event.type === "session.error") {
        unsubscribe();
        resolve();
      }
    });
  });
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
    expect(participant.fixedState).toBeNull();
    expect(JSON.stringify(participant)).not.toMatch(/SH26|ABDC|"A"|conditionCode|researchId|sessionId/u);
    expect(JSON.stringify(participant)).not.toContain("pufferLevel");
    expect(logger.events.filter((event) => event.eventType === "phase.result")).toHaveLength(4);

    const completed = await controller.confirmFormComplete(created.snapshot.id);
    expect(completed.phase).toBe("completed");
    expect(completed.result).toBe("ok");
    controller.dispose();
  });

  it("marks participant state as rehearsal only for an explicit rehearsal server", async () => {
    const regular = makeController();
    const regularSession = await regular.controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    expect(regular.controller.getPublicSnapshot(regularSession.displayToken).rehearsal).toBe(false);
    regular.controller.dispose();

    const rehearsal = makeController(0, { rehearsal: true });
    const rehearsalSession = await rehearsal.controller.create({
      researchId: "SH26-002",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    expect(rehearsal.controller.getPublicSnapshot(rehearsalSession.displayToken).rehearsal).toBe(true);
    rehearsal.controller.dispose();
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
    expect(device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
    expect(device.commandHistory.at(-1)?.command).toBe("status");
    await expect(controller.testInflate(0.2)).rejects.toMatchObject({ code: "DEVICE_EMERGENCY_LOCKED" });
    controller.dispose();
  });

  it("allows only one winner when session creation requests race", async () => {
    const { controller } = makeController();

    const outcomes = await Promise.allSettled([
      controller.create({ researchId: "SH26-001", consentConfirmed: true, orderCode: "ABDC" }),
      controller.create({ researchId: "SH26-002", consentConfirmed: true, orderCode: "BCAD" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "ACTIVE_SESSION_EXISTS", status: 409 });
    }
    controller.dispose();
  });

  it("does not issue a delayed INFLATE after emergency stop while result audit is pending", async () => {
    const logger = new ResultAuditGateLogger();
    const { controller, device } = makeController(0, { logger });
    const created = await preparedSession(controller, "CDBA");
    await controller.start(created.snapshot.id);

    await vi.advanceTimersByTimeAsync(20);
    await logger.resultAuditStarted;
    expect(controller.getOperatorSnapshot(created.snapshot.id).phase).toBe("result");
    expect(device.commandHistory.filter((entry) => entry.command === "inflate")).toHaveLength(1);

    const stopped = await controller.emergencyStop(created.snapshot.id);
    expect(stopped).toMatchObject({ phase: "aborted", errorCode: "EMERGENCY_STOP" });
    const historyLengthAfterEmergency = device.commandHistory.length;

    logger.releaseResultAudit();
    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTicks();

    expect(device.commandHistory.slice(historyLengthAfterEmergency).map((entry) => entry.command))
      .not.toContain("inflate");
    expect(device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
    controller.dispose();
  });

  it("does not overwrite a completed terminal state when emergency stop races completion", async () => {
    const { controller, device } = makeController();
    const created = await preparedSession(controller, "ABDC");
    await controller.start(created.snapshot.id);
    await vi.advanceTimersByTimeAsync(4 * (10 + 10 + 10 + 10) + 10);
    expect(controller.getOperatorSnapshot(created.snapshot.id).phase).toBe("summary");

    const completion = controller.confirmFormComplete(created.snapshot.id);
    const emergency = controller.emergencyStop(created.snapshot.id);
    const [completedView, emergencyView] = await Promise.all([completion, emergency]);

    expect(completedView).toMatchObject({ phase: "completed", result: "ok", errorCode: null });
    expect(emergencyView).toMatchObject({ phase: "completed", result: "ok", errorCode: null });
    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "completed",
      result: "ok",
      errorCode: null,
    });
    expect(device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
    controller.dispose();
  });

  it("treats a device STOP during a running presentation as an aborted emergency stop", async () => {
    const { controller, device } = makeController();
    const created = await preparedSession(controller, "ABDC");
    await controller.start(created.snapshot.id);

    await controller.stopDevice();

    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "aborted",
      result: "aborted",
      errorCode: "EMERGENCY_STOP",
    });
    expect(device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
    controller.dispose();
  });

  it("rejects a second simultaneous participant display connection", async () => {
    const { controller } = makeController();
    const created = await controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    controller.markDisplayReady(created.displayToken, "display-1");

    expect(() => controller.markDisplayReady(created.displayToken, "display-2"))
      .toThrow(expect.objectContaining({ code: "DISPLAY_ALREADY_CONNECTED", status: 409 }));
    expect(controller.getOperatorSnapshot(created.snapshot.id).displayConnected).toBe(true);
    controller.dispose();
  });

  it("omits score, label, and puffer level from the public DTO during a puffer result", async () => {
    const { controller } = makeController();
    const created = await preparedSession(controller, "CDBA");
    await controller.start(created.snapshot.id);
    await vi.advanceTimersByTimeAsync(21);

    const participant = controller.getPublicSnapshot(created.displayToken);
    const serialized = JSON.stringify(participant);
    expect(participant).toMatchObject({ phase: "result", fixedState: null });
    expect(serialized).not.toContain("score");
    expect(serialized).not.toContain("label");
    expect(serialized).not.toContain("pufferLevel");
    controller.dispose();
  });

  it("fails safely without an unhandled rejection when phase audit storage fails", async () => {
    const logger = new FailOnceLogger("phase.processing");
    const { controller, device } = makeController(0, { logger });
    const created = await preparedSession(controller, "ABDC");
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledReasons.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const errorReached = new Promise<void>((resolve) => {
        controller.subscribe((event) => {
          if (event.type === "session.error") resolve();
        });
      });
      await controller.start(created.snapshot.id);
      await vi.advanceTimersByTimeAsync(10);
      await errorReached;
      await vi.advanceTimersByTimeAsync(0);
      await vi.runAllTicks();

      expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
        phase: "error",
        result: "error",
        errorCode: "AUDIT_STORAGE_FAILED",
      });
      expect(device.commandHistory.map((entry) => entry.command).filter((command) =>
        command === "stop" || command === "deflate"
      ).slice(-2)).toEqual(["stop", "deflate"]);
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      controller.dispose();
    }
  });

  it("keeps C and D puffer actuator command histories identical", async () => {
    const runFirstPuffer = async (orderCode: "CDBA" | "DACB") => {
      const { controller, device } = makeController();
      const created = await preparedSession(controller, orderCode);
      await controller.start(created.snapshot.id);
      await vi.advanceTimersByTimeAsync(31);
      const commands = device.commandHistory
        .filter((entry) => entry.command === "inflate" || entry.command === "deflate")
        .map((entry) => ({ command: entry.command, level: entry.level, rampMs: entry.rampMs }));
      controller.dispose();
      return commands;
    };

    expect(await runFirstPuffer("CDBA")).toEqual(await runFirstPuffer("DACB"));
  });

  it("rejects invalid setup inputs before reserving an active session", async () => {
    const { controller } = makeController();

    await expect(controller.create({
      researchId: "SH26-001",
      consentConfirmed: false as true,
      orderCode: "ABDC",
    })).rejects.toMatchObject({ code: "CONSENT_NOT_CONFIRMED", status: 400 });
    await expect(controller.create({
      researchId: "contains spaces",
      consentConfirmed: true,
      orderCode: "ABDC",
    })).rejects.toMatchObject({ code: "INVALID_RESEARCH_ID", status: 400 });
    await expect(controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "INVALID" as never,
    })).rejects.toMatchObject({ code: "INVALID_ORDER_CODE", status: 400 });
    expect(controller.getActiveOperatorSnapshot()).toBeNull();
    controller.dispose();
  });

  it("rolls back reservation and blocks new sessions when the audit store becomes unavailable", async () => {
    const logger = new FailOnceLogger("session.created");
    const { controller } = makeController(0, { logger });
    const input = { researchId: "SH26-001", consentConfirmed: true as const, orderCode: "ABDC" as const };

    await expect(controller.create(input)).rejects.toThrow("injected audit storage failure");
    expect(controller.getActiveOperatorSnapshot()).toBeNull();
    await expect(controller.create(input)).rejects.toMatchObject({
      code: "AUDIT_STORAGE_UNAVAILABLE",
      status: 409,
    });
    controller.dispose();
  });

  it("allocates an automatic order from logged summaries", async () => {
    const logger = new SummaryLogger();
    const { controller } = makeController(0, { logger });
    const created = await controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "auto",
    });

    expect(["ABDC", "BCAD", "CDBA", "DACB"]).toContain(created.snapshot.orderCode);
    expect(created.snapshot.orderCode).not.toBe("ABDC");
    controller.dispose();
  });

  it("enforces participant token, readiness, heartbeat, and fullscreen guards", async () => {
    const { controller } = makeController();
    expect(controller.getDeviceMode()).toBe("mock");
    await expect(controller.exportCsv()).resolves.toBe("sessionId\r\n");
    expect(() => controller.get("missing-session")).toThrow(expect.objectContaining({
      code: "SESSION_NOT_FOUND",
      status: 404,
    }));
    expect(() => controller.resolveDisplayToken("missing-token")).toThrow(expect.objectContaining({
      code: "DISPLAY_TOKEN_NOT_FOUND",
      status: 404,
    }));

    const created = await controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    await expect(controller.prepare(created.snapshot.id)).rejects.toMatchObject({ code: "DISPLAY_NOT_READY" });

    controller.noteDisplayHeartbeat(created.displayToken, "display-1");
    expect(controller.resolveDisplayToken(created.displayToken)).toBe(created.snapshot.id);
    expect(() => controller.markDisplayFullscreen(created.displayToken, "unknown-display", true))
      .toThrow(expect.objectContaining({ code: "DISPLAY_NOT_READY" }));
    controller.markDisplayFullscreen(created.displayToken, "display-1", true);
    controller.markDisplayFullscreen(created.displayToken, "display-1", true);
    expect(controller.getOperatorSnapshot(created.snapshot.id).displayFullscreen).toBe(true);

    controller.noteDisplayHeartbeat(created.displayToken, "display-1");
    controller.markDisplayDisconnected(created.displayToken, "unknown-display");
    expect(controller.getOperatorSnapshot(created.snapshot.id).displayConnected).toBe(true);
    controller.markDisplayDisconnected(created.displayToken, "display-1");
    controller.markDisplayDisconnected(created.displayToken, "display-1");
    controller.markDisplayDisconnected("missing-token", "display-1");
    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      displayConnected: false,
      displayFullscreen: null,
    });
    controller.dispose();
  });

  it("requires explicit recovery during intro and rejects resume without a ready display", async () => {
    const { controller } = makeController();
    const created = await preparedSession(controller, "ABDC");
    await expect(controller.resume(created.snapshot.id)).rejects.toMatchObject({ code: "RECOVERY_NOT_REQUIRED" });

    controller.markDisplayDisconnected(created.displayToken, "display-1");
    await expect(controller.resume(created.snapshot.id)).rejects.toMatchObject({ code: "DISPLAY_NOT_READY" });
    controller.markDisplayReady(created.displayToken, "display-2");
    await expect(controller.start(created.snapshot.id)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    const resumed = await controller.resume(created.snapshot.id);
    expect(resumed).toMatchObject({ phase: "intro", recoveryRequired: false, displayConnected: true });
    await expect(controller.start(created.snapshot.id)).resolves.toMatchObject({ phase: "handling" });
    controller.dispose();
  });

  it("refuses to resume a timed phase once its safe remaining time is exhausted", async () => {
    const { controller } = makeController();
    const created = await preparedSession(controller, "ABDC");
    await controller.start(created.snapshot.id);
    vi.setSystemTime(new Date("2026-07-19T00:00:00.020Z"));

    controller.markDisplayDisconnected(created.displayToken, "display-1");
    controller.markDisplayReady(created.displayToken, "display-2");
    await expect(controller.resume(created.snapshot.id)).rejects.toMatchObject({ code: "SESSION_NOT_RESUMABLE" });
    controller.dispose();
  });

  it("moves to a safe error if recovery audit storage fails", async () => {
    const logger = new FailOnceLogger("session.resumed");
    const { controller, device } = makeController(0, { logger });
    const created = await preparedSession(controller, "ABDC");
    controller.markDisplayDisconnected(created.displayToken, "display-1");
    controller.markDisplayReady(created.displayToken, "display-2");

    const resumed = await controller.resume(created.snapshot.id);

    expect(resumed).toMatchObject({ phase: "error", errorCode: "AUDIT_STORAGE_FAILED" });
    expect(device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
    controller.dispose();
  });

  it("fails closed when a background display audit rejects", async () => {
    const logger = new FailOnceLogger("display.disconnected");
    const { controller, device } = makeController(0, { logger });
    const created = await preparedSession(controller, "ABDC");
    const errorReached = waitForSessionError(controller);

    controller.markDisplayDisconnected(created.displayToken, "display-1");
    await errorReached;
    await vi.runAllTicks();

    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "error",
      errorCode: "AUDIT_STORAGE_FAILED",
    });
    expect(device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
    controller.dispose();
  });

  it("aborts an unattended run and protects running and error sessions from deletion", async () => {
    const { controller, device } = makeController();
    controller.markOperatorDisconnected();
    const created = await controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    controller.markOperatorDisconnected();
    expect(controller.getOperatorSnapshot(created.snapshot.id).phase).toBe("setup");
    controller.markDisplayReady(created.displayToken, "display-1");
    await controller.prepare(created.snapshot.id);
    await controller.start(created.snapshot.id);
    await expect(controller.delete(created.snapshot.id)).rejects.toMatchObject({ code: "SESSION_DELETE_UNSAFE" });
    const errorReached = waitForSessionError(controller);

    controller.markOperatorDisconnected();
    await errorReached;
    await vi.runAllTicks();

    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "error",
      errorCode: "OPERATOR_CONNECTION_LOST",
    });
    expect(device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
    await expect(controller.delete(created.snapshot.id)).rejects.toMatchObject({ code: "SESSION_DELETE_UNSAFE" });
    controller.dispose();
  });

  it("exercises safe device-test operations only when no run is active", async () => {
    const device = new MockPufferDevice({ timingMode: "fast", initialConnected: false });
    const { controller } = makeController(0, { device });

    await expect(controller.connectDevice()).resolves.toMatchObject({ connected: true, state: "idle" });
    await expect(controller.connectDevice()).resolves.toMatchObject({ connected: true, state: "idle" });
    await expect(controller.pingDevice()).resolves.toMatchObject({ connected: true });
    await expect(controller.testInflate(-0.1)).rejects.toMatchObject({ code: "DEVICE_LEVEL_OUT_OF_RANGE" });
    await expect(controller.testInflate(0.7)).rejects.toMatchObject({ code: "DEVICE_LEVEL_OUT_OF_RANGE" });
    await expect(controller.testInflate(0.2)).resolves.toMatchObject({
      ack: { ok: true },
      status: { connected: true },
    });
    await expect(controller.testDeflate()).resolves.toMatchObject({ ack: { ok: true } });
    await expect(controller.stopDevice()).resolves.toMatchObject({ ack: { ok: true } });
    await expect(controller.disconnectDevice()).resolves.toMatchObject({ connected: false, state: "disconnected" });
    await expect(controller.getDeviceStatus()).resolves.toMatchObject({ connected: false, state: "disconnected" });
    controller.dispose();
  });

  it("rejects inflation tests unless the device is confirmed idle and deflated", async () => {
    const { controller, device } = makeController();
    await device.inflate({ requestId: "unsafe-precondition", level: 0.2, rampMs: 0 });
    await vi.runAllTicks();

    await expect(controller.testInflate(0.2)).rejects.toMatchObject({ code: "DEVICE_NOT_READY" });
    controller.dispose();
  });

  it("propagates device-status failures when the last status was not disconnected", async () => {
    const { controller, device } = makeController();
    device.inject({ kind: "timeout", command: "status" });

    await expect(controller.getDeviceStatus()).rejects.toMatchObject({ code: "ACK_TIMEOUT" });
    controller.dispose();
  });

  it("locks all unsafe device-test actions while a presentation is active", async () => {
    const { controller } = makeController();
    const created = await preparedSession(controller, "ABDC");
    await controller.start(created.snapshot.id);

    await expect(controller.pingDevice()).rejects.toMatchObject({ code: "DEVICE_TEST_LOCKED" });
    await expect(controller.disconnectDevice()).rejects.toMatchObject({ code: "DEVICE_TEST_LOCKED" });
    await expect(controller.testDeflate()).rejects.toMatchObject({ code: "DEVICE_TEST_LOCKED" });
    controller.dispose();
  });

  it("executes every shutdown path with STOP followed by DEFLATE", async () => {
    const noSession = makeController();
    await noSession.controller.shutdown();
    expect(noSession.device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
    expect(noSession.device.commandHistory.at(-1)?.command).toBe("status");
    noSession.controller.dispose();

    const active = makeController();
    const created = await active.controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    await active.controller.shutdown();
    expect(active.controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "aborted",
      result: "aborted",
    });
    expect(active.device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
    expect(active.device.commandHistory.at(-1)?.command).toBe("status");
    active.controller.dispose();

    const logger = new EventGateLogger("session.completed");
    const terminal = makeController(0, { logger });
    const terminalCreated = await preparedSession(terminal.controller, "ABDC");
    await terminal.controller.start(terminalCreated.snapshot.id);
    await vi.advanceTimersByTimeAsync(4 * (10 + 10 + 10 + 10) + 10);
    const completion = terminal.controller.confirmFormComplete(terminalCreated.snapshot.id);
    await logger.started;
    await terminal.controller.shutdown();
    logger.release();
    await completion;
    expect(terminal.controller.getOperatorSnapshot(terminalCreated.snapshot.id).phase).toBe("completed");
    expect(terminal.device.commandHistory.map((entry) => entry.command).filter((command) =>
      command === "stop" || command === "deflate"
    ).slice(-2)).toEqual(["stop", "deflate"]);
    terminal.controller.dispose();
  });

  it("attempts both safety commands and audits failure when STOP and DEFLATE fail", async () => {
    const device = new FailingSafetyDevice({ timingMode: "fast", initialConnected: true });
    const { controller, logger } = makeController(0, { device });
    const created = await controller.create({
      researchId: "SH26-001",
      consentConfirmed: true,
      orderCode: "ABDC",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(controller.abort(created.snapshot.id)).rejects.toMatchObject({
        code: "DEVICE_SAFETY_UNCONFIRMED",
        status: 409,
      });
      expect(controller.getOperatorSnapshot(created.snapshot.id).phase).toBe("aborted");
      expect(device.stopAttempts).toBe(1);
      expect(device.deflateAttempts).toBe(1);
      expect(logger.events.some((event) => event.eventType === "device.safetyCommandFailed")).toBe(true);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("STOP_FAILED"));
    } finally {
      consoleError.mockRestore();
      controller.dispose();
    }
  });

  it("uses the device error code when puffer inflation fails without a status event", async () => {
    const device = new RejectingInflateDevice({ timingMode: "fast", initialConnected: true });
    const { controller } = makeController(0, { device });
    const created = await preparedSession(controller, "CDBA");
    const errorReached = waitForSessionError(controller);
    await controller.start(created.snapshot.id);

    await vi.advanceTimersByTimeAsync(20);
    await errorReached;

    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "error",
      errorCode: "INFLATE_REJECTED",
    });
    controller.dispose();
  });

  it("stops the run if reset cannot confirm an idle and fully deflated device", async () => {
    const device = new UnsafeAfterDeflateDevice({ timingMode: "fast", initialConnected: true });
    const { controller } = makeController(0, { device });
    const created = await preparedSession(controller, "CDBA");
    const errorReached = waitForSessionError(controller);
    await controller.start(created.snapshot.id);

    await vi.advanceTimersByTimeAsync(40);
    await errorReached;

    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "error",
      errorCode: "DEFLATE_NOT_CONFIRMED",
    });
    controller.dispose();
  });

  it.each([
    { kind: "fault" as const, errorCode: "DEVICE_FAULT" },
    { kind: "disconnect" as const, errorCode: "DEVICE_DISCONNECTED" },
  ])("fails an active run on an asynchronous device $kind status", async ({ kind, errorCode }) => {
    const { controller, device } = makeController();
    const created = await preparedSession(controller, "ABDC");
    await controller.start(created.snapshot.id);
    const errorReached = waitForSessionError(controller);
    device.inject({ kind, command: "ping", errorCode: "INJECTED_FAULT" });

    await expect(device.ping()).rejects.toBeInstanceOf(Error);
    await errorReached;

    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({ phase: "error", errorCode });
    controller.dispose();
  });

  it("fails safely when device acknowledgement audit storage fails", async () => {
    const logger = new FailOnceLogger("device.inflate.ack");
    const { controller } = makeController(0, { logger });
    const created = await preparedSession(controller, "CDBA");
    const errorReached = waitForSessionError(controller);
    await controller.start(created.snapshot.id);

    await vi.advanceTimersByTimeAsync(20);
    await errorReached;

    expect(controller.getOperatorSnapshot(created.snapshot.id)).toMatchObject({
      phase: "error",
      errorCode: "AUDIT_STORAGE_FAILED",
    });
    controller.dispose();
  });

  it("exposes the configured form link only after all four presentations", async () => {
    const formUrl = "https://docs.google.com/forms/d/e/test/viewform";
    const { controller } = makeController(0, { formUrl });
    const created = await preparedSession(controller, "ABDC");
    expect(controller.getPublicSnapshot(created.displayToken).formUrl).toBeNull();
    await controller.start(created.snapshot.id);
    await vi.advanceTimersByTimeAsync(4 * (10 + 10 + 10 + 10) + 10);

    expect(controller.getPublicSnapshot(created.displayToken)).toMatchObject({
      phase: "summary",
      formUrl,
    });
    controller.dispose();
  });
});
