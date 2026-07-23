import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  parseExperimentConfig,
  type ExperimentConfig,
} from "./schemas.js";
import { assessProductionPolicy } from "./production-policy.js";

export interface LoadExperimentConfigOptions {
  /** Repository root. Defaults to process.cwd(). */
  readonly rootDirectory?: string;
  /** Allowed config directory. Defaults to <rootDirectory>/config. */
  readonly allowedDirectory?: string;
  readonly production?: boolean;
  /** Test-only clock override for the production form-audit freshness gate. */
  readonly currentDate?: Date;
}

export interface LoadedExperimentConfig {
  readonly config: ExperimentConfig;
  readonly configHash: string;
  /** SHA-256 of the exact config file bytes read from disk. */
  readonly configFileHash: string;
  /** Exact bytes parsed and hashed for this snapshot. */
  readonly sourceBytes: Uint8Array;
  readonly path: string;
}

function resolveSafeConfigPath(
  requestedPath: string,
  options: LoadExperimentConfigOptions,
): string {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const allowedDirectory = resolve(options.allowedDirectory ?? resolve(rootDirectory, "config"));
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(rootDirectory, requestedPath);
  const pathFromAllowedDirectory = relative(allowedDirectory, candidate);
  if (
    pathFromAllowedDirectory === ""
    || (
      !pathFromAllowedDirectory.startsWith("..")
      && !isAbsolute(pathFromAllowedDirectory)
    )
  ) {
    return candidate;
  }
  throw new Error("The experiment config path must remain inside the allowed config directory.");
}

export function hashExperimentConfig(config: ExperimentConfig): string {
  return createHash("sha256").update(JSON.stringify(config), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

const LEGACY_APPROVAL_STATE_KEYS = Object.freeze([
  "goEvidence",
  "approvalStatus",
  "pendingApproval",
  "approvalPending",
  "approvalDocument",
  "approvalHash",
  "secondVerifier",
  "twoPerson",
  "dualVerification",
  "reviewerCount",
  "screenPilot",
  "productionGo",
  "manualGo",
  "releaseTicket",
  "evidenceRequired",
] as const);

/**
 * Migration boundary for external-compliance production. Old in-application
 * approval state is discarded before validation and is never returned in the
 * runtime config. It therefore cannot become a release/start gate or be
 * persisted by application code.
 */
export function normalizeExternalComplianceConfigInput(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const source = input as Readonly<Record<string, unknown>>;
  const compliance = source["compliance"];
  if (
    compliance === null
    || typeof compliance !== "object"
    || Array.isArray(compliance)
    || (compliance as Readonly<Record<string, unknown>>)["mode"] !== "external"
  ) {
    return input;
  }
  const normalized: Record<string, unknown> = { ...source };
  for (const key of LEGACY_APPROVAL_STATE_KEYS) {
    Reflect.deleteProperty(normalized, key);
  }
  return normalized;
}

/**
 * Hashes all runtime-relevant configuration. Legacy goEvidence is excluded
 * because production rejects it and approval evidence is managed externally.
 */
export function hashProductionCriticalConfig(config: ExperimentConfig): string {
  const criticalConfig = Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== "goEvidence"),
  );
  return sha256Canonical(criticalConfig);
}

export function hashProductionGoEvidence(_config: ExperimentConfig): null {
  void _config;
  // Schema-v4 manifest compatibility only. External compliance never hashes
  // or packages approval evidence.
  return null;
}

export async function loadExperimentConfig(
  requestedPath = "config/experiment.json",
  options: LoadExperimentConfigOptions = {},
): Promise<LoadedExperimentConfig> {
  const resolvedConfigPath = resolveSafeConfigPath(requestedPath, options);
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const allowedDirectory = resolve(options.allowedDirectory ?? resolve(rootDirectory, "config"));
  const configStat = await lstat(resolvedConfigPath);
  if (configStat.isSymbolicLink()) {
    throw new Error("The experiment config must not be a symbolic link or junction.");
  }
  const [realAllowedDirectory, configPath] = await Promise.all([
    realpath(allowedDirectory),
    realpath(resolvedConfigPath),
  ]);
  const realRelativePath = relative(realAllowedDirectory, configPath);
  if (
    realRelativePath === ".."
    || realRelativePath.startsWith("../")
    || realRelativePath.startsWith("..\\")
    || isAbsolute(realRelativePath)
  ) {
    throw new Error("The experiment config resolved outside the allowed config directory.");
  }
  const sourceBytes = await readFile(configPath);
  const source = sourceBytes.toString("utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `Experiment config is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }

  const normalizedJson = options.production === true
    ? normalizeExternalComplianceConfigInput(parsedJson)
    : parsedJson;
  const config = parseExperimentConfig(normalizedJson);
  if (options.production === true) {
    const productionPolicy = assessProductionPolicy(
      config,
      options.currentDate ?? new Date(),
      { criticalConfigSha256: hashProductionCriticalConfig(config) },
    );
    if (productionPolicy.deviceIssues.includes("mock-device-not-allowed")) {
      throw new Error("Mock device mode is unconditionally disabled in production.");
    }
    if (productionPolicy.deviceIssues.length > 0) {
      throw new Error(
        `Production device policy rejected the config (${productionPolicy.deviceIssues.join(", ")}).`,
      );
    }
    if (productionPolicy.protocolIssues.length > 0) {
      throw new Error(
        `Production screen protocol policy rejected the config (${productionPolicy.protocolIssues.join(", ")}).`,
      );
    }
    if (productionPolicy.formIssues.length > 0) {
      throw new Error(
        `Production form integration policy rejected the config (${productionPolicy.formIssues.join(", ")}).`,
      );
    }
    if (productionPolicy.networkIssues.length > 0) {
      throw new Error(
        `Production network policy rejected the config (${productionPolicy.networkIssues.join(", ")}).`,
      );
    }
    if (productionPolicy.complianceIssues.length > 0) {
      throw new Error(
        `Production external compliance policy rejected the config (${productionPolicy.complianceIssues.join(", ")}).`,
      );
    }
  }

  return Object.freeze({
    config,
    configHash: hashExperimentConfig(config),
    configFileHash: createHash("sha256").update(sourceBytes).digest("hex"),
    sourceBytes: Uint8Array.from(sourceBytes),
    path: configPath,
  });
}
