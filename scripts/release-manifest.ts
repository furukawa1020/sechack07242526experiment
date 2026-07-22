import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  hashExperimentConfig,
  hashProductionCriticalConfig,
  hashProductionGoEvidence,
} from "../src/shared/config-loader.js";
import {
  parseExperimentConfig,
  type ExperimentConfig,
} from "../src/shared/schemas.js";

export const RELEASE_MANIFEST_NAME = "DEPLOYMENT_MANIFEST.json";

export interface ReleaseManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly schemaVersion: 4;
  readonly appVersion: string;
  readonly protocolVersion: string;
  readonly configHash: string;
  readonly configFileHash: string;
  readonly criticalConfigSha256: string;
  readonly goEvidenceSha256: string | null;
  readonly sourceCommit: string;
  readonly sourceTreeSha256: string;
  readonly sourceEvidenceBindingSha256: string;
  readonly sourceRepository?: string;
  readonly createdAt: string;
  readonly buildRuntime: {
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly files: readonly ReleaseManifestFile[];
}

export interface ReleaseVerificationResult {
  readonly errors: readonly string[];
  readonly manifestSha256: string | null;
  readonly sourceCommit: string | null;
  readonly sourceRepository?: string;
  /** Immutable manifest values bound to the verified production runtime. */
  readonly manifest: {
    readonly appVersion: string;
    readonly protocolVersion: string;
    readonly configHash: string;
    readonly configFileHash: string;
    readonly criticalConfigSha256: string;
    readonly goEvidenceSha256: string | null;
    readonly sourceTreeSha256: string;
    readonly sourceEvidenceBindingSha256: string;
  } | null;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const APP_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const RELEASE_CONFIG_PATHS = Object.freeze([
  "config/experiment.json",
  "config/experiment.mock-rehearsal.json",
]);

export function hashSourceEvidenceBinding(input: {
  readonly appVersion: string;
  readonly sourceCommit: string;
  readonly sourceTreeSha256: string;
  readonly criticalConfigSha256: string;
  readonly goEvidenceSha256: string | null;
}): string {
  return createHash("sha256").update(
    [
      "sechack-release-source-evidence-v2",
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

function sha256Bytes(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

export function isCredentialFreeSourceRepository(value: string): boolean {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (value.length === 0 || value.trim() !== value || hasControlCharacter) {
    return false;
  }
  if (/^git@[a-z0-9.-]+:[a-z0-9._~/-]+$/iu.test(value)) return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (!["https:", "ssh:", "git:"].includes(parsed.protocol)) return false;
  if (
    parsed.hostname.length === 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
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

async function listRegularFiles(
  rootDirectory: string,
  currentDirectory = rootDirectory,
): Promise<readonly string[]> {
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
      files.push(...(await listRegularFiles(rootDirectory, absolutePath)));
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
    candidate.schemaVersion !== 4 ||
    typeof candidate.appVersion !== "string" ||
    !APP_VERSION_PATTERN.test(candidate.appVersion) ||
    typeof candidate.protocolVersion !== "string" ||
    !SHA256_PATTERN.test(String(candidate.configHash)) ||
    !SHA256_PATTERN.test(String(candidate.configFileHash)) ||
    !SHA256_PATTERN.test(String(candidate.criticalConfigSha256)) ||
    !(
      candidate.goEvidenceSha256 === null
      || (
        typeof candidate.goEvidenceSha256 === "string"
        && SHA256_PATTERN.test(candidate.goEvidenceSha256)
      )
    ) ||
    typeof candidate.sourceCommit !== "string" ||
    !SOURCE_COMMIT_PATTERN.test(candidate.sourceCommit) ||
    typeof candidate.sourceTreeSha256 !== "string" ||
    !SHA256_PATTERN.test(candidate.sourceTreeSha256) ||
    typeof candidate.sourceEvidenceBindingSha256 !== "string" ||
    !SHA256_PATTERN.test(candidate.sourceEvidenceBindingSha256) ||
    (candidate.sourceRepository !== undefined &&
      (typeof candidate.sourceRepository !== "string" ||
        !isCredentialFreeSourceRepository(candidate.sourceRepository))) ||
    typeof candidate.createdAt !== "string" ||
    !Array.isArray(candidate.files)
  ) {
    return false;
  }
  const runtime = candidate.buildRuntime;
  if (runtime === null || typeof runtime !== "object") return false;
  const runtimeRecord = runtime as Record<string, unknown>;
  if (
    typeof runtimeRecord.node !== "string" ||
    typeof runtimeRecord.platform !== "string" ||
    typeof runtimeRecord.arch !== "string"
  ) {
    return false;
  }
  return candidate.files.every((file) => {
    if (file === null || typeof file !== "object") return false;
    const record = file as Record<string, unknown>;
    return (
      typeof record.path === "string" &&
      isSafeManifestPath(record.path) &&
      typeof record.bytes === "number" &&
      Number.isSafeInteger(record.bytes) &&
      record.bytes >= 0 &&
      typeof record.sha256 === "string" &&
      SHA256_PATTERN.test(record.sha256)
    );
  });
}

export async function createReleaseManifest(
  releaseDirectory: string,
  metadata: Pick<
    ReleaseManifest,
    | "appVersion"
    | "protocolVersion"
    | "configHash"
    | "configFileHash"
    | "sourceCommit"
    | "sourceTreeSha256"
    | "sourceRepository"
  >,
): Promise<ReleaseManifest> {
  if (!APP_VERSION_PATTERN.test(metadata.appVersion)) {
    throw new Error("Release appVersion contains forbidden characters or exceeds 80 characters.");
  }
  if (!SOURCE_COMMIT_PATTERN.test(metadata.sourceCommit)) {
    throw new Error("Release source commit must be a full lowercase 40-character Git commit ID.");
  }
  if (
    metadata.sourceRepository !== undefined &&
    !isCredentialFreeSourceRepository(metadata.sourceRepository)
  ) {
    throw new Error("Release source repository is not a credential-free supported Git URL.");
  }
  if (!SHA256_PATTERN.test(metadata.configHash)) {
    throw new Error("Release config hash must be a lowercase SHA-256 digest.");
  }
  if (!SHA256_PATTERN.test(metadata.configFileHash)) {
    throw new Error("Release config file hash must be a lowercase SHA-256 digest.");
  }
  if (!SHA256_PATTERN.test(metadata.sourceTreeSha256)) {
    throw new Error("Release source tree hash must be a lowercase SHA-256 digest.");
  }
  const rootDirectory = resolve(releaseDirectory);
  const paths = await listRegularFiles(rootDirectory);
  if (paths.filter((path) => path === "package.json").length !== 1) {
    throw new Error("Release payload must include exactly one package.json file.");
  }
  try {
    const packageValue: unknown = JSON.parse(
      await readFile(resolve(rootDirectory, "package.json"), "utf8"),
    );
    const packageVersion = packageValue !== null && typeof packageValue === "object"
      ? (packageValue as Readonly<Record<string, unknown>>)["version"]
      : undefined;
    if (packageVersion !== metadata.appVersion) {
      throw new Error("Release appVersion does not match the packaged package.json.");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Release appVersion does not match the packaged package.json.") {
      throw error;
    }
    throw new Error(
      "Release package.json could not be parsed for appVersion binding.",
      { cause: error },
    );
  }
  const includedConfigPaths = RELEASE_CONFIG_PATHS.filter((path) => paths.includes(path));
  if (includedConfigPaths.length !== 1) {
    throw new Error("Release payload must include exactly one approved experiment config path.");
  }
  const configPath = includedConfigPaths[0]!;
  const configSource = await readFile(resolve(rootDirectory, configPath));
  if (sha256Bytes(configSource) !== metadata.configFileHash) {
    throw new Error("Release config file hash does not match the packaged config bytes.");
  }
  let config: ExperimentConfig;
  try {
    config = parseExperimentConfig(
      JSON.parse(new TextDecoder().decode(configSource)) as unknown,
    );
  } catch {
    throw new Error("Release config could not be parsed for manifest binding.");
  }
  if (hashExperimentConfig(config) !== metadata.configHash) {
    throw new Error("Release config semantic hash does not match the packaged config.");
  }
  if (config.protocolVersion !== metadata.protocolVersion) {
    throw new Error("Release protocolVersion does not match the packaged config.");
  }
  const criticalConfigSha256 = hashProductionCriticalConfig(config);
  const goEvidenceSha256 = hashProductionGoEvidence(config);
  const releaseVerification = config.goEvidence?.releaseVerification;
  if (
    releaseVerification !== undefined
    && releaseVerification.appVersion !== metadata.appVersion
  ) {
    throw new Error("Release appVersion does not match the packaged GO evidence.");
  }
  if (
    releaseVerification !== undefined
    && releaseVerification.sourceTreeSha256 !== metadata.sourceTreeSha256
  ) {
    throw new Error("Release source tree SHA-256 does not match the packaged GO evidence.");
  }
  const sourceEvidenceBindingSha256 = hashSourceEvidenceBinding({
    appVersion: metadata.appVersion,
    sourceCommit: metadata.sourceCommit,
    sourceTreeSha256: metadata.sourceTreeSha256,
    criticalConfigSha256,
    goEvidenceSha256,
  });
  const files: ReleaseManifestFile[] = [];
  for (const path of paths) {
    const absolutePath = resolve(rootDirectory, path);
    const pathFromRoot = relative(rootDirectory, absolutePath);
    if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
      throw new Error(`Release file escaped the release directory: ${path}`);
    }
    const fileStat = await lstat(absolutePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) {
      throw new Error(`Release payload file must be a unique regular file: ${path}`);
    }
    files.push(
      Object.freeze({
        path,
        bytes: fileStat.size,
        sha256: await sha256File(absolutePath),
      }),
    );
  }
  return Object.freeze({
    schemaVersion: 4,
    appVersion: metadata.appVersion,
    protocolVersion: metadata.protocolVersion,
    configHash: metadata.configHash,
    configFileHash: metadata.configFileHash,
    criticalConfigSha256,
    goEvidenceSha256,
    sourceCommit: metadata.sourceCommit,
    sourceTreeSha256: metadata.sourceTreeSha256,
    sourceEvidenceBindingSha256,
    ...(metadata.sourceRepository === undefined
      ? {}
      : { sourceRepository: metadata.sourceRepository }),
    createdAt: new Date().toISOString(),
    buildRuntime: Object.freeze({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
    files: Object.freeze(files),
  });
}

export async function sha256ReleaseManifest(releaseDirectory: string): Promise<string> {
  return sha256File(resolve(releaseDirectory, RELEASE_MANIFEST_NAME));
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

export async function verifyReleaseDirectoryDetailed(
  releaseDirectory: string,
): Promise<ReleaseVerificationResult> {
  const rootDirectory = resolve(releaseDirectory);
  let manifestSource: Uint8Array;
  let manifestSha256: string | null = null;
  let parsed: unknown;
  try {
    const manifestPath = resolve(rootDirectory, RELEASE_MANIFEST_NAME);
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1) {
      throw new Error("Deployment manifest must be a unique regular file.");
    }
    manifestSource = await readFile(manifestPath);
    manifestSha256 = sha256Bytes(manifestSource);
    parsed = JSON.parse(new TextDecoder().decode(manifestSource)) as unknown;
  } catch (error) {
    return Object.freeze({
      errors: Object.freeze([
        `Deployment manifest could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
      ]),
      manifestSha256,
      sourceCommit: null,
      manifest: null,
    });
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
  const expectedSourceEvidenceBindingSha256 = hashSourceEvidenceBinding({
    appVersion: parsed.appVersion,
    sourceCommit: parsed.sourceCommit,
    sourceTreeSha256: parsed.sourceTreeSha256,
    criticalConfigSha256: parsed.criticalConfigSha256,
    goEvidenceSha256: parsed.goEvidenceSha256,
  });
  if (parsed.sourceEvidenceBindingSha256 !== expectedSourceEvidenceBindingSha256) {
    errors.push("Source, application, config, and GO evidence binding SHA-256 mismatch.");
  }
  if (parsed.buildRuntime.node !== process.version) {
    errors.push(
      `Node runtime mismatch: expected ${parsed.buildRuntime.node}, got ${process.version}`,
    );
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
  const includedConfigPaths = RELEASE_CONFIG_PATHS.filter((path) =>
    parsed.files.some((file) => file.path === path),
  );
  if (includedConfigPaths.length !== 1) {
    errors.push("Manifest must control exactly one approved experiment config path.");
  } else {
    const configPath = includedConfigPaths[0]!;
    const configEntry = parsed.files.find((file) => file.path === configPath)!;
    if (configEntry.sha256 !== parsed.configFileHash) {
      errors.push(`Manifest config file hash is not bound to its file entry: ${configPath}`);
    }
    try {
      const packagedConfigSource = await readFile(resolve(rootDirectory, configPath));
      const packagedConfigFileHash = sha256Bytes(packagedConfigSource);
      if (packagedConfigFileHash !== parsed.configFileHash) {
        errors.push(`Config file SHA-256 mismatch: ${configPath}`);
      }
      const packagedConfig = parseExperimentConfig(
        JSON.parse(new TextDecoder().decode(packagedConfigSource)) as unknown,
      );
      if (hashExperimentConfig(packagedConfig) !== parsed.configHash) {
        errors.push(`Config semantic SHA-256 mismatch: ${configPath}`);
      }
      if (packagedConfig.protocolVersion !== parsed.protocolVersion) {
        errors.push(
          `Config protocolVersion mismatch: expected ${parsed.protocolVersion}, got ${packagedConfig.protocolVersion}`,
        );
      }
      const packagedCriticalConfigSha256 = hashProductionCriticalConfig(packagedConfig);
      if (packagedCriticalConfigSha256 !== parsed.criticalConfigSha256) {
        errors.push(`Critical config SHA-256 mismatch: ${configPath}`);
      }
      const packagedGoEvidenceSha256 = hashProductionGoEvidence(packagedConfig);
      if (packagedGoEvidenceSha256 !== parsed.goEvidenceSha256) {
        errors.push(`GO evidence SHA-256 mismatch: ${configPath}`);
      }
      const packagedReleaseVerification = packagedConfig.goEvidence?.releaseVerification;
      if (
        packagedReleaseVerification !== undefined
        && packagedReleaseVerification.appVersion !== parsed.appVersion
      ) {
        errors.push(`GO evidence appVersion mismatch: ${configPath}`);
      }
      if (
        packagedReleaseVerification !== undefined
        && packagedReleaseVerification.sourceTreeSha256 !== parsed.sourceTreeSha256
      ) {
        errors.push(`GO evidence source tree SHA-256 mismatch: ${configPath}`);
      }
    } catch {
      errors.push(`Packaged config could not be parsed and bound to manifest metadata: ${configPath}`);
    }
  }
  const expectedPaths = new Set(parsed.files.map((file) => file.path));
  let actualPaths: readonly string[] = [];
  try {
    actualPaths = await listRegularFiles(rootDirectory);
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : "Release contents could not be enumerated.",
    );
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
      const digest = await sha256File(absolutePath);
      if (digest !== file.sha256) errors.push(`SHA-256 mismatch: ${file.path}`);
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

export async function verifyReleaseDirectory(releaseDirectory: string): Promise<readonly string[]> {
  return (await verifyReleaseDirectoryDetailed(releaseDirectory)).errors;
}
