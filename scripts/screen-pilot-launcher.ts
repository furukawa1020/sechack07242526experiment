import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createScreenPilotLaunchCapability,
  verifyScreenPilotSource,
  type ScreenPilotSourceEvidence,
} from "../src/server/screen-pilot-provenance.js";

const SCREEN_PILOT_BUILD_ENVIRONMENT = Object.freeze({
  sourceCommit: "SECHACK_SCREEN_PILOT_SOURCE_COMMIT",
  sourceTreeSha256: "SECHACK_SCREEN_PILOT_SOURCE_TREE_SHA256",
  configFileHash: "SECHACK_SCREEN_PILOT_CONFIG_FILE_HASH",
  buildChallengeSha256: "SECHACK_SCREEN_PILOT_BUILD_CHALLENGE_SHA256",
});
const PROHIBITED_ENVIRONMENT_KEYS = Object.freeze([
  "NODE_OPTIONS",
  "NODE_PATH",
  "ESBUILD_BINARY_PATH",
  "EXPERIMENT_CONFIG_PATH",
  "DATA_DIRECTORY",
] as const);
const SHUTDOWN_MESSAGE_TYPE = "screen-pilot.shutdown";

function waitForExit(child: ChildProcess, label: string): Promise<number> {
  return new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", (error) => rejectExit(new Error(`${label} could not start.`, { cause: error })));
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        rejectExit(new Error(`${label} ended from signal ${signal}.`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

function assertSafeLauncherEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of PROHIBITED_ENVIRONMENT_KEYS) {
    if ((environment[key] ?? "").trim().length > 0) {
      throw new Error(`Screen-pilot launcher prohibits the ${key} environment override.`);
    }
  }
}

function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
  for (const key of [
    ...PROHIBITED_ENVIRONMENT_KEYS,
    "NPM_CONFIG_NODE_OPTIONS",
    "npm_config_node_options",
    "TSX_TSCONFIG_PATH",
    ...Object.values(SCREEN_PILOT_BUILD_ENVIRONMENT),
  ]) delete environment[key];
  environment.NODE_OPTIONS = "";
  environment.NODE_PATH = "";
  return environment;
}

function screenPilotBuildEnvironment(
  evidence: ScreenPilotSourceEvidence,
  buildChallengeSha256: string,
): NodeJS.ProcessEnv {
  return {
    ...sanitizedChildEnvironment(),
    [SCREEN_PILOT_BUILD_ENVIRONMENT.sourceCommit]: evidence.sourceCommit,
    [SCREEN_PILOT_BUILD_ENVIRONMENT.sourceTreeSha256]: evidence.sourceTreeSha256,
    [SCREEN_PILOT_BUILD_ENVIRONMENT.configFileHash]: evidence.configFileHash,
    [SCREEN_PILOT_BUILD_ENVIRONMENT.buildChallengeSha256]: buildChallengeSha256,
  };
}

async function runFreshBuild(
  rootDirectory: string,
  evidence: ScreenPilotSourceEvidence,
  buildChallengeSha256: string,
): Promise<void> {
  const child = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build"],
    {
      cwd: rootDirectory,
      env: screenPilotBuildEnvironment(evidence, buildChallengeSha256),
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (await waitForExit(child, "Fresh screen-pilot build") !== 0) {
    throw new Error("Fresh screen-pilot build failed.");
  }
}

function forwardLauncherShutdown(child: ChildProcess): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => {
      if (child.connected) {
        child.send({ type: SHUTDOWN_MESSAGE_TYPE }, (error) => {
          if (error && !child.killed) child.kill();
        });
      } else if (!child.killed) {
        child.kill();
      }
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export async function runScreenPilotLauncher(root = process.cwd()): Promise<number> {
  try {
    assertSafeLauncherEnvironment(process.env);
    if (process.env.npm_lifecycle_event !== "screen-pilot") {
      throw new Error("Screen-pilot launcher may run only through npm run screen-pilot.");
    }
    if (process.argv.slice(2).length > 0) {
      throw new Error("Screen-pilot launcher accepts no command-line overrides.");
    }
    const beforeBuild = await verifyScreenPilotSource(resolve(root));
    const buildSecret = randomBytes(32).toString("hex");
    const buildChallengeSha256 = createHash("sha256")
      .update(Buffer.from(buildSecret, "hex"))
      .digest("hex");
    await runFreshBuild(beforeBuild.rootDirectory, beforeBuild.evidence, buildChallengeSha256);
    const capability = await createScreenPilotLaunchCapability(
      beforeBuild.rootDirectory,
      beforeBuild.evidence,
      buildSecret,
    );
    const entryPath = resolve(beforeBuild.rootDirectory, "dist-server", "screen-pilot.js");
    const child = spawn(process.execPath, [entryPath, "--screen-pilot"], {
      cwd: beforeBuild.rootDirectory,
      env: sanitizedChildEnvironment(),
      shell: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    const exitPromise = waitForExit(child, "Verified screen-pilot runtime");
    const stopForwarding = forwardLauncherShutdown(child);
    child.send({ type: "screen-pilot.capability", capability }, (error) => {
      if (error) {
        if (!child.killed) child.kill();
      }
    });
    try {
      return await exitPromise;
    } finally {
      stopForwarding();
      if (child.connected) child.disconnect();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Screen-pilot launcher failed.");
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  process.exitCode = await runScreenPilotLauncher();
}
