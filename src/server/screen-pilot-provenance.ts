import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { FormalProductionClientAssets } from "../../scripts/production-release-verifier.js";
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
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const APP_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const PILOT_BUNDLE_PATH = "dist-server/screen-pilot.js";
const PILOT_CAPABILITY_MAX_AGE_MS = 60_000;
const MAX_PILOT_ASSET_COUNT = 256;
const MAX_PILOT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PILOT_TOTAL_BYTES = 32 * 1024 * 1024;
const consumedCapabilityNonces = new Set<string>();

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

export interface ScreenPilotArtifactEvidence {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ScreenPilotLaunchCapability {
  readonly schemaVersion: 1;
  readonly nonce: string;
  readonly buildSecret: string;
  readonly launcherPid: number;
  readonly createdAtMs: number;
  readonly sourceEvidence: ScreenPilotSourceEvidence;
  readonly bundle: ScreenPilotArtifactEvidence;
  readonly clientAssets: readonly ScreenPilotArtifactEvidence[];
}

export interface ScreenPilotEmbeddedBuildEvidence {
  readonly schemaVersion: 1;
  readonly sourceEvidence: ScreenPilotSourceEvidence;
  readonly buildChallengeSha256: string;
  readonly appVersion: string;
  readonly clientAssets: readonly ScreenPilotArtifactEvidence[];
}

export interface VerifiedScreenPilotLaunch extends VerifiedScreenPilotSource {
  readonly clientAssets: FormalProductionClientAssets;
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

function sha256Bytes(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function sameFileSnapshot(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStablePilotFile(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`Screen-pilot artifact must be a unique regular file: ${path}`);
  }
  if (before.size <= 0 || before.size > MAX_PILOT_FILE_BYTES) {
    throw new Error(`Screen-pilot artifact size is outside the safety limit: ${path}`);
  }
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileSnapshot(before, opened)) {
      throw new Error(`Screen-pilot artifact changed before it could be read: ${path}`);
    }
    const body = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < body.byteLength) {
      const { bytesRead } = await handle.read(body, offset, body.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error(`Screen-pilot artifact ended early: ${path}`);
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
      throw new Error(`Screen-pilot artifact grew while it was being read: ${path}`);
    }
    if (!sameFileSnapshot(opened, await handle.stat())) {
      throw new Error(`Screen-pilot artifact changed while it was being read: ${path}`);
    }
    return body;
  } finally {
    await handle.close();
  }
}

async function listPilotClientPaths(
  rootDirectory: string,
  currentDirectory = resolve(rootDirectory, "dist"),
): Promise<readonly string[]> {
  const directoryStat = await lstat(currentDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Screen-pilot dist must contain only ordinary directories.");
  }
  const paths: string[] = [];
  for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
    const absolutePath = resolve(currentDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Screen-pilot dist must not contain symbolic links or junctions.");
    }
    if (entry.isDirectory()) {
      paths.push(...await listPilotClientPaths(rootDirectory, absolutePath));
      continue;
    }
    if (!entry.isFile()) throw new Error("Screen-pilot dist contains an unsupported entry.");
    if (!/\.(?:html|js|css)$/u.test(entry.name)) continue;
    const path = relative(rootDirectory, absolutePath).split(sep).join("/");
    if (!path.startsWith("dist/") || path.includes("..") || isAbsolute(path)) {
      throw new Error("Screen-pilot client asset escaped dist/.");
    }
    paths.push(path);
  }
  return paths;
}

async function readPilotArtifacts(rootDirectory: string): Promise<{
  readonly bundle: ScreenPilotArtifactEvidence;
  readonly clientEvidence: readonly ScreenPilotArtifactEvidence[];
  readonly clientAssets: FormalProductionClientAssets;
}> {
  const rootStat = await lstat(rootDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Screen-pilot root must be an ordinary directory.");
  }
  const bundleBody = await readStablePilotFile(resolve(rootDirectory, PILOT_BUNDLE_PATH));
  const bundle = Object.freeze({
    path: PILOT_BUNDLE_PATH,
    bytes: bundleBody.byteLength,
    sha256: sha256Bytes(bundleBody),
  });
  const paths = [...await listPilotClientPaths(rootDirectory)]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (paths.length === 0 || paths.length > MAX_PILOT_ASSET_COUNT) {
    throw new Error("Screen-pilot client asset count is outside the safety limit.");
  }
  if (paths.filter((path) => path === "dist/index.html").length !== 1) {
    throw new Error("Screen-pilot requires exactly one dist/index.html.");
  }

  let totalBytes = 0;
  const clientEvidence: ScreenPilotArtifactEvidence[] = [];
  const files: FormalProductionClientAssets["files"][number][] = [];
  for (const path of paths) {
    const body = await readStablePilotFile(resolve(rootDirectory, path));
    totalBytes += body.byteLength;
    if (totalBytes > MAX_PILOT_TOTAL_BYTES) {
      throw new Error("Screen-pilot client assets exceed the total memory limit.");
    }
    const sha256 = sha256Bytes(body);
    clientEvidence.push(Object.freeze({ path, bytes: body.byteLength, sha256 }));
    const requestPath = `/${path.slice("dist/".length)}`;
    const contentType = path.endsWith(".html")
      ? "text/html; charset=utf-8" as const
      : path.endsWith(".js")
        ? "text/javascript; charset=utf-8" as const
        : "text/css; charset=utf-8" as const;
    files.push(Object.freeze({
      manifestPath: path,
      requestPath,
      contentType,
      sha256,
      body,
    }));
  }
  const index = files.find((file) => file.manifestPath === "dist/index.html");
  if (index === undefined) throw new Error("Screen-pilot index asset could not be loaded.");
  return Object.freeze({
    bundle,
    clientEvidence: Object.freeze(clientEvidence),
    clientAssets: Object.freeze({
      index,
      files: Object.freeze(files),
      totalBytes,
    }),
  });
}

