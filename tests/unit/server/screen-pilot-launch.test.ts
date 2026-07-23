import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runScreenPilotLauncher } from "../../../scripts/screen-pilot-launcher.js";
import {
  consumeScreenPilotLaunchCapability,
  createScreenPilotLaunchCapability,
  verifyScreenPilotSource,
  type ScreenPilotEmbeddedBuildEvidence,
  type ScreenPilotLaunchCapability,
} from "../../../src/server/screen-pilot-provenance.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const BUILD_SECRET = "8".repeat(64);

async function runGit(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root, windowsHide: true });
}

async function createPilotFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sechack-pilot-capability-"));
  temporaryRoots.push(root);
  await Promise.all([
    mkdir(join(root, "config"), { recursive: true }),
    mkdir(join(root, "dist", "assets"), { recursive: true }),
    mkdir(join(root, "dist-server"), { recursive: true }),
  ]);
  const config = await readFile(resolve("config", "experiment.screen-pilot.json"));
  await Promise.all([
    writeFile(join(root, ".gitignore"), "dist/\ndist-server/\ndata/\n", "utf8"),
    writeFile(join(root, "config", "experiment.screen-pilot.json"), config),
    writeFile(join(root, "dist", "index.html"), "<!doctype html><p>pilot-index</p>", "utf8"),
    writeFile(join(root, "dist", "assets", "pilot.js"), "globalThis.pilot=true;", "utf8"),
    writeFile(join(root, "dist", "assets", "pilot.css"), "body{color:#111}", "utf8"),
    writeFile(join(root, "dist-server", "screen-pilot.js"), "// fresh pilot bundle\n", "utf8"),
  ]);
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "core.autocrlf", "false"]);
  await runGit(root, ["config", "user.name", "Pilot Capability Test"]);
  await runGit(root, ["config", "user.email", "pilot@example.invalid"]);
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "--quiet", "-m", "pilot source"]);
  return root;
}

function metadataCapability(nonce: string): ScreenPilotLaunchCapability {
  return {
    schemaVersion: 1,
    nonce,
    buildSecret: BUILD_SECRET,
    launcherPid: process.pid,
    createdAtMs: Date.now(),
    sourceEvidence: {
      sourceCommit: "1".repeat(40),
      sourceTreeSha256: "2".repeat(64),
      configFileHash: "3".repeat(64),
    },
    bundle: {
      path: "dist-server/screen-pilot.js",
      bytes: 1,
      sha256: "4".repeat(64),
    },
    clientAssets: [{
      path: "dist/index.html",
      bytes: 1,
      sha256: "5".repeat(64),
    }],
  };
}

