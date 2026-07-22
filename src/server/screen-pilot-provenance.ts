import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  loadExperimentConfig,
  type LoadedExperimentConfig,
} from "../shared/config-loader.js";
import {
  hashProductionSourceTreeListing,
  SCREEN_PILOT_CONFIG_PATH,
} from "./production-source-tree.js";

export { SCREEN_PILOT_CONFIG_PATH } from "./production-source-tree.js";

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
}

export interface ScreenPilotSourceEvidence {
  readonly sourceCommit: string;
  readonly sourceTreeSha256: string;
  readonly configFileHash: string;
}

export interface VerifiedScreenPilotSource {
  readonly rootDirectory: string;
  readonly loadedConfig: LoadedExperimentConfig;
  readonly evidence: ScreenPilotSourceEvidence;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function runGit(
  rootDirectory: string,
  args: readonly string[],
): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolveCommand, rejectCommand) => {
    const child = spawn("git", args, {
      cwd: rootDirectory,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectCommand(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > MAX_GIT_OUTPUT_BYTES) {
        child.kill();
        rejectOnce(new Error("Git returned more output than the screen-pilot safety limit."));
        return;
      }
      chunks.push(chunk);
    });
    // Drain stderr without copying repository paths or other local details into logs.
    child.stderr.resume();
    child.once("error", () => rejectOnce(new Error("Git could not be started for screen-pilot verification.")));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolveCommand({ exitCode: code ?? 1, stdout: Buffer.concat(chunks) });
    });
  });
}

async function requireCleanWorktree(rootDirectory: string): Promise<void> {
  const status = await runGit(rootDirectory, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status.exitCode !== 0) {
    throw new Error("Screen-pilot Git worktree status could not be checked.");
  }
  if (status.stdout.byteLength > 0) {
    throw new Error(
      "Screen-pilot requires a clean Git HEAD; tracked, untracked, and submodule changes are prohibited.",
    );
  }
}

async function currentCommit(rootDirectory: string): Promise<string> {
  const result = await runGit(rootDirectory, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const commit = result.stdout.toString("utf8").trim();
  if (result.exitCode !== 0 || !SOURCE_COMMIT_PATTERN.test(commit)) {
    throw new Error("Screen-pilot requires a full lowercase Git HEAD commit ID.");
  }
  return commit;
}

async function hashTrackedTree(rootDirectory: string, sourceCommit: string): Promise<string> {
  const tree = await runGit(rootDirectory, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    sourceCommit,
  ]);
  if (tree.exitCode !== 0) {
    throw new Error("The screen-pilot Git source tree could not be enumerated.");
  }
  return hashProductionSourceTreeListing(tree.stdout);
}

/**
 * Verifies the exact source and config that a nonparticipant screen pilot will
 * execute. The second status/HEAD/config read closes ordinary operator races;
 * any mismatch aborts before the HTTP listener or session logger is created.
 */
export async function verifyScreenPilotSource(
  requestedRootDirectory = process.cwd(),
): Promise<VerifiedScreenPilotSource> {
  const rootDirectory = resolve(requestedRootDirectory);
  const topLevel = await runGit(rootDirectory, ["rev-parse", "--show-toplevel"]);
  const topLevelPath = topLevel.stdout.toString("utf8").trim();
  if (topLevel.exitCode !== 0 || topLevelPath.length === 0) {
    throw new Error("Screen-pilot source must be a Git worktree with at least one commit.");
  }
  const [realRoot, realTopLevel] = await Promise.all([
    realpath(rootDirectory),
    realpath(topLevelPath),
  ]);
  if (!samePath(realRoot, realTopLevel)) {
    throw new Error("Screen-pilot must start from the Git worktree root.");
  }

  const sourceCommit = await currentCommit(rootDirectory);
  await requireCleanWorktree(rootDirectory);

  const trackedConfig = await runGit(rootDirectory, [
    "ls-files",
    "--error-unmatch",
    "--",
    SCREEN_PILOT_CONFIG_PATH,
  ]);
  if (
    trackedConfig.exitCode !== 0
    || trackedConfig.stdout.toString("utf8").trim() !== SCREEN_PILOT_CONFIG_PATH
  ) {
    throw new Error(`Screen-pilot requires the tracked fixed config ${SCREEN_PILOT_CONFIG_PATH}.`);
  }

  const firstConfig = await loadExperimentConfig(SCREEN_PILOT_CONFIG_PATH, { rootDirectory });
  const expectedConfigPath = resolve(rootDirectory, SCREEN_PILOT_CONFIG_PATH);
  if (!samePath(firstConfig.path, expectedConfigPath)) {
    throw new Error("Screen-pilot config resolved away from its fixed tracked path.");
  }
  const committedConfig = await runGit(rootDirectory, [
    "cat-file",
    "blob",
    `${sourceCommit}:${SCREEN_PILOT_CONFIG_PATH}`,
  ]);
  if (
    committedConfig.exitCode !== 0
    || !committedConfig.stdout.equals(Buffer.from(firstConfig.sourceBytes))
  ) {
    throw new Error("Screen-pilot config bytes must exactly match the config tracked at Git HEAD.");
  }

  const sourceTreeSha256 = await hashTrackedTree(rootDirectory, sourceCommit);
  await requireCleanWorktree(rootDirectory);
  if (await currentCommit(rootDirectory) !== sourceCommit) {
    throw new Error("Git HEAD changed during screen-pilot source verification.");
  }
  const loadedConfig = await loadExperimentConfig(SCREEN_PILOT_CONFIG_PATH, { rootDirectory });
  if (
    loadedConfig.configFileHash !== firstConfig.configFileHash
    || !Buffer.from(loadedConfig.sourceBytes).equals(Buffer.from(firstConfig.sourceBytes))
  ) {
    throw new Error("Screen-pilot config changed during source verification.");
  }

  return Object.freeze({
    rootDirectory,
    loadedConfig,
    evidence: Object.freeze({
      sourceCommit,
      sourceTreeSha256,
      configFileHash: loadedConfig.configFileHash,
    }),
  });
}