function evidenceMatches(
  left: ScreenPilotSourceEvidence,
  right: ScreenPilotSourceEvidence,
): boolean {
  return left.sourceCommit === right.sourceCommit
    && left.sourceTreeSha256 === right.sourceTreeSha256
    && left.configFileHash === right.configFileHash;
}

function artifactsMatch(
  left: readonly ScreenPilotArtifactEvidence[],
  right: readonly ScreenPilotArtifactEvidence[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && entry.path === candidate.path
      && entry.bytes === candidate.bytes
      && entry.sha256 === candidate.sha256;
  });
}

function assertSourceEvidenceShape(
  value: unknown,
): asserts value is ScreenPilotSourceEvidence {
  if (
    value === null
    || typeof value !== "object"
    || !SOURCE_COMMIT_PATTERN.test(String(
      (value as Partial<ScreenPilotSourceEvidence>).sourceCommit,
    ))
    || !SHA256_PATTERN.test(String(
      (value as Partial<ScreenPilotSourceEvidence>).sourceTreeSha256,
    ))
    || !SHA256_PATTERN.test(String(
      (value as Partial<ScreenPilotSourceEvidence>).configFileHash,
    ))
  ) {
    throw new Error("Screen-pilot source evidence has an invalid structure.");
  }
}

function assertClientEvidenceShape(
  value: unknown,
): asserts value is readonly ScreenPilotArtifactEvidence[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_PILOT_ASSET_COUNT
    || value.filter((entry: unknown) => (
      entry !== null
      && typeof entry === "object"
      && (entry as Partial<ScreenPilotArtifactEvidence>).path === "dist/index.html"
    )).length !== 1
    || !value.every((entry: unknown) => {
      if (entry === null || typeof entry !== "object") return false;
      const artifact = entry as Partial<ScreenPilotArtifactEvidence>;
      return typeof artifact.path === "string"
        && artifact.path.startsWith("dist/")
        && !artifact.path.includes("..")
        && !isAbsolute(artifact.path)
        && /\.(?:html|js|css)$/u.test(artifact.path)
        && Number.isSafeInteger(artifact.bytes)
        && Number(artifact.bytes) > 0
        && Number(artifact.bytes) <= MAX_PILOT_FILE_BYTES
        && SHA256_PATTERN.test(String(artifact.sha256));
    })
  ) {
    throw new Error("Screen-pilot client build evidence has an invalid structure.");
  }
  const paths = value.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Screen-pilot client build evidence contains duplicate paths.");
  }
}