function embeddedEvidence(
  capability: ScreenPilotLaunchCapability,
): ScreenPilotEmbeddedBuildEvidence {
  return {
    schemaVersion: 1,
    sourceEvidence: capability.sourceEvidence,
    buildChallengeSha256: createHash("sha256")
      .update(Buffer.from(capability.buildSecret, "hex"))
      .digest("hex"),
    appVersion: "1.1.0",
    clientAssets: capability.clientAssets,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("fresh screen-pilot launch capability", () => {
  it("rejects invoking the launcher outside npm run screen-pilot", async () => {
    const lifecycle = process.env.npm_lifecycle_event;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.npm_lifecycle_event;
    try {
      await expect(runScreenPilotLauncher(process.cwd())).resolves.toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringMatching(/only through npm run screen-pilot/iu),
      );
    } finally {
      if (lifecycle === undefined) delete process.env.npm_lifecycle_event;
      else process.env.npm_lifecycle_event = lifecycle;
      consoleError.mockRestore();
    }
  });

  it("rejects direct execution without launcher IPC", async () => {
    const bundle = resolve("dist-server", "screen-pilot.js");
    await expect(execFileAsync(process.execPath, [bundle, "--screen-pilot"], {
      cwd: process.cwd(),
      windowsHide: true,
    })).rejects.toMatchObject({
      stderr: expect.stringMatching(/direct screen-pilot execution is prohibited/iu),
    });
  });

  it("rejects executable Node environment injection before verification", async () => {
    const lifecycle = process.env.npm_lifecycle_event;
    const nodeOptions = process.env.NODE_OPTIONS;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.npm_lifecycle_event = "screen-pilot";
    process.env.NODE_OPTIONS = "--import=outside-verification.mjs";
    try {
      await expect(runScreenPilotLauncher(process.cwd())).resolves.toBe(1);
      expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/NODE_OPTIONS/iu));
    } finally {
      if (lifecycle === undefined) delete process.env.npm_lifecycle_event;
      else process.env.npm_lifecycle_event = lifecycle;
      if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = nodeOptions;
      consoleError.mockRestore();
    }
  });

  it("rejects missing, stale, and reused capabilities before source execution", async () => {
    await expect(
      consumeScreenPilotLaunchCapability(
        null,
        resolve("dist-server", "screen-pilot.js"),
        embeddedEvidence(metadataCapability("0".repeat(64))),
      ),
    ).rejects.toThrow(/capability is missing/iu);

    const stale = metadataCapability("6".repeat(64));
    await expect(consumeScreenPilotLaunchCapability(
      { ...stale, createdAtMs: Date.now() - 60_001 },
      resolve("dist-server", "screen-pilot.js"),
      embeddedEvidence(stale),
      process.pid,
    )).rejects.toThrow(/stale/iu);

    const reusable = metadataCapability("7".repeat(64));
    const wrongEntry = resolve("dist-server", "renamed-pilot.js");
    await expect(consumeScreenPilotLaunchCapability(
      reusable,
      wrongEntry,
      embeddedEvidence(reusable),
      process.pid,
    ))
      .rejects.toThrow(/freshly built/iu);
    await expect(consumeScreenPilotLaunchCapability(
      reusable,
      wrongEntry,
      embeddedEvidence(reusable),
      process.pid,
    ))
      .rejects.toThrow(/already been consumed/iu);
  });

  it("rejects a capability issued for a different fresh build challenge", async () => {
    const capability = metadataCapability("9".repeat(64));
    await expect(consumeScreenPilotLaunchCapability(
      { ...capability, buildSecret: "a".repeat(64) },
      resolve("dist-server", "screen-pilot.js"),
      embeddedEvidence(capability),
      process.pid,
    )).rejects.toThrow(/build secret does not match/iu);
  });

  it.each(["bundle", "client"] as const)(
    "binds clean HEAD, fixed config and fresh %s bytes into one capability",
    async (target) => {
      const root = await createPilotFixture();
      const source = await verifyScreenPilotSource(root);
      const capability = await createScreenPilotLaunchCapability(
        root,
        source.evidence,
        BUILD_SECRET,
      );
      const entryPath = join(root, "dist-server", "screen-pilot.js");
      const changedPath = target === "bundle"
        ? entryPath
        : join(root, "dist", "assets", "pilot.js");
      await writeFile(changedPath, `modified-${target}`, "utf8");

      await expect(consumeScreenPilotLaunchCapability(
        capability,
        entryPath,
        embeddedEvidence(capability),
        process.pid,
      )).rejects.toThrow(target === "bundle" ? /bundle is stale or modified/iu : /dist assets are stale or modified/iu);
    },
  );

  it("returns memory assets from an unmodified one-shot capability", async () => {
    const root = await createPilotFixture();
    const source = await verifyScreenPilotSource(root);
    const capability = await createScreenPilotLaunchCapability(
      root,
      source.evidence,
      BUILD_SECRET,
    );
    const entryPath = join(root, "dist-server", "screen-pilot.js");
    const verified = await consumeScreenPilotLaunchCapability(
      capability,
      entryPath,
      embeddedEvidence(capability),
      process.pid,
    );
    const indexBeforeReplacement = verified.clientAssets.index.body.toString("utf8");
    await writeFile(join(root, "dist", "index.html"), "replaced", "utf8");

    expect(indexBeforeReplacement).toContain("pilot-index");
    expect(verified.clientAssets.index.body.toString("utf8")).toBe(indexBeforeReplacement);
    await expect(consumeScreenPilotLaunchCapability(
      capability,
      entryPath,
      embeddedEvidence(capability),
      process.pid,
    ))
      .rejects.toThrow(/already been consumed/iu);
  });
});
