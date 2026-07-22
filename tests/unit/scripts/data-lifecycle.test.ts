import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseDataLifecycleArguments,
  runDataLifecycle,
} from "../../../scripts/data-lifecycle.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("data lifecycle CLI arguments", () => {
  it("parses only read-only preview and retention commands", () => {
    expect(parseDataLifecycleArguments([
      "preview",
      "--action=exclude",
      "--research-id",
      "SH26-001",
    ])).toEqual({
      command: "preview",
      help: false,
      action: "exclude",
      researchId: "SH26-001",
    });
    expect(parseDataLifecycleArguments([
      "retention-report",
      "--retention-days=365",
      "--as-of",
      "2026-07-21",
    ])).toEqual({
      command: "retention-report",
      help: false,
      retentionDays: 365,
      asOf: "2026-07-21",
    });
    expect(parseDataLifecycleArguments(["--help"])).toEqual({ help: true });
    expect(() => parseDataLifecycleArguments([
      "exclude",
      "--research-id=SH26-001",
    ])).toThrow(/Unknown lifecycle command/iu);
    expect(() => parseDataLifecycleArguments([
      "delete",
      "--research-id=SH26-001",
    ])).toThrow(/Unknown lifecycle command/iu);
  });

  const invalidArgumentSets: readonly (readonly string[])[] = [
    [],
    ["unknown"],
    ["preview", "delete", "--action", "delete", "--research-id", "SH26-001"],
    ["preview", "--action", "exclude"],
    ["preview", "--action", "other", "--research-id", "SH26-001"],
    ["preview", "--action", "exclude", "--action", "delete", "--research-id", "SH26-001"],
    ["preview", "--action", "delete", "--research-id", "SH26-001", "--confirm-plan", "abc"],
    ["retention-report"],
    ["retention-report", "--retention-days", "365", "--research-id", "SH26-001"],
    ["preview", "--action", "exclude", "--research-id"],
    ["preview", "--action", "exclude", "--research-id", "SH26-001", "--unknown", "x"],
  ];

  it.each(invalidArgumentSets.map((args) => [args] as const))(
    "rejects incomplete, duplicated or cross-command arguments %#",
    (args) => {
    expect(() => parseDataLifecycleArguments(args)).toThrow();
    },
  );
});

describe("data lifecycle CLI runner", () => {
  it("prints a JSON read-only preview and a retention report for temp fixtures", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-lifecycle-cli-"));
    roots.push(root);
    await mkdir(join(root, "data", "sessions"), { recursive: true });
    const previewOutput: string[] = [];
    await expect(runDataLifecycle({
      args: ["preview", "--action", "exclude", "--research-id", "SH26-001"],
      repositoryRoot: root,
      now: new Date("2026-07-21T00:00:00.000Z"),
      writeLine: (line) => previewOutput.push(line),
    })).resolves.toBe(0);
    expect(JSON.parse(previewOutput.join("\n"))).toMatchObject({
      planType: "research-data-lifecycle",
      targetCount: 0,
      googleFormManualActionRequired: true,
    });

    const retentionOutput: string[] = [];
    await expect(runDataLifecycle({
      args: ["retention-report", "--retention-days", "365", "--as-of", "2026-07-21"],
      repositoryRoot: root,
      now: new Date("2026-07-21T00:00:00.000Z"),
      writeLine: (line) => retentionOutput.push(line),
    })).resolves.toBe(0);
    expect(JSON.parse(retentionOutput.join("\n"))).toMatchObject({
      reportType: "research-data-retention",
      fileCount: 0,
      expiredCount: 0,
    });
  });

  it("prints help and reports validation failures without throwing", async () => {
    const help: string[] = [];
    await expect(runDataLifecycle({ args: ["--help"], writeLine: (line) => help.push(line) }))
      .resolves.toBe(0);
    expect(help.join("\n")).toContain("data/sessions");
    expect(help.join("\n")).toContain("Googleフォーム");

    const failure: string[] = [];
    await expect(runDataLifecycle({ args: ["preview"], writeLine: (line) => failure.push(line) }))
      .resolves.toBe(1);
    expect(failure).toEqual([expect.stringContaining("結果: FAIL")]);
  });
});
