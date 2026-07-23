import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { ExperimentConfig } from "./schemas.js";
import {
  SCREEN_PRODUCTION_BIND_HOST,
  SCREEN_PRODUCTION_FIXED_STATE,
  SCREEN_PRODUCTION_ORDERS,
  SCREEN_PRODUCTION_PORT,
  SCREEN_PRODUCTION_RESEARCH_ID_PATTERN,
  SCREEN_PRODUCTION_TIMING_MS,
  SCREEN_PROTOCOL_VERSION,
} from "./screen-production-protocol.js";

export const FORMAL_SCREEN_PROTOCOL_VERSION = SCREEN_PROTOCOL_VERSION;
export const FORMAL_PRODUCTION_CONFIG_PATH = "config/experiment.json";
export const FORMAL_PRODUCTION_BIND_HOST = SCREEN_PRODUCTION_BIND_HOST;
export const FORMAL_PRODUCTION_PORT = SCREEN_PRODUCTION_PORT;

const singleLineText = z.string().min(1).max(200).refine(
  (value) => !/[\r\n]/u.test(value),
  "Line breaks are not allowed.",
);

const safeRelativeDirectory = z.string().min(1).max(240).refine(
  (value) => !/[\0\r\n]/u.test(value),
  "The logging directory contains a forbidden character.",
);

const FormalProductionConfigSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: singleLineText,
  environment: z.enum([
    "development",
    "test",
    "rehearsal",
    "screen-pilot",
    "production",
  ]),
  participantMode: z.enum(["disabled", "enabled"]),
  compliance: z.object({
    mode: singleLineText,
    evidenceStorage: singleLineText,
    verifiedByApplication: z.boolean(),
    requireApprovalDocument: z.boolean(),
    requireApprovalHash: z.boolean(),
    requireSecondVerifier: z.boolean(),
    requireReviewerIdentity: z.boolean(),
    requireScreenPilotForRelease: z.boolean(),
    requireManualGoTicket: z.boolean(),
  }).strict(),
  runtime: z.object({
    requireOperatorSessionConfirmation: z.boolean(),
    persistOperatorConfirmation: z.boolean(),
    requireConsentConfirmation: z.boolean(),
    requireEmergencyStopCheck: z.boolean(),
  }).strict(),
  privacy: z.object({
    storeOperatorIdentity: z.boolean(),
    storeApprovalEvidence: z.boolean(),
    storeApprovalHash: z.boolean(),
    storeIpAddress: z.boolean(),
    analyticsEnabled: z.boolean(),
    telemetryEnabled: z.boolean(),
  }).strict(),
  studyTitle: singleLineText,
  bindHost: singleLineText,
  port: z.number().int().min(1_024).max(65_535),
  researchIdPattern: z.string().min(1).max(160).refine((pattern) => {
    if (/[\r\n]/u.test(pattern)) return false;
    try {
      void new RegExp(pattern, "u");
      return true;
    } catch {
      return false;
    }
  }, "researchIdPattern must be a valid single-line regular expression."),
  orders: z.array(z.enum(SCREEN_PRODUCTION_ORDERS)).length(4),
  fixedState: z.object({
    score: z.number().int().min(0).max(100),
    label: singleLineText,
    pufferLevel: z.number().min(0).max(1),
  }).strict(),
  timingMs: z.object({
    handling: z.number().int().positive().max(600_000),
    processing: z.number().int().positive().max(600_000),
    result: z.number().int().positive().max(600_000),
    reset: z.number().int().positive().max(600_000),
    inflateRamp: z.number().int().positive().max(600_000),
    deflateRamp: z.number().int().positive().max(600_000),
  }).strict(),
  device: z.object({
    mode: z.enum(["mock", "serial", "screen"]),
    serialPath: z.string().max(240).refine((value) => !/[\0\r\n]/u.test(value)),
    baudRate: z.number().int().min(1_200).max(4_000_000),
    ackTimeout: z.number().int().min(50).max(60_000),
    allowMockInProduction: z.boolean(),
  }).strict(),
  // The field remains only as an empty compatibility slot in the config file.
  // No external questionnaire host, audit schema, or runtime integration is
  // imported into the sealed screen-v3 bundle.
  formUrl: z.string().max(2_048),
  logging: z.object({
    directory: safeRelativeDirectory,
    includeAbortedInOrderBalancing: z.boolean(),
  }).strict(),
  network: z.object({
    allowLan: z.boolean(),
    allowExternalRuntimeRequests: z.boolean(),
  }).strict(),
}).strict();

