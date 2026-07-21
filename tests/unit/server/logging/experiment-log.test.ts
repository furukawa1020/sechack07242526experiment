import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createLogEvent,
  escapeCsvCell,
  ExperimentLogger,
  ExperimentLogEventSchema,
  parseLogEvent,
  sessionSummariesToCsv,
  type ExperimentLogEvent,
  type SessionLogSummary,
} from "../../../../src/server/logging/experiment-log.js";
import { createSession, type Session } from "../../../../src/shared/experiment-machine.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function session(overrides: Partial<Session> = {}): Session {
  return {
    ...createSession({
      id: SESSION_ID,
      researchId: "SH26-001",
      orderCode: "ABDC",
      fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
      deviceMode: "mock",
      configHash: "a".repeat(64),
      protocolVersion: "R8-010-2x2-mock-v3",
      wallClockIso: "2026-07-19T12:00:00.000Z",
      monotonicMs: 0,
    }),
    ...overrides,
  };
}

function event(
  overrides: Partial<Session> = {},
  eventOverrides: Partial<Parameters<typeof createLogEvent>[0]> = {},
): ExperimentLogEvent {
  return createLogEvent({
    session: session(overrides),
    appVersion: "1.0.0",
    eventType: "session.created",
    wallClockIso: "2026-07-19T12:00:00.000Z",
    monotonicMs: 1,
    ...eventOverrides,
  });
}

describe("ExperimentLogEvent allowlist", () => {
  it("builds an auditable condition event using only approved fields", () => {
    const created = event({
      phase: "result",
      sequenceIndex: 0,
      currentCondition: "A",
      deviceStatus: "holding",
    });
    expect(created).toMatchObject({
      conditionCode: "A",
      processing: "cloud",
      presentation: "label",
      fixedScore: 72,
      pufferLevel: 0.6,
      deviceStatus: "holding",
    });
    expect(Object.isFrozen(created)).toBe(true);
  });

  it("adds terminal result/error fields only when present", () => {
    expect(event()).not.toHaveProperty("result");
    expect(event({ phase: "error", result: "error", errorCode: "DEVICE_FAULT" })).toMatchObject({
      result: "error",
      errorCode: "DEVICE_FAULT",
    });
    expect(event({ phase: "error", result: "error" }, { errorCode: "ACK_TIMEOUT" }))
      .toHaveProperty("errorCode", "ACK_TIMEOUT");
  });

  it("rejects PII/unknown fields and contradictory condition metadata", () => {
    const valid = event({ phase: "result", sequenceIndex: 0, currentCondition: "A" });
    expect(() => parseLogEvent({ ...valid, email: "person@example.test" })).toThrow();
    expect(() => parseLogEvent({ ...valid, researchId: "person@example.test" })).toThrow();
    expect(() => parseLogEvent({ ...valid, processing: "local" })).toThrow(/does not match/iu);
    expect(() => parseLogEvent({ ...valid, presentation: "puffer" })).toThrow(/does not match/iu);
    expect(() => ExperimentLogEventSchema.parse({ ...valid, configHash: "not-a-hash" })).toThrow();
  });
});