export function parseScreenPilotEmbeddedBuildEvidence(
  source: string,
): ScreenPilotEmbeddedBuildEvidence {
  if (source === "UNVERIFIED") {
    throw new Error("Screen-pilot bundle was not produced by the verified launcher build.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error("Screen-pilot embedded build evidence is malformed.", { cause: error });
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || (parsed as Partial<ScreenPilotEmbeddedBuildEvidence>).schemaVersion !== 1
  ) {
    throw new Error("Screen-pilot embedded build evidence has an invalid structure.");
  }
  const candidate = parsed as Partial<ScreenPilotEmbeddedBuildEvidence>;
  assertSourceEvidenceShape(candidate.sourceEvidence);
  assertClientEvidenceShape(candidate.clientAssets);
  const { buildChallengeSha256, appVersion } = candidate;
  if (
    typeof buildChallengeSha256 !== "string"
    || !SHA256_PATTERN.test(buildChallengeSha256)
    || typeof appVersion !== "string"
    || !APP_VERSION_PATTERN.test(appVersion)
  ) {
    throw new Error("Screen-pilot embedded build identity has an invalid structure.");
  }
  return Object.freeze({
    schemaVersion: 1,
    sourceEvidence: Object.freeze({ ...candidate.sourceEvidence }),
    buildChallengeSha256,
    appVersion,
    clientAssets: Object.freeze(candidate.clientAssets.map((entry) => Object.freeze({ ...entry }))),
  });
}

export async function createScreenPilotLaunchCapability(
  rootDirectory: string,
  expectedSourceEvidence: ScreenPilotSourceEvidence,
  buildSecret: string,
): Promise<ScreenPilotLaunchCapability> {
  if (!SHA256_PATTERN.test(buildSecret)) {
    throw new Error("Screen-pilot build secret must be 256 random bits encoded as lowercase hex.");
  }
  const verified = await verifyScreenPilotSource(rootDirectory);
  if (!evidenceMatches(verified.evidence, expectedSourceEvidence)) {
    throw new Error("Screen-pilot source changed while the fresh build was running.");
  }
  const artifacts = await readPilotArtifacts(verified.rootDirectory);
  return Object.freeze({
    schemaVersion: 1,
    nonce: randomBytes(32).toString("hex"),
    buildSecret,
    launcherPid: process.pid,
    createdAtMs: Date.now(),
    sourceEvidence: verified.evidence,
    bundle: artifacts.bundle,
    clientAssets: artifacts.clientEvidence,
  });
}

function assertCapabilityShape(value: unknown): asserts value is ScreenPilotLaunchCapability {
  if (value === null || typeof value !== "object") throw new Error("Screen-pilot capability is missing.");
  const capability = value as Partial<ScreenPilotLaunchCapability>;
  if (
    capability.schemaVersion !== 1
    || typeof capability.nonce !== "string"
    || !SHA256_PATTERN.test(capability.nonce)
    || typeof capability.buildSecret !== "string"
    || !SHA256_PATTERN.test(capability.buildSecret)
    || !Number.isSafeInteger(capability.launcherPid)
    || !Number.isSafeInteger(capability.createdAtMs)
    || capability.sourceEvidence === undefined
    || capability.bundle === undefined
    || capability.bundle.path !== PILOT_BUNDLE_PATH
    || !SHA256_PATTERN.test(capability.bundle.sha256)
    || !Number.isSafeInteger(capability.bundle.bytes)
  ) {
    throw new Error("Screen-pilot capability has an invalid structure.");
  }
  assertSourceEvidenceShape(capability.sourceEvidence);
  assertClientEvidenceShape(capability.clientAssets);
}

export async function consumeScreenPilotLaunchCapability(
  value: unknown,
  entryPath: string,
  embeddedBuildEvidence: ScreenPilotEmbeddedBuildEvidence,
  parentPid = process.ppid,
  nowMs = Date.now(),
): Promise<VerifiedScreenPilotLaunch> {
  assertCapabilityShape(value);
  assertSourceEvidenceShape(embeddedBuildEvidence.sourceEvidence);
  assertClientEvidenceShape(embeddedBuildEvidence.clientAssets);
  if (
    sha256Bytes(Buffer.from(value.buildSecret, "hex"))
    !== embeddedBuildEvidence.buildChallengeSha256
  ) {
    throw new Error("Screen-pilot build secret does not match this fresh bundle.");
  }
  if (!evidenceMatches(value.sourceEvidence, embeddedBuildEvidence.sourceEvidence)) {
    throw new Error("Screen-pilot capability does not match its embedded clean source build.");
  }
  if (!artifactsMatch(value.clientAssets, embeddedBuildEvidence.clientAssets)) {
    throw new Error("Screen-pilot capability does not match its embedded client build.");
  }
  if (consumedCapabilityNonces.has(value.nonce)) {
    throw new Error("Screen-pilot capability has already been consumed.");
  }
  consumedCapabilityNonces.add(value.nonce);
  if (value.launcherPid !== parentPid) {
    throw new Error("Screen-pilot capability was not issued by the current launcher process.");
  }
  if (nowMs < value.createdAtMs || nowMs - value.createdAtMs > PILOT_CAPABILITY_MAX_AGE_MS) {
    throw new Error("Screen-pilot capability is stale or has an invalid timestamp.");
  }
  const resolvedEntryPath = resolve(entryPath);
  const rootDirectory = resolve(dirname(resolvedEntryPath), "..");
  if (resolvedEntryPath !== resolve(rootDirectory, PILOT_BUNDLE_PATH)) {
    throw new Error("Screen-pilot must execute the freshly built dist-server/screen-pilot.js.");
  }
  const verified = await verifyScreenPilotSource(rootDirectory);
  if (!evidenceMatches(verified.evidence, value.sourceEvidence)) {
    throw new Error("Screen-pilot source/config evidence changed after launch authorization.");
  }
  const artifacts = await readPilotArtifacts(rootDirectory);
  if (!artifactsMatch([artifacts.bundle], [value.bundle])) {
    throw new Error("The running screen-pilot bundle is stale or modified.");
  }
  if (!artifactsMatch(artifacts.clientEvidence, embeddedBuildEvidence.clientAssets)) {
    throw new Error("Screen-pilot dist assets are stale or modified.");
  }
  return Object.freeze({
    rootDirectory,
    loadedConfig: verified.loadedConfig,
    evidence: verified.evidence,
    clientAssets: artifacts.clientAssets,
  });
}
