import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  loadExperimentConfig,
  type LoadedExperimentConfig,
} from "../shared/config-loader.js";

export const SCREEN_PILOT_CONFIG_PATH = "config/experiment.screen-pilot.json";

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SCREEN_PILOT_SOURCE_TREE_HASH_DOMAIN = "sechack-screen-pilot-source-tree-v1\0";

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
  const hash = createHash("sha256").update(SCREEN_PILOT_SOURCE_TREE_HASH_DOMAIN, "utf8");
  let cursor = 0;
  let entries = 0;
  while (cursor < tree.stdout.byteLength) {
    const terminator = tree.stdout.indexOf(0, cursor);
    if (terminator < 0) {
      throw new Error("Git returned a malformed screen-pilot source tree.");
    }
    const record = tree.stdout.subarray(cursor, terminator);
    const separator = record.indexOf(0x09);
    if (separator < 1 || separator === record.byteLength - 1) {
      throw new Error("Git returned a malformed screen-pilot source tree entry.");
    }
    const frame = Buffer.allocUnsafe(4);
    frame.writeUInt32BE(record.byteLength);
    hash.update(frame).update(record);
    entries += 1;
    cursor = terminator + 1;
  }
  const countFrame = Buffer.allocUnsafe(4);
  countFrame.writeUInt32BE(entries);
  return hash.update(countFrame).digest("hex");
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
