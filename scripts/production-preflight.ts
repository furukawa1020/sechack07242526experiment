import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  realpath,
  statfs,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatFormalProductionConfigError,
  hashFormalProductionCriticalConfig,
  hashFormalProductionGoEvidence,
  loadFormalProductionConfig,
  type FormalLoadedExperimentConfig,
} from "../src/shared/formal-production-config.js";
import { ExperimentLogger } from "../src/server/logging/experiment-log.js";

export const PRODUCTION_CONFIG_PATH = "config/experiment.json";
export const PRODUCTION_MINIMUM_FREE_BYTES = 1_073_741_824n;

export interface ProductionPreflightArguments {
  readonly configPath: typeof PRODUCTION_CONFIG_PATH;
}

export interface ProductionPreflightCheck {
  readonly name: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
}

export interface ProductionPreflightReport {
  readonly configPath: string;
  readonly configHash: string;
  readonly configFileHash: string;
  readonly criticalConfigSha256: string;
  readonly goEvidenceSha256: string;
  readonly protocolVersion: string;
  readonly deviceMode: "screen";
  readonly logPath: string;
  readonly logSessionCount: number;
  readonly availableBytes: bigint | null;
  readonly checks: readonly ProductionPreflightCheck[];
}

export interface CollectProductionPreflightOptions {
  readonly rootDirectory?: string;
  readonly currentDate?: Date;
}

export interface RunProductionPreflightOptions extends CollectProductionPreflightOptions {
  readonly args?: readonly string[];
  readonly writeLine?: (line: string) => void;
}

function normalizedConfigArgument(value: string): string {
  return normalize(value).replaceAll("\\", "/");
}

function assertProductionConfigArgument(value: string): void {
  if (normalizedConfigArgument(value) !== PRODUCTION_CONFIG_PATH) {
    throw new Error(
      `--config is fixed to ${PRODUCTION_CONFIG_PATH} for formal production.`,
    );
  }
}

/**
 * The formal production command deliberately accepts no mode, environment or
 * path overrides. An explicit --config is accepted only when it resolves to
 * the same repository-relative production config name.
 */
export function parseProductionPreflightArguments(
  args: readonly string[],
): ProductionPreflightArguments {
  if (args.length === 0) {
    return Object.freeze({ configPath: PRODUCTION_CONFIG_PATH });
  }
  if (args.length !== 2 || args[0] !== "--config") {
    throw new Error(
      `Usage: production-preflight [--config ${PRODUCTION_CONFIG_PATH}]`,
    );
  }
  const value = args[1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error("--config requires the fixed formal production config path.");
  }
  assertProductionConfigArgument(value);
  return Object.freeze({ configPath: PRODUCTION_CONFIG_PATH });
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (
      pathFromParent !== ".."
      && !pathFromParent.startsWith(`..${sep}`)
      && !isAbsolute(pathFromParent)
    );
}

export function resolveProductionLogPath(
  rootDirectory: string,
  configuredDirectory: string,
): { readonly path: string; readonly safe: boolean } {
  const dataRoot = resolve(rootDirectory, "data");
  const logPath = resolve(rootDirectory, configuredDirectory);
  return Object.freeze({
    path: logPath,
    safe: isInside(dataRoot, logPath),
  });
}

export function isKnownCloudSyncPath(path: string): boolean {
  const segments = resolve(path).split(/[\\/]+/u);
  return segments.some((segment) =>
    /^(?:Dropbox|Google Drive|iCloudDrive|Box)$/iu.test(segment)
    || /^OneDrive(?:\s+-\s+.+)?$/iu.test(segment),
  );
}

async function createDirectoryWithoutLinks(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error("The logging path must contain only ordinary directories.");
  }
}

async function ensureSecureLogDirectory(
  rootDirectory: string,
  logPath: string,
): Promise<string> {
  const dataRoot = resolve(rootDirectory, "data");
  const pathFromDataRoot = relative(dataRoot, logPath);
  if (!isInside(dataRoot, logPath)) {
    throw new Error("The logging directory must remain inside data/.");
  }

  await createDirectoryWithoutLinks(dataRoot);
  const realDataRoot = await realpath(dataRoot);
  let currentPath = dataRoot;
  const segments = pathFromDataRoot === "" ? [] : pathFromDataRoot.split(/[\\/]+/u);
  for (const segment of segments) {
    currentPath = resolve(currentPath, segment);
    await createDirectoryWithoutLinks(currentPath);
    const realCurrentPath = await realpath(currentPath);
    if (!isInside(realDataRoot, realCurrentPath)) {
      throw new Error("The logging directory escaped data/ through its real path.");
    }
  }

  const logPathStat = await lstat(logPath);
  if (logPathStat.isSymbolicLink() || !logPathStat.isDirectory()) {
    throw new Error("The logging directory must not be a symbolic link or junction.");
  }
  const realLogPath = await realpath(logPath);
  if (!isInside(realDataRoot, realLogPath)) {
    throw new Error("The logging directory resolved outside data/.");
  }
  return realLogPath;
}

