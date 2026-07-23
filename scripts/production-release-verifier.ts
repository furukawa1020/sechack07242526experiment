import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  FORMAL_PRODUCTION_CONFIG_PATH,
  hashFormalProductionConfig,
  hashFormalProductionCriticalConfig,
  hashFormalProductionGoEvidence,
  loadFormalProductionConfig,
} from "../src/shared/formal-production-config.js";
import type {
  ReleaseManifest,
  ReleaseVerificationResult,
} from "./release-manifest.js";

const RELEASE_MANIFEST_NAME = "DEPLOYMENT_MANIFEST.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const APP_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const FORMAL_CLIENT_DIRECTORY = "dist";
const FORMAL_CLIENT_INDEX_PATH = "dist/index.html";
const MAX_FORMAL_MANIFEST_BYTES = 4 * 1_024 * 1_024;
const MAX_FORMAL_CLIENT_ASSET_COUNT = 256;
const MAX_FORMAL_CLIENT_ASSET_BYTES = 8 * 1_024 * 1_024;
const MAX_FORMAL_CLIENT_TOTAL_BYTES = 32 * 1_024 * 1_024;

export interface FormalProductionClientAsset {
  readonly manifestPath: string;
  readonly requestPath: string;
  readonly contentType: "text/html; charset=utf-8" | "text/javascript; charset=utf-8" | "text/css; charset=utf-8";
  readonly sha256: string;
  readonly body: Buffer;
}

export interface FormalProductionClientAssets {
  readonly index: FormalProductionClientAsset;
  readonly files: readonly FormalProductionClientAsset[];
  readonly totalBytes: number;
}

function sha256Bytes(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

function hashSourceEvidenceBinding(input: {
  readonly appVersion: string;
  readonly sourceCommit: string;
  readonly sourceTreeSha256: string;
  readonly criticalConfigSha256: string;
  readonly goEvidenceSha256: string | null;
}): string {
  return createHash("sha256").update(
    [
      "sechack-release-technical-binding-v3",
      input.appVersion,
      input.sourceCommit,
      input.sourceTreeSha256,
      input.criticalConfigSha256,
      input.goEvidenceSha256 ?? "MISSING",
      "",
    ].join("\n"),
    "utf8",
  ).digest("hex");
}

function isCredentialFreeSourceRepository(value: string): boolean {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (value.length === 0 || value.trim() !== value || hasControlCharacter) return false;
  if (/^git@[a-z0-9.-]+:[a-z0-9._~/-]+$/iu.test(value)) return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (!["https:", "ssh:", "git:"].includes(parsed.protocol)) return false;
  if (
    parsed.hostname.length === 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    return false;
  }
  if (parsed.protocol === "ssh:") {
    if (parsed.username !== "" && parsed.username !== "git") return false;
  } else if (parsed.username.length > 0) {
    return false;
  }
  return parsed.pathname.length > 1;
}

function isSafeManifestPath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || isAbsolute(value)) {
    return false;
  }
  return value.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 4
    || typeof candidate.appVersion !== "string"
    || !APP_VERSION_PATTERN.test(candidate.appVersion)
    || typeof candidate.protocolVersion !== "string"
    || !SHA256_PATTERN.test(String(candidate.configHash))
    || !SHA256_PATTERN.test(String(candidate.configFileHash))
    || !SHA256_PATTERN.test(String(candidate.criticalConfigSha256))
    || candidate.goEvidenceSha256 !== null
    || typeof candidate.sourceCommit !== "string"
    || !SOURCE_COMMIT_PATTERN.test(candidate.sourceCommit)
    || typeof candidate.sourceTreeSha256 !== "string"
    || !SHA256_PATTERN.test(candidate.sourceTreeSha256)
    || typeof candidate.sourceEvidenceBindingSha256 !== "string"
    || !SHA256_PATTERN.test(candidate.sourceEvidenceBindingSha256)
    || (
      candidate.sourceRepository !== undefined
      && (
        typeof candidate.sourceRepository !== "string"
        || !isCredentialFreeSourceRepository(candidate.sourceRepository)
      )
    )
    || typeof candidate.createdAt !== "string"
    || !Array.isArray(candidate.files)
  ) {
    return false;
  }
  const runtime = candidate.buildRuntime;
  if (runtime === null || typeof runtime !== "object") return false;
  const runtimeRecord = runtime as Record<string, unknown>;
  if (
    typeof runtimeRecord.node !== "string"
    || typeof runtimeRecord.platform !== "string"
    || typeof runtimeRecord.arch !== "string"
  ) {
    return false;
  }
  return candidate.files.every((file) => {
    if (file === null || typeof file !== "object") return false;
    const record = file as Record<string, unknown>;
    return typeof record.path === "string"
      && isSafeManifestPath(record.path)
      && typeof record.bytes === "number"
      && Number.isSafeInteger(record.bytes)
      && record.bytes >= 0
      && typeof record.sha256 === "string"
      && SHA256_PATTERN.test(record.sha256);
  });
}

