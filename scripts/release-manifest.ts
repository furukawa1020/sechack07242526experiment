import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const RELEASE_MANIFEST_NAME = "DEPLOYMENT_MANIFEST.json";

export interface ReleaseManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly appVersion: string;
  readonly protocolVersion: string;
  readonly configHash: string;
  readonly configFileHash: string;
  readonly createdAt: string;
  readonly buildRuntime: {
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly files: readonly ReleaseManifestFile[];
}

function toManifestPath(value: string): string {
  return value.split(sep).join("/");
}

function isSafeManifestPath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || isAbsolute(value)) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isIgnoredRuntimeFile(path: string): boolean {
  return path.startsWith("data/");
}

async function sha256File(path: string): Promise<string> {
  const source = await readFile(path);
  return createHash("sha256").update(source).digest("hex");
}

async function listRegularFiles(rootDirectory: string, currentDirectory = rootDirectory): Promise<readonly string[]> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = resolve(currentDirectory, entry.name);
    const relativePath = toManifestPath(relative(rootDirectory, absolutePath));
    if (relativePath === RELEASE_MANIFEST_NAME || isIgnoredRuntimeFile(relativePath)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in a release: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...await listRegularFiles(rootDirectory, absolutePath));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported release entry: ${relativePath}`);
    }
    files.push(relativePath);
  }
  files.sort((left, right) => left.localeCompare(right));
  return Object.freeze(files);
}

function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.appVersion !== "string"
    || typeof candidate.protocolVersion !== "string"
    || !/^[a-f0-9]{64}$/u.test(String(candidate.configHash))
    || !/^[a-f0-9]{64}$/u.test(String(candidate.configFileHash))
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
      && /^[a-f0-9]{64}$/u.test(record.sha256);
  });
}

export async function createReleaseManifest(
  releaseDirectory: string,
  metadata: Pick<ReleaseManifest, "appVersion" | "protocolVersion" | "configHash" | "configFileHash">,
): Promise<ReleaseManifest> {
  const rootDirectory = resolve(releaseDirectory);
  const paths = await listRegularFiles(rootDirectory);
  const files: ReleaseManifestFile[] = [];
  for (const path of paths) {
    const absolutePath = resolve(rootDirectory, path);
    const pathFromRoot = relative(rootDirectory, absolutePath);
    if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
      throw new Error(`Release file escaped the release directory: ${path}`);
    }
    const fileStat = await lstat(absolutePath);
    files.push(Object.freeze({
      path,
      bytes: fileStat.size,
      sha256: await sha256File(absolutePath),
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    appVersion: metadata.appVersion,
    protocolVersion: metadata.protocolVersion,
    configHash: metadata.configHash,
    configFileHash: metadata.configFileHash,
    createdAt: new Date().toISOString(),
    buildRuntime: Object.freeze({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
    files: Object.freeze(files),
  });
}

export async function writeReleaseManifest(
  releaseDirectory: string,
  manifest: ReleaseManifest,
): Promise<void> {
  await writeFile(
    resolve(releaseDirectory, RELEASE_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

export async function verifyReleaseDirectory(releaseDirectory: string): Promise<readonly string[]> {
  const rootDirectory = resolve(releaseDirectory);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(rootDirectory, RELEASE_MANIFEST_NAME), "utf8")) as unknown;
  } catch (error) {
    return Object.freeze([
      `Deployment manifest could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
    ]);
  }
  if (!isReleaseManifest(parsed)) {
    return Object.freeze(["Deployment manifest has an invalid structure."]);
  }

  const errors: string[] = [];
  if (parsed.buildRuntime.node !== process.version) {
    errors.push(`Node runtime mismatch: expected ${parsed.buildRuntime.node}, got ${process.version}`);
  }
  if (parsed.buildRuntime.platform !== process.platform) {
    errors.push(`Platform mismatch: expected ${parsed.buildRuntime.platform}, got ${process.platform}`);
  }
  if (parsed.buildRuntime.arch !== process.arch) {
    errors.push(`Architecture mismatch: expected ${parsed.buildRuntime.arch}, got ${process.arch}`);
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
      if (fileStat.size !== file.bytes) errors.push(`Size mismatch: ${file.path}`);
      const digest = await sha256File(absolutePath);
      if (digest !== file.sha256) errors.push(`SHA-256 mismatch: ${file.path}`);
    } catch (error) {
      errors.push(`Missing or unreadable file: ${file.path} (${error instanceof Error ? error.message : "error"})`);
    }
  }
  return Object.freeze(errors);
}