async function writeAndSyncProbe(logPath: string): Promise<void> {
  const probePath = resolve(logPath, `.production-preflight-${randomUUID()}`);
  let handle: FileHandle | undefined;
  let created = false;
  let closeError: unknown;
  let cleanupError: unknown;
  try {
    handle = await open(probePath, "wx", 0o600);
    created = true;
    await handle.writeFile("production-preflight\n", "utf8");
    await handle.sync();
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        closeError = error;
      }
    }
    if (created) {
      try {
        await unlink(probePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error;
      }
    }
  }
  if (cleanupError !== undefined) {
    throw new Error("The preflight write probe could not be removed.", {
      cause: cleanupError,
    });
  }
  if (closeError !== undefined) {
    throw new Error("The preflight write probe could not be closed safely.", {
      cause: closeError,
    });
  }
}

function failedCheck(name: string, detail: string): ProductionPreflightCheck {
  return Object.freeze({ name, status: "fail", detail });
}

function passedCheck(name: string, detail: string): ProductionPreflightCheck {
  return Object.freeze({ name, status: "pass", detail });
}

async function collectOperationalChecks(
  rootDirectory: string,
  loaded: FormalLoadedExperimentConfig,
): Promise<Pick<
  ProductionPreflightReport,
  "logPath" | "logSessionCount" | "availableBytes" | "checks"