function toManifestPath(value: string): string {
  return value.split(sep).join("/");
}

function isInsideOrSame(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (
      pathFromParent !== ".."
      && !pathFromParent.startsWith(`..${sep}`)
      && !isAbsolute(pathFromParent)
    );
}

function isSameFileSnapshot(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readUniqueRegularFileBounded(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`Controlled asset must be a unique regular file: ${path}`);
  }
  if (before.size > maximumBytes) {
    throw new Error(`Controlled asset exceeds its read limit: ${path}`);
  }

  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || !isSameFileSnapshot(before, opened)
      || opened.size > maximumBytes
    ) {
      throw new Error(`Controlled asset changed before it could be read: ${path}`);
    }

    const body = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < body.byteLength) {
      const result = await handle.read(body, offset, body.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw new Error(`Controlled asset ended before its declared size: ${path}`);
      }
      offset += result.bytesRead;
    }
    const trailingByte = Buffer.alloc(1);
    const trailingRead = await handle.read(trailingByte, 0, 1, offset);
    if (trailingRead.bytesRead !== 0) {
      throw new Error(`Controlled asset grew while it was being read: ${path}`);
    }
    const afterRead = await handle.stat();
    if (!isSameFileSnapshot(opened, afterRead)) {
      throw new Error(`Controlled asset changed while it was being read: ${path}`);
    }
    return body;
  } finally {
    await handle.close();
  }
}

async function assertOrdinaryContainedAssetPath(
  rootDirectory: string,
  realRootDirectory: string,
  manifestPath: string,
): Promise<string> {
  if (!isSafeManifestPath(manifestPath) || !manifestPath.startsWith(`${FORMAL_CLIENT_DIRECTORY}/`)) {
    throw new Error(`Invalid formal client asset path: ${manifestPath}`);
  }
  const segments = manifestPath.split("/");
  let currentPath = rootDirectory;
  for (const segment of segments.slice(0, -1)) {
    currentPath = resolve(currentPath, segment);
    const directoryStat = await lstat(currentPath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`Formal client asset parent must be an ordinary directory: ${manifestPath}`);
    }
  }

  const absolutePath = resolve(rootDirectory, ...segments);
  const realAssetPath = await realpath(absolutePath);
  if (!isInsideOrSame(realRootDirectory, realAssetPath)) {
    throw new Error(`Formal client asset escaped the release directory: ${manifestPath}`);
  }
  return absolutePath;
}