/**
 * The formal shape is structurally compatible with ExperimentConfig so the
 * existing device, session, and logging domain APIs need no parallel runtime
 * model. The generic schema is a type-only dependency and is not bundled.
 */
export type FormalProductionConfig = ExperimentConfig;

export interface FormalLoadedExperimentConfig {
  readonly config: FormalProductionConfig;
  readonly configHash: string;
  readonly configFileHash: string;
  readonly sourceBytes: Uint8Array;
  readonly path: string;
}

export interface LoadFormalProductionConfigOptions {
  readonly rootDirectory?: string;
  readonly allowedDirectory?: string;
  readonly currentDate?: Date;
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

function normalizeExternalComplianceInput(input: unknown): unknown {
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

function formalPolicyErrors(config: z.infer<typeof FormalProductionConfigSchema>): readonly string[] {
  const issues: string[] = [];

  if (config.device.mode === "mock") {
    issues.push("mock-device-not-allowed");
  } else if (config.device.mode === "serial") {
    issues.push("serial-device-not-allowed");
  } else if (config.device.serialPath !== "") {
    issues.push("screen-serial-path-not-empty");
  }
  if (config.protocolVersion !== SCREEN_PROTOCOL_VERSION) {
    issues.push("production-protocol-version-not-screen");
  }
  if (config.device.allowMockInProduction) {
    issues.push("allow-mock-in-production-enabled");
  }
  if (
    config.fixedState.score !== SCREEN_PRODUCTION_FIXED_STATE.score
    || config.fixedState.label !== SCREEN_PRODUCTION_FIXED_STATE.label
    || config.fixedState.pufferLevel !== SCREEN_PRODUCTION_FIXED_STATE.pufferLevel
  ) {
    issues.push("screen-fixed-state-mismatch");
  }
  if (
    config.timingMs.handling !== SCREEN_PRODUCTION_TIMING_MS.handling
    || config.timingMs.processing !== SCREEN_PRODUCTION_TIMING_MS.processing
    || config.timingMs.result !== SCREEN_PRODUCTION_TIMING_MS.result
    || config.timingMs.reset !== SCREEN_PRODUCTION_TIMING_MS.reset
    || config.timingMs.inflateRamp !== SCREEN_PRODUCTION_TIMING_MS.inflateRamp
    || config.timingMs.deflateRamp !== SCREEN_PRODUCTION_TIMING_MS.deflateRamp
  ) {
    issues.push("screen-timing-mismatch");
  }
  if (
    config.orders.length !== SCREEN_PRODUCTION_ORDERS.length
    || config.orders.some((order, index) => order !== SCREEN_PRODUCTION_ORDERS[index])
  ) {
    issues.push("screen-orders-mismatch");
  }
  if (config.researchIdPattern !== SCREEN_PRODUCTION_RESEARCH_ID_PATTERN) {
    issues.push("screen-research-id-pattern-mismatch");
  }
  if (config.formUrl !== "") {
    issues.push("production-form-url-not-empty");
  }
  if (config.bindHost !== SCREEN_PRODUCTION_BIND_HOST) {
    issues.push("production-bind-host-not-127-0-0-1");
  }
  if (config.port !== SCREEN_PRODUCTION_PORT) {
    issues.push("production-port-not-4173");
  }
  if (config.network.allowLan) {
    issues.push("production-lan-access-enabled");
  }
  if (config.network.allowExternalRuntimeRequests) {
    issues.push("production-external-runtime-requests-enabled");
  }
  if (config.environment !== "production") {
    issues.push("production-environment-not-production");
  }
  if (config.participantMode !== "enabled") {
    issues.push("production-participant-mode-not-enabled");
  }
  if (config.compliance.mode !== "external") {
    issues.push("production-compliance-mode-not-external");
  }
  if (config.compliance.evidenceStorage !== "outside-system") {
    issues.push("production-evidence-storage-not-outside-system");
  }
  if (config.compliance.verifiedByApplication) {
    issues.push("production-evidence-verified-by-application");
  }
  if (config.compliance.requireApprovalDocument) {
    issues.push("production-approval-document-required");
  }
  if (config.compliance.requireApprovalHash) {
    issues.push("production-approval-hash-required");
  }
  if (config.compliance.requireSecondVerifier) {
    issues.push("production-second-verifier-required");
  }
  if (config.compliance.requireReviewerIdentity) {
    issues.push("production-reviewer-identity-required");
  }
  if (config.compliance.requireScreenPilotForRelease) {
    issues.push("production-screen-pilot-required");
  }
  if (config.compliance.requireManualGoTicket) {
    issues.push("production-manual-go-ticket-required");
  }
  if (!config.runtime.requireOperatorSessionConfirmation) {
    issues.push("production-operator-confirmation-not-required");
  }
  if (config.runtime.persistOperatorConfirmation) {
    issues.push("production-operator-confirmation-persisted");
  }
  if (!config.runtime.requireConsentConfirmation) {
    issues.push("production-consent-confirmation-not-required");
  }
  if (!config.runtime.requireEmergencyStopCheck) {
    issues.push("production-emergency-stop-check-not-required");
  }
  if (config.privacy.storeOperatorIdentity) {
    issues.push("production-operator-identity-storage-enabled");
  }
  if (config.privacy.storeApprovalEvidence) {
    issues.push("production-approval-evidence-storage-enabled");
  }
  if (config.privacy.storeApprovalHash) {
    issues.push("production-approval-hash-storage-enabled");
  }
  if (config.privacy.storeIpAddress) {
    issues.push("production-ip-storage-enabled");
  }
  if (config.privacy.analyticsEnabled) {
    issues.push("production-analytics-enabled");
  }
  if (config.privacy.telemetryEnabled) {
    issues.push("production-telemetry-enabled");
  }

  return Object.freeze(issues);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function parseFormalProductionConfig(input: unknown): FormalProductionConfig {
  const parsed = FormalProductionConfigSchema.parse(
    normalizeExternalComplianceInput(input),
  );
  const issues = formalPolicyErrors(parsed);
  if (issues.length > 0) {
    throw new Error(`Formal production config rejected (${issues.join(", ")}).`);
  }
  return deepFreeze(parsed) as FormalProductionConfig;
}

export function formatFormalProductionConfigError(error: unknown): readonly string[] {
  if (error instanceof z.ZodError) {
    return Object.freeze(error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${path}: ${issue.message}`;
    }));
  }
  return Object.freeze([error instanceof Error ? error.message : "Unknown configuration error."]);
}

export function hashFormalProductionConfig(config: FormalProductionConfig): string {
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

export function hashFormalProductionCriticalConfig(config: FormalProductionConfig): string {
  const criticalConfig = Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== "goEvidence"),
  );
  return createHash("sha256").update(canonicalJson(criticalConfig), "utf8").digest("hex");
}

/**
 * Kept as a compatibility surface for schema-v4 manifests. External
 * compliance never packages approval evidence, so the value is always null.
 */
export function hashFormalProductionGoEvidence(
  _config: FormalProductionConfig,
): null {
  void _config;
  return null;
}

function resolveSafeConfigPath(
  requestedPath: string,
  options: LoadFormalProductionConfigOptions,
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

export async function loadFormalProductionConfig(
  requestedPath = FORMAL_PRODUCTION_CONFIG_PATH,
  options: LoadFormalProductionConfigOptions = {},
): Promise<FormalLoadedExperimentConfig> {
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
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(sourceBytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Experiment config is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }
  const config = parseFormalProductionConfig(parsedJson);
  return Object.freeze({
    config,
    configHash: hashFormalProductionConfig(config),
    configFileHash: createHash("sha256").update(sourceBytes).digest("hex"),
    sourceBytes: Uint8Array.from(sourceBytes),
    path: configPath,
  });
}