>> {
  const resolvedLog = resolveProductionLogPath(
    rootDirectory,
    loaded.config.logging.directory,
  );
  let realRootDirectory: string;
  try {
    realRootDirectory = await realpath(rootDirectory);
  } catch {
    realRootDirectory = rootDirectory;
  }
  const cloudSyncPath = isKnownCloudSyncPath(rootDirectory)
    || isKnownCloudSyncPath(realRootDirectory)
    || isKnownCloudSyncPath(resolvedLog.path);
  const cloudSyncCheck = cloudSyncPath
    ? failedCheck(
        "logging.cloudSyncPath",
        "The production repository or logging directory is inside a known cloud-sync path.",
      )
    : passedCheck(
        "logging.cloudSyncPath",
        "The production repository and logging directory are not in a known cloud-sync path.",
      );

  let logDirectoryCheck: ProductionPreflightCheck;
  let logIntegrityCheck: ProductionPreflightCheck;
  let diskCheck: ProductionPreflightCheck;
  let logSessionCount = 0;
  let availableBytes: bigint | null = null;

  if (!resolvedLog.safe) {
    logDirectoryCheck = failedCheck(
      "logging.directory",
      "The production logging directory must remain inside data/.",
    );
    logIntegrityCheck = failedCheck(
      "logging.integrity",
      "Log integrity cannot be checked until the logging directory is safe.",
    );
    diskCheck = failedCheck(
      "disk.freeSpace",
      "Free space cannot be checked until the logging directory is safe.",
    );
  } else if (cloudSyncPath) {
    logDirectoryCheck = failedCheck(
      "logging.directory",
      "The logging directory was not probed because cloud-synced production paths are forbidden.",
    );
    logIntegrityCheck = failedCheck(
      "logging.integrity",
      "Log integrity was not read from a forbidden cloud-synced path.",
    );
    diskCheck = failedCheck(
      "disk.freeSpace",
      "Free space was not accepted for a forbidden cloud-synced path.",
    );
  } else {
    let realLogPath: string | undefined;
    try {
      realLogPath = await ensureSecureLogDirectory(rootDirectory, resolvedLog.path);
      await writeAndSyncProbe(realLogPath);
      logDirectoryCheck = passedCheck(
        "logging.directory",
        "The data-contained, non-link logging directory passed write, sync and cleanup checks.",
      );
    } catch (error) {
      logDirectoryCheck = failedCheck(
        "logging.directory",
        `The production logging directory is unsafe or not writable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    if (logDirectoryCheck.status === "pass" && realLogPath !== undefined) {
      try {
        const summaries = await new ExperimentLogger({
          directory: realLogPath,
        }).listSessionSummaries();
        logSessionCount = summaries.length;
        logIntegrityCheck = passedCheck(
          "logging.integrity",
          `${String(logSessionCount)} existing session log(s) passed integrity validation.`,
        );
      } catch (error) {
        logIntegrityCheck = failedCheck(
          "logging.integrity",
          `Existing session logs failed integrity validation: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      try {
        const fileSystem = await statfs(realLogPath, { bigint: true });
        availableBytes = fileSystem.bavail * fileSystem.bsize;
        diskCheck = availableBytes >= PRODUCTION_MINIMUM_FREE_BYTES
          ? passedCheck("disk.freeSpace", "At least 1 GiB is available for production logs.")
          : failedCheck("disk.freeSpace", "Less than 1 GiB is available for production logs.");
      } catch (error) {
        diskCheck = failedCheck(
          "disk.freeSpace",
          `Free space could not be checked: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    } else {
      logIntegrityCheck = failedCheck(
        "logging.integrity",
        "Log integrity cannot be checked until the logging directory passes its safety probe.",
      );
      diskCheck = failedCheck(
        "disk.freeSpace",
        "Free space cannot be checked until the logging directory passes its safety probe.",
      );
    }
  }

  return Object.freeze({
    logPath: resolvedLog.path,
    logSessionCount,
    availableBytes,
    checks: Object.freeze([
      cloudSyncCheck,
      logDirectoryCheck,
      logIntegrityCheck,
      diskCheck,
    ]),
  });
}

export async function collectProductionPreflightReport(
  options: CollectProductionPreflightOptions = {},
): Promise<ProductionPreflightReport> {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const loaded = await loadFormalProductionConfig(PRODUCTION_CONFIG_PATH, {
    rootDirectory,
    ...(options.currentDate === undefined ? {} : { currentDate: options.currentDate }),
  });
  const operational = await collectOperationalChecks(rootDirectory, loaded);
  const configurationCheck = passedCheck(
    "production.configuration",
    "The closed formal production config and its current GO evidence passed validation.",
  );
  return Object.freeze({
    configPath: loaded.path,
    configHash: loaded.configHash,
    configFileHash: loaded.configFileHash,
    criticalConfigSha256: hashFormalProductionCriticalConfig(loaded.config),
    goEvidenceSha256: hashFormalProductionGoEvidence(loaded.config),
    protocolVersion: loaded.config.protocolVersion,
    deviceMode: loaded.config.device.mode,
    logPath: operational.logPath,
    logSessionCount: operational.logSessionCount,
    availableBytes: operational.availableBytes,
    checks: Object.freeze([configurationCheck, ...operational.checks]),
  });
}

export function formatProductionByteCount(bytes: bigint): string {
  const units = [
    { label: "PiB", size: 1_125_899_906_842_624n },
    { label: "TiB", size: 1_099_511_627_776n },
    { label: "GiB", size: 1_073_741_824n },
    { label: "MiB", size: 1_048_576n },
    { label: "KiB", size: 1_024n },
  ] as const;
  const unit = units.find((candidate) => bytes >= candidate.size);
  if (unit === undefined) return `${bytes.toString()} B`;
  const whole = bytes / unit.size;
  const fraction = ((bytes % unit.size) * 100n) / unit.size;
  return `${whole.toString()}.${fraction.toString().padStart(2, "0")} ${unit.label}`;
}

export function renderProductionPreflightReport(
  report: ProductionPreflightReport,
  writeLine: (line: string) => void,
): void {
  writeLine("SecHack365 formal production preflight");
  writeLine(`  config: ${report.configPath}`);
  writeLine(`  config file SHA-256: ${report.configFileHash}`);
  writeLine(`  config SHA-256: ${report.configHash}`);
  writeLine(`  critical config SHA-256: ${report.criticalConfigSha256}`);
  writeLine(`  GO evidence SHA-256: ${report.goEvidenceSha256}`);
  writeLine(`  protocolVersion: ${report.protocolVersion}`);
  writeLine(`  device mode: ${report.deviceMode}`);
  writeLine(`  logging directory: ${report.logPath}`);
  writeLine(`  validated session logs: ${String(report.logSessionCount)}`);
  writeLine(
    `  available space: ${report.availableBytes === null ? "unavailable" : formatProductionByteCount(report.availableBytes)}`,
  );
  for (const check of report.checks) {
    writeLine(`  [${check.status === "pass" ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`);
  }
  const failureCount = report.checks.filter((check) => check.status === "fail").length;
  writeLine(failureCount === 0
    ? "Result: PASS"
    : `Result: FAIL (${String(failureCount)} check(s); do not start production)`);
}

export async function runProductionPreflight(
  options: RunProductionPreflightOptions = {},
): Promise<number> {
  const writeLine = options.writeLine ?? console.info;
  try {
    parseProductionPreflightArguments(options.args ?? process.argv.slice(2));
    const report = await collectProductionPreflightReport({
      ...(options.rootDirectory === undefined ? {} : { rootDirectory: options.rootDirectory }),
      ...(options.currentDate === undefined ? {} : { currentDate: options.currentDate }),
    });
    renderProductionPreflightReport(report, writeLine);
    return report.checks.some((check) => check.status === "fail") ? 1 : 0;
  } catch (error) {
    writeLine("Result: FAIL (formal production preflight did not complete; do not start production)");
    for (const message of formatFormalProductionConfigError(error)) {
      writeLine(`  [FAIL] ${message}`);
    }
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runProductionPreflight();
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  void main();
}
