import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  freshBuildInvocation,
  runScreenPilotLauncher,
  sanitizedChildEnvironment,
} from "../../../scripts/screen-pilot-launcher.js";
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
  it.runIf(process.platform === "win32")(
    "uses the current trusted Node and its absolute npm CLI instead of PATH npm.cmd",
    () => {
      const invocation = freshBuildInvocation("win32", process.env, process.execPath);
      expect(invocation).toEqual({
        command: process.execPath,
        args: [
          resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
          "run",
          "build",
        ],
      });
      expect(invocation.args.join(" ")).not.toMatch(/npm\.cmd/iu);
    },
  );

  it.runIf(process.platform === "win32")(
    "pins the real System32 command processor and rejects environment redirection",
    () => {
      expect(() => freshBuildInvocation("win32", {
        ...process.env,
        ComSpec: "npm.cmd",
      }, process.execPath)).toThrow(/absolute trusted Windows System32 command processor/iu);
      expect(() => freshBuildInvocation("win32", {
        ...process.env,
        ComSpec: process.execPath,
      }, process.execPath)).toThrow(/untrusted Windows System32 command processor/iu);
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects npm and Node lifecycle paths outside the current Node installation",
    () => {
      expect(() => freshBuildInvocation("win32", {
        ...process.env,
        npm_execpath: process.execPath,
      }, process.execPath)).toThrow(/untrusted npm CLI/iu);
      expect(() => freshBuildInvocation("win32", {
        ...process.env,
        npm_node_execpath: resolve(dirname(process.execPath), "npm.cmd"),
      }, process.execPath)).toThrow(/npm Node executable/iu);
    },
  );

  it.runIf(process.platform === "win32")(
    "creates a child allowlist that drops executable environment injection",
    async () => {
      const environment = sanitizedChildEnvironment("win32", {
        ...process.env,
        Path: "C:\\attacker-bin",
        BASH_ENV: "C:\\attacker\\profile.sh",
        ESBUILD_BINARY_PATH: "C:\\attacker\\esbuild.exe",
        NODE_OPTIONS: "--import=C:\\attacker\\hook.mjs",
        NPM_CONFIG_GLOBALCONFIG: "C:\\attacker\\npmrc",
        npm_config_script_shell: "C:\\attacker\\shell.exe",
      }, process.execPath);
      const keys = Object.keys(environment).map((key) => key.toUpperCase());
      expect(environment.ComSpec).toMatch(/\\System32\\cmd\.exe$/iu);
      expect(environment.NPM_CONFIG_SCRIPT_SHELL).toBe(environment.ComSpec);
      expect(environment.Path).not.toContain("attacker-bin");
      expect(environment.NODE_OPTIONS).toBe("");
      expect(environment.NPM_CONFIG_USERCONFIG).toBe("NUL");
      expect(environment.NPM_CONFIG_IGNORE_SCRIPTS).toBe("true");
      expect(environment.Path).toContain("\\Git\\cmd");
      expect(keys).not.toContain("BASH_ENV");
      expect(keys).not.toContain("ESBUILD_BINARY_PATH");
      expect(keys).not.toContain("NPM_CONFIG_GLOBALCONFIG");
      expect(Object.hasOwn(environment, "npm_config_script_shell")).toBe(false);
      const gitVersion = await execFileAsync("git", ["--version"], {
        env: environment,
        windowsHide: true,
      });
      expect(gitVersion.stdout).toMatch(/^git version /u);
    },
  );

  it("keeps the existing non-Windows npm invocation contract", () => {
    expect(freshBuildInvocation("linux", { PATH: "/trusted/bin" }, "/usr/bin/node"))
      .toEqual({ command: "npm", args: ["run", "build"] });
  });

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
    // Execute the source entry directly so this assertion cannot race another
    // Vitest worker that cleans/rebuilds the shared dist-server directory.
    // Capability-shaped environment data is intentionally insufficient:
    // authorization is accepted only on the launcher's private IPC channel.
    const entry = resolve("src", "server", "screen-pilot.ts");
    await expect(execFileAsync(process.execPath, [
      "--import",
      "tsx",
      entry,
      "--screen-pilot",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        NODE_PATH: "",
        SECHACK_SCREEN_PILOT_BUILD_CHALLENGE_SHA256: "a".repeat(64),
        SECHACK_SCREEN_PILOT_LAUNCH_CAPABILITY: JSON.stringify({
          schemaVersion: 1,
          nonce: "b".repeat(64),
        }),
      },
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
