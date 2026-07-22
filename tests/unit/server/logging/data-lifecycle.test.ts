import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLifecyclePlan,
  createRetentionReport,
  deleteResearchData,
  excludeResearchData,
  FORMAL_MUTATION_DISABLED_MESSAGE,
  GOOGLE_FORM_MANUAL_ACTION_NOTICE,
} from "../../../../src/server/logging/data-lifecycle.js";

const SESSION_1 = "11111111-1111-4111-8111-111111111111";
const SESSION_2 = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-21T08:30:00.000Z");
const roots: string[] = [];

function logEvent(researchId: string, sessionId: string): object {
  return {
    schemaVersion: 1,
    protocolVersion: "R8-010-2x2-screen-v2",
    appVersion: "1.0.0",
    configHash: "a".repeat(64),
    sessionId,
    researchId,
    orderCode: "ABDC",
    phase: "idle",
    eventType: "session.created",
    wallClockIso: "2026-07-01T00:00:00.000Z",
    monotonicMs: 1,
    fixedScore: 72,
    pufferLevel: 0.6,
    deviceMode: "screen",
    deviceStatus: "idle",
  };
}

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sechack-lifecycle-"));
  roots.push(root);
  await mkdir(join(root, "data", "sessions"), { recursive: true });
  return root;
}

async function writeSession(
  root: string,
  date: string,
  researchId: string,
  sessionId: string,
  events: readonly object[] = [logEvent(researchId, sessionId)],
): Promise<string> {
  const directory = join(root, "data", "sessions", date);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${researchId}_${sessionId}.jsonl`);
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("read-only research-data lifecycle inspection", () => {
  it("previews exact formal logs without modifying the filesystem", async () => {
    const root = await repositoryFixture();
    const target = await writeSession(root, "2026-07-01", "SH26-001", SESSION_1);
    await writeSession(root, "2026-07-01", "SH26-002", SESSION_2);
    const original = await readFile(target, "utf8");

    const plan = await createLifecyclePlan({
      repositoryRoot: root,
      researchId: "SH26-001",
      action: "delete",
      now: NOW,
    });

    expect(plan).toMatchObject({
      action: "delete",
      researchId: "SH26-001",
      targetCount: 1,
      mutationSupported: false,
      googleFormManualActionRequired: true,
      googleFormNotice: GOOGLE_FORM_MANUAL_ACTION_NOTICE,
    });
    expect(plan.targets).toEqual([expect.objectContaining({
      relativePath: `2026-07-01/SH26-001_${SESSION_1}.jsonl`,
      sessionId: SESSION_1,
      sha256: createHash("sha256").update(original).digest("hex"),
      sizeBytes: Buffer.byteLength(original),
    })]);
    await expect(readFile(target, "utf8")).resolves.toBe(original);
    expect(await readdir(join(root, "data"))).toEqual(["sessions"]);

    const repeated = await createLifecyclePlan({
      repositoryRoot: root,
      researchId: "SH26-001",
      action: "delete",
      now: new Date("2026-07-22T00:00:00.000Z"),
    });
    expect(repeated.planId).toBe(plan.planId);
  });

  it.each(["SH26-01", "SH26-0001", "sh26-001", "DEV-001", "person@example.test"])(
    "rejects invalid research ID %s",
    async (researchId) => {
      const root = await repositoryFixture();
      await expect(createLifecyclePlan({
        repositoryRoot: root,
        researchId,
        action: "delete",
      })).rejects.toThrow();
    },
  );

  it("fails closed on a mismatched event and non-canonical JSONL filename", async () => {
    const root = await repositoryFixture();
    await writeSession(
      root,
      "2026-07-01",
      "SH26-001",
      SESSION_1,
      [logEvent("SH26-002", SESSION_1)],
    );
    await expect(createLifecyclePlan({
      repositoryRoot: root,
      researchId: "SH26-001",
      action: "delete",
    })).rejects.toThrow(/canonical filename/iu);

    const otherRoot = await repositoryFixture();
    const dateDirectory = join(otherRoot, "data", "sessions", "2026-07-01");
    await mkdir(dateDirectory, { recursive: true });
    await writeFile(join(dateDirectory, "unknown.jsonl"), "{}\n", "utf8");
    await expect(createRetentionReport({
      repositoryRoot: otherRoot,
      retentionDays: 365,
    })).rejects.toThrow(/not canonical/iu);
  });

  it("rejects linked session files and directories", async () => {
    const root = await repositoryFixture();
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, `${JSON.stringify(logEvent("SH26-001", SESSION_1))}\n`, "utf8");
    const dateDirectory = join(root, "data", "sessions", "2026-07-01");
    await mkdir(dateDirectory);
    await link(outside, join(dateDirectory, `SH26-001_${SESSION_1}.jsonl`));
    await expect(createLifecyclePlan({
      repositoryRoot: root,
      researchId: "SH26-001",
      action: "delete",
    })).rejects.toThrow(/single-link/iu);

    const linkedRoot = await repositoryFixture();
    const outsideDirectory = join(linkedRoot, "outside");
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, join(linkedRoot, "data", "sessions", "2026-07-01"), "junction");
    await expect(createRetentionReport({
      repositoryRoot: linkedRoot,
      retentionDays: 365,
    })).rejects.toThrow(/real directory/iu);
  });

  it("unconditionally rejects exclusion and deletion without writing audit state", async () => {
    const root = await repositoryFixture();
    const target = await writeSession(root, "2026-07-01", "SH26-001", SESSION_1);
    const original = await readFile(target, "utf8");
    await expect(excludeResearchData({
      repositoryRoot: root,
      researchId: "SH26-001",
      confirmPlanId: "a".repeat(64),
    })).rejects.toThrow(FORMAL_MUTATION_DISABLED_MESSAGE);
    await expect(deleteResearchData({
      repositoryRoot: root,
      researchId: "SH26-001",
      confirmPlanId: "a".repeat(64),
      confirmDeletePhrase: "DELETE SH26-001",
    })).rejects.toThrow(FORMAL_MUTATION_DISABLED_MESSAGE);
    await expect(readFile(target, "utf8")).resolves.toBe(original);
    expect(await readdir(join(root, "data"))).toEqual(["sessions"]);
  });

  it("reports UTC-date retention candidates and never reports an exclusion state", async () => {
    const root = await repositoryFixture();
    await writeSession(root, "2026-07-01", "SH26-001", SESSION_1);
    const report = await createRetentionReport({
      repositoryRoot: root,
      retentionDays: 1,
      now: new Date("2026-07-01T15:30:00.000Z"),
    });
    expect(report).toMatchObject({
      asOf: "2026-07-01",
      mutationSupported: false,
      expiredCount: 0,
    });
    expect(report.entries[0]).not.toHaveProperty("excluded");

    const nextUtcDay = await createRetentionReport({
      repositoryRoot: root,
      retentionDays: 1,
      now: new Date("2026-07-02T00:00:00.000Z"),
    });
    expect(nextUtcDay).toMatchObject({ asOf: "2026-07-02", expiredCount: 1 });
  });
});