function clientAssetContentType(
  manifestPath: string,
): FormalProductionClientAsset["contentType"] | null {
  if (manifestPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (manifestPath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (manifestPath.endsWith(".css")) return "text/css; charset=utf-8";
  return null;
}

async function listRegularFiles(
  rootDirectory: string,
  currentDirectory = rootDirectory,
): Promise<readonly string[]> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = resolve(currentDirectory, entry.name);
    const relativePath = toManifestPath(relative(rootDirectory, absolutePath));
    if (relativePath === RELEASE_MANIFEST_NAME || relativePath.startsWith("data/")) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in a release: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(rootDirectory, absolutePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unsupported release entry: ${relativePath}`);
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return Object.freeze(files);
}

function unreadableManifestResult(
  error: unknown,
  manifestSha256: string | null,
): ReleaseVerificationResult {
  return Object.freeze({
    errors: Object.freeze([
      `Deployment manifest could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
    ]),
    manifestSha256,
    sourceCommit: null,
    manifest: null,
  });
}

/** Verifies only the sealed formal screen release shape. */
export async function verifyFormalReleaseDirectoryDetailed(
  releaseDirectory: string,
): Promise<ReleaseVerificationResult> {
  const rootDirectory = resolve(releaseDirectory);
  let manifestSha256: string | null = null;
  let parsed: unknown;
  try {
    const manifestPath = resolve(rootDirectory, RELEASE_MANIFEST_NAME);
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1) {
      throw new Error("Deployment manifest must be a unique regular file.");
    }
    const manifestSource = await readFile(manifestPath);
    manifestSha256 = sha256Bytes(manifestSource);
    parsed = JSON.parse(new TextDecoder().decode(manifestSource)) as unknown;
  } catch (error) {
    return unreadableManifestResult(error, manifestSha256);
  }
  if (!isReleaseManifest(parsed)) {
    return Object.freeze({
      errors: Object.freeze(["Deployment manifest has an invalid structure."]),
      manifestSha256,
      sourceCommit: null,
      manifest: null,
    });
  }

  const errors: string[] = [];
  const expectedBinding = hashSourceEvidenceBinding({
    appVersion: parsed.appVersion,
    sourceCommit: parsed.sourceCommit,
    sourceTreeSha256: parsed.sourceTreeSha256,
    criticalConfigSha256: parsed.criticalConfigSha256,
    goEvidenceSha256: parsed.goEvidenceSha256,
  });
  if (parsed.sourceEvidenceBindingSha256 !== expectedBinding) {
    errors.push("Source, application, and technical config binding SHA-256 mismatch.");
  }
  if (parsed.buildRuntime.node !== process.version) {
    errors.push(`Node runtime mismatch: expected ${parsed.buildRuntime.node}, got ${process.version}`);
  }
  if (parsed.buildRuntime.platform !== process.platform) {
    errors.push(
      `Platform mismatch: expected ${parsed.buildRuntime.platform}, got ${process.platform}`,
    );
  }
  if (parsed.buildRuntime.arch !== process.arch) {
    errors.push(`Architecture mismatch: expected ${parsed.buildRuntime.arch}, got ${process.arch}`);
  }

  const packageEntries = parsed.files.filter((file) => file.path === "package.json");
  if (packageEntries.length !== 1) {
    errors.push("Manifest must control exactly one package.json file.");
  } else {
    try {
      const packageValue: unknown = JSON.parse(
        await readFile(resolve(rootDirectory, "package.json"), "utf8"),
      );
      const packageVersion = packageValue !== null && typeof packageValue === "object"
        ? (packageValue as Readonly<Record<string, unknown>>)["version"]
        : undefined;
      if (packageVersion !== parsed.appVersion) {
        errors.push(
          `Package appVersion mismatch: expected ${parsed.appVersion}, got ${String(packageVersion)}.`,
        );
      }
    } catch {
      errors.push("Packaged package.json could not be parsed and bound to manifest appVersion.");
    }
  }

  const configEntries = parsed.files.filter(
    (file) => file.path === FORMAL_PRODUCTION_CONFIG_PATH,
  );
  if (configEntries.length !== 1) {
    errors.push("Manifest must control exactly one formal experiment config path.");
  } else {
    const configEntry = configEntries[0]!;
    if (configEntry.sha256 !== parsed.configFileHash) {
      errors.push("Manifest config file hash is not bound to its file entry.");
    }
    try {
      // Verification is itself a production gate. Reuse the closed formal
      // loader so a structurally valid but NO-GO, expired, placeholder or
      // otherwise unapproved evidence bundle cannot pass VERIFY_RELEASE.cmd.
      const loadedConfig = await loadFormalProductionConfig(
        FORMAL_PRODUCTION_CONFIG_PATH,
        { rootDirectory },
      );
      if (loadedConfig.configFileHash !== parsed.configFileHash) {
        errors.push("Config file SHA-256 mismatch.");
      }
      const config = loadedConfig.config;
      if (hashFormalProductionConfig(config) !== parsed.configHash) {
        errors.push("Config semantic SHA-256 mismatch.");
      }
      if (config.protocolVersion !== parsed.protocolVersion) {
        errors.push(
          `Config protocolVersion mismatch: expected ${parsed.protocolVersion}, got ${config.protocolVersion}`,
        );
      }
      if (hashFormalProductionCriticalConfig(config) !== parsed.criticalConfigSha256) {
        errors.push("Critical config SHA-256 mismatch.");
      }
      if (hashFormalProductionGoEvidence(config) !== parsed.goEvidenceSha256) {
        errors.push("External-compliance manifests must not contain an approval-evidence hash.");
      }
    } catch (error) {
      errors.push(
        `Packaged config failed formal production validation: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  const expectedPaths = new Set(parsed.files.map((file) => file.path));
  let actualPaths: readonly string[] = [];
  try {
    actualPaths = await listRegularFiles(rootDirectory);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Release contents could not be enumerated.");
  }
  for (const path of actualPaths) {
    if (!expectedPaths.has(path)) errors.push(`Unexpected controlled file: ${path}`);
  }
  for (const file of parsed.files) {
    const absolutePath = resolve(rootDirectory, file.path);
    try {
      const fileStat = await lstat(absolutePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        errors.push(`Not a regular file: ${file.path}`);
        continue;
      }
      if (fileStat.nlink !== 1) {
        errors.push(`Hard-linked controlled file is not allowed: ${file.path}`);
        continue;
      }
      if (fileStat.size !== file.bytes) errors.push(`Size mismatch: ${file.path}`);
      if (await sha256File(absolutePath) !== file.sha256) {
        errors.push(`SHA-256 mismatch: ${file.path}`);
      }
    } catch (error) {
      errors.push(
        `Missing or unreadable file: ${file.path} (${error instanceof Error ? error.message : "error"})`,
      );
    }
  }

  return Object.freeze({
    errors: Object.freeze(errors),
    manifestSha256,
    sourceCommit: parsed.sourceCommit,
    ...(parsed.sourceRepository === undefined ? {} : { sourceRepository: parsed.sourceRepository }),
    manifest: Object.freeze({
      appVersion: parsed.appVersion,
      protocolVersion: parsed.protocolVersion,
      configHash: parsed.configHash,
      configFileHash: parsed.configFileHash,
      criticalConfigSha256: parsed.criticalConfigSha256,
      goEvidenceSha256: parsed.goEvidenceSha256,
      sourceTreeSha256: parsed.sourceTreeSha256,
      sourceEvidenceBindingSha256: parsed.sourceEvidenceBindingSha256,
    }),
  });
}

/**
 * Re-opens the already verified manifest and formal client assets immediately
 * before startup. Every response body is retained in memory so later filesystem
 * replacement cannot change the participant or operator UI being served.
 */
export async function loadFormalProductionClientAssets(
  releaseDirectory: string,
  expectedManifestSha256: string,
): Promise<FormalProductionClientAssets> {
  if (!SHA256_PATTERN.test(expectedManifestSha256)) {
    throw new Error("A verified deployment manifest SHA-256 is required to load client assets.");
  }
  const rootDirectory = resolve(releaseDirectory);
  const rootStat = await lstat(rootDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The formal release root must be an ordinary directory.");
  }
  const realRootDirectory = await realpath(rootDirectory);

  const manifestPath = resolve(rootDirectory, RELEASE_MANIFEST_NAME);
  const manifestSource = await readUniqueRegularFileBounded(
    manifestPath,
    MAX_FORMAL_MANIFEST_BYTES,
  );
  if (sha256Bytes(manifestSource) !== expectedManifestSha256) {
    throw new Error("The deployment manifest changed after formal release verification.");
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(manifestSource.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("The verified deployment manifest is no longer valid JSON.", { cause: error });
  }
  if (!isReleaseManifest(parsedValue)) {
    throw new Error("The verified deployment manifest no longer has a valid structure.");
  }

  const manifestEntries = parsedValue.files.filter(
    (file) => file.path.startsWith(`${FORMAL_CLIENT_DIRECTORY}/`),
  );
  if (
    manifestEntries.length === 0
    || manifestEntries.length > MAX_FORMAL_CLIENT_ASSET_COUNT
  ) {
    throw new Error("The formal client asset count is outside the startup safety limit.");
  }
  const uniquePaths = new Set(manifestEntries.map((file) => file.path));
  if (uniquePaths.size !== manifestEntries.length) {
    throw new Error("The deployment manifest contains duplicate formal client asset paths.");
  }
  if (manifestEntries.filter((file) => file.path === FORMAL_CLIENT_INDEX_PATH).length !== 1) {
    throw new Error("The deployment manifest must contain exactly one dist/index.html.");
  }

  let declaredTotalBytes = 0;
  for (const entry of manifestEntries) {
    if (clientAssetContentType(entry.path) === null) {
      throw new Error(`Unsupported formal client asset type: ${entry.path}`);
    }
    if (entry.bytes <= 0 || entry.bytes > MAX_FORMAL_CLIENT_ASSET_BYTES) {
      throw new Error(`Formal client asset size is outside the startup safety limit: ${entry.path}`);
    }
    declaredTotalBytes += entry.bytes;
    if (declaredTotalBytes > MAX_FORMAL_CLIENT_TOTAL_BYTES) {
      throw new Error("Formal client assets exceed the total startup memory limit.");
    }
  }

  const files: FormalProductionClientAsset[] = [];
  for (const entry of manifestEntries) {
    const absolutePath = await assertOrdinaryContainedAssetPath(
      rootDirectory,
      realRootDirectory,
      entry.path,
    );
    const body = await readUniqueRegularFileBounded(
      absolutePath,
      MAX_FORMAL_CLIENT_ASSET_BYTES,
    );
    if (body.byteLength !== entry.bytes) {
      throw new Error(`Formal client asset size changed after release verification: ${entry.path}`);
    }
    if (sha256Bytes(body) !== entry.sha256) {
      throw new Error(`Formal client asset SHA-256 changed after release verification: ${entry.path}`);
    }
    const contentType = clientAssetContentType(entry.path);
    if (contentType === null) {
      throw new Error(`Unsupported formal client asset type: ${entry.path}`);
    }
    files.push(Object.freeze({
      manifestPath: entry.path,
      requestPath: `/${entry.path.slice(`${FORMAL_CLIENT_DIRECTORY}/`.length)}`,
      contentType,
      sha256: entry.sha256,
      body,
    }));
  }
  files.sort((left, right) => left.requestPath.localeCompare(right.requestPath, "en"));
  const index = files.find((file) => file.manifestPath === FORMAL_CLIENT_INDEX_PATH);
  if (index === undefined) {
    throw new Error("The verified formal client index could not be loaded.");
  }
  return Object.freeze({
    index,
    files: Object.freeze(files),
    totalBytes: declaredTotalBytes,
  });
}