describe("ExperimentLogger", () => {
  it("writes one JSONL stream per session and exports one CSV row", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sechack-logs-"));
    const logger = new ExperimentLogger({ directory });
    const first = event({
      phase: "handling",
      sequenceIndex: 0,
      currentCondition: "A",
    });
    const second = event({
      phase: "result",
      sequenceIndex: 1,
      currentCondition: "B",
    }, {
      eventType: "phase.result",
      wallClockIso: "2026-07-19T12:00:01.000Z",
      monotonicMs: 2,
    });
    const terminal = event({
      phase: "completed",
      sequenceIndex: 3,
      currentCondition: null,
      result: "ok",
    }, {
      eventType: "phase.completed",
      wallClockIso: "2026-07-19T12:00:02.000Z",
      monotonicMs: 3,
    });
    await Promise.all([logger.append(first), logger.append(second), logger.append(terminal)]);

    expect(await logger.readSession(SESSION_ID)).toHaveLength(3);
    expect(await logger.hasResearchId("SH26-001")).toBe(true);
    expect(await logger.hasResearchId("person@example.test")).toBe(false);
    const summaries = await logger.listSessionSummaries();
    expect(summaries).toEqual([expect.objectContaining({
      sessionId: SESSION_ID,
      result: "ok",
      presentationsStarted: 3,
      eventCount: 3,
      errorCode: null,
    })]);
    const csv = await logger.exportCsv();
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).toContain("SH26-001,ABDC");
  });

  it("returns empty collections when the log directory does not exist", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sechack-empty-"));
    const logger = new ExperimentLogger({ directory: join(parent, "missing") });
    expect(await logger.listEvents()).toEqual([]);
    expect(await logger.listSessionSummaries()).toEqual([]);
    expect(await logger.exportCsv()).toMatch(/^schemaVersion,/u);
    await expect(logger.readSession("not-a-uuid")).rejects.toThrow();
  });

  it("fails closed on malformed persisted JSONL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sechack-corrupt-"));
    const dateDirectory = join(directory, "2026-07-19");
    await mkdir(dateDirectory);
    await writeFile(join(dateDirectory, `SH26-001_${SESSION_ID}.jsonl`), "{bad json}\n", "utf8");
    const logger = new ExperimentLogger({ directory });
    await expect(logger.listEvents()).rejects.toThrow(/Invalid JSONL/iu);

    await writeFile(join(dateDirectory, `SH26-001_${SESSION_ID}.jsonl`),
      `${JSON.stringify({ ...event(), email: "person@example.test" })}\n`, "utf8");
    await expect(logger.listEvents()).rejects.toThrow();
  });

  it("validates its storage root and rejects invalid append input", async () => {
    expect(() => new ExperimentLogger({ directory: "bad\npath" })).toThrow(TypeError);
    expect(() => new ExperimentLogger({ directory: parse(tmpdir()).root })).toThrow(/filesystem root/iu);
    const directory = await mkdtemp(join(tmpdir(), "sechack-invalid-"));
    const logger = new ExperimentLogger({ directory });
    await expect(logger.append({ ...event(), ip: "127.0.0.1" } as unknown as ExperimentLogEvent))
      .rejects.toThrow();
  });

  it("reads only dated directories and JSONL files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sechack-filter-"));
    await mkdir(join(directory, "notes"));
    await writeFile(join(directory, "notes", "ignored.jsonl"), "garbage", "utf8");
    await mkdir(join(directory, "2026-07-19"));
    await writeFile(join(directory, "2026-07-19", "ignored.txt"), "garbage", "utf8");
    const logger = new ExperimentLogger({ directory });
    expect(await logger.listEvents()).toEqual([]);
  });

  it("rejects a dated directory junction that redirects logs outside the configured root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sechack-linked-logs-"));
    const directory = join(parent, "sessions");
    const outsideDirectory = join(parent, "outside");
    await mkdir(directory);
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, join(directory, "2026-07-19"), "junction");
    const logger = new ExperimentLogger({ directory });

    await expect(logger.append(event())).rejects.toThrow(/symbolic link|junction/iu);
    await expect(logger.listEvents()).rejects.toThrow(/symbolic link|junction/iu);
    expect(await readdir(outsideDirectory)).toEqual([]);
  });
});

describe("CSV safety", () => {
  it("neutralizes spreadsheet formulas and applies RFC-style quoting", () => {
    expect(escapeCsvCell("=1+1")).toBe("'=1+1");
    expect(escapeCsvCell("  -10")).toBe("'  -10");
    expect(escapeCsvCell("hello,world")).toBe('"hello,world"');
    expect(escapeCsvCell('say "hello"')).toBe('"say ""hello"""');
    expect(escapeCsvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(escapeCsvCell(72)).toBe("72");
    expect(escapeCsvCell(null)).toBe("");
  });

  it("sanitizes every exported summary value", () => {
    const summary: SessionLogSummary = {
      schemaVersion: 1,
      protocolVersion: "=FORMULA()",
      appVersion: "1.0.0",
      configHash: "a".repeat(64),
      sessionId: SESSION_ID,
      researchId: "SH26-001",
      orderCode: "ABDC",
      startedAt: "2026-07-19T12:00:00.000Z",
      endedAt: "2026-07-19T12:01:00.000Z",
      result: "aborted",
      presentationsStarted: 1,
      fixedScore: 72,
      pufferLevel: 0.6,
      deviceMode: "mock",
      errorCode: null,
      eventCount: 2,
    };
    expect(sessionSummariesToCsv([summary])).toContain("'=FORMULA()");
  });
});
