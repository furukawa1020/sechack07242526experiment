import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { ExperimentConfig } from "./schemas.js";

export const FORMAL_SCREEN_PROTOCOL_VERSION = "R8-010-2x2-screen-v3";
export const FORMAL_PRODUCTION_CONFIG_PATH = "config/experiment.json";
export const FORMAL_PRODUCTION_BIND_HOST = "127.0.0.1";
export const FORMAL_PRODUCTION_PORT = 4_173;

const FORMAL_FIXED_STATE = Object.freeze({
  score: 72,
  label: "高ストレス",
  pufferLevel: 0.6,
} as const);

const FORMAL_TIMING_MS = Object.freeze({
  handling: 8_000,
  processing: 3_000,
  result: 15_000,
  reset: 7_000,
  inflateRamp: 6_000,
  deflateRamp: 6_000,
} as const);

const singleLineText = z.string().min(1).max(200).refine(
  (value) => !/[\r\n]/u.test(value),
  "Line breaks are not allowed.",
);

const safeRelativeDirectory = z.string().min(1).max(240).refine(
  (value) => !/[\0\r\n]/u.test(value),
  "The logging directory contains a forbidden character.",
);

const evidenceDateSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/u,
  "Evidence dates must use YYYY-MM-DD.",
).refine((value) => {
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString().slice(0, 10) === value;
}, "Evidence dates must be valid calendar dates.");

const sha256Schema = z.string().regex(
  /^[a-f0-9]{64}$/u,
  "Evidence digests must be lowercase SHA-256 values.",
);

const evidenceIdentifierSchema = z.string().regex(
  /^[A-Z0-9][A-Z0-9._:/-]{2,79}$/u,
  "Evidence identifiers must be opaque uppercase codes without names, email addresses or whitespace.",
);

const evidenceVersionSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/u,
  "Evidence versions may contain only letters, digits, dot, underscore, colon and hyphen.",
);

const approvalEvidenceSchema = z.object({
  status: z.enum(["GO", "NO-GO"]),
  protocolVersion: singleLineText,
  documentId: evidenceIdentifierSchema,
  documentVersion: evidenceVersionSchema,
  contentSha256: sha256Schema,
  approvedOn: evidenceDateSchema.nullable(),
  applicableUntil: evidenceDateSchema.nullable(),
}).strict();

const screenPilotEvidenceSchema = approvalEvidenceSchema.extend({
  completedSessions: z.number().int().min(3).max(5).nullable(),
  sourceTreeSha256: sha256Schema,
  pilotConfigFileHash: sha256Schema,
}).strict();

const releaseReviewSchema = z.object({
  reviewId: evidenceIdentifierSchema,
  reviewerCode: z.string().regex(
    /^REV-[A-Z0-9]{4,32}$/u,
    "reviewerCode must be an opaque REV- code and must not contain a person's name.",
  ),
  reviewVersion: evidenceVersionSchema,
  status: z.enum(["GO", "NO-GO"]),
  protocolVersion: singleLineText,
  criticalConfigSha256: sha256Schema,
  reviewedOn: evidenceDateSchema.nullable(),
  applicableUntil: evidenceDateSchema.nullable(),
  attestationSha256: sha256Schema,
}).strict();

const productionGoEvidenceSchema = z.object({
  status: z.enum(["GO", "NO-GO"]),
  protocolVersion: singleLineText,
  criticalConfigSha256: sha256Schema,
  researchPlan: approvalEvidenceSchema,
  ethicsDetermination: approvalEvidenceSchema,
  preStimulusConsent: approvalEvidenceSchema,
  dataManagementPlan: approvalEvidenceSchema,
  screenPilot: screenPilotEvidenceSchema,
  releaseVerification: z.object({
    status: z.enum(["GO", "NO-GO"]),
    protocolVersion: singleLineText,
    appVersion: evidenceVersionSchema,
    criticalConfigSha256: sha256Schema,
    sourceTreeSha256: sha256Schema,
    reviews: z.tuple([releaseReviewSchema, releaseReviewSchema]),
  }).strict(),
}).strict();

/**
 * Closed production schema. It deliberately has no legacy questionnaire-audit
 * field and accepts only an empty external-questionnaire destination.
 */
const formalProductionConfigSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(FORMAL_SCREEN_PROTOCOL_VERSION),
  studyTitle: singleLineText,
  bindHost: z.literal(FORMAL_PRODUCTION_BIND_HOST),
  port: z.literal(FORMAL_PRODUCTION_PORT),
  researchIdPattern: z.literal("^SH26-[0-9]{3}$"),
  orders: z.tuple([
    z.literal("ABDC"),
    z.literal("BCAD"),
    z.literal("CDBA"),
    z.literal("DACB"),
  ]),
  fixedState: z.object({
    score: z.literal(FORMAL_FIXED_STATE.score),
    label: z.literal(FORMAL_FIXED_STATE.label),
    pufferLevel: z.literal(FORMAL_FIXED_STATE.pufferLevel),
  }).strict(),
  timingMs: z.object({
    handling: z.literal(FORMAL_TIMING_MS.handling),
    processing: z.literal(FORMAL_TIMING_MS.processing),
    result: z.literal(FORMAL_TIMING_MS.result),
    reset: z.literal(FORMAL_TIMING_MS.reset),
    inflateRamp: z.literal(FORMAL_TIMING_MS.inflateRamp),
    deflateRamp: z.literal(FORMAL_TIMING_MS.deflateRamp),
  }).strict(),
  device: z.object({
    mode: z.literal("screen"),
    serialPath: z.literal(""),
    baudRate: z.number().int().min(1_200).max(4_000_000),
    ackTimeout: z.number().int().min(50).max(60_000),
    allowMockInProduction: z.literal(false),
  }).strict(),
  formUrl: z.literal(""),
  goEvidence: productionGoEvidenceSchema,
  logging: z.object({
    directory: safeRelativeDirectory,
    includeAbortedInOrderBalancing: z.boolean(),
  }).strict(),
  network: z.object({
    allowLan: z.literal(false),
    allowExternalRuntimeRequests: z.literal(false),
  }).strict(),
}).strict();

export type FormalProductionConfig = ExperimentConfig & Readonly<
  z.infer<typeof formalProductionConfigSchema>
>;

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

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PLACEHOLDER_SHA256 = "0".repeat(64);
const PLACEHOLDER_TOKEN_PATTERN = /(?:^|[._:/-])(?:PENDING|TBD|TODO|EXAMPLE|PLACEHOLDER|DUMMY|SAMPLE)(?:[0-9]+)?(?:$|[._:/-])/iu;
const MAX_RELEASE_REVIEW_AGE_DAYS = 30;

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function parseFormalProductionConfig(input: unknown): FormalProductionConfig {
  return deepFreeze(formalProductionConfigSchema.parse(input)) as FormalProductionConfig;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function hashFormalProductionConfig(config: FormalProductionConfig): string {
  return createHash("sha256").update(JSON.stringify(config), "utf8").digest("hex");
}

export function hashFormalProductionCriticalConfig(config: FormalProductionConfig): string {
  const criticalConfig = Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== "goEvidence"),
  );
  return sha256Canonical(criticalConfig);
}

export function hashFormalProductionGoEvidence(config: FormalProductionConfig): string {
  return sha256Canonical(config.goEvidence);
}

function isPlaceholderDigest(value: string): boolean {
  if (!SHA256_PATTERN.test(value) || value === PLACEHOLDER_SHA256) return true;
  for (let period = 1; period <= 16; period += 1) {
    if (64 % period !== 0) continue;
    const fragment = value.slice(0, period);
    if (fragment.repeat(64 / period) === value) return true;
  }
  return false;
}

function containsPlaceholderToken(value: string): boolean {
  return PLACEHOLDER_TOKEN_PATTERN.test(value);
}

function calendarDateToUtcMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString().slice(0, 10) === value ? milliseconds : null;
}

function japanCalendarDate(value: Date): string | null {
  if (!Number.isFinite(value.getTime())) return null;
  return new Date(value.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function assessEvidenceDates(
  path: string,
  approvedOn: string | null,
  applicableUntil: string | null,
  nowDay: number | null,
  issues: string[],
): void {
  if (approvedOn === null) issues.push(`${path}:approval-date-missing`);
  if (applicableUntil === null) issues.push(`${path}:applicability-deadline-missing`);
  if (approvedOn === null || applicableUntil === null) return;
  const approvedDay = calendarDateToUtcMs(approvedOn);
  const applicableDay = calendarDateToUtcMs(applicableUntil);
  if (approvedDay === null) issues.push(`${path}:approval-date-invalid`);
  if (applicableDay === null) issues.push(`${path}:applicability-deadline-invalid`);
  if (approvedDay === null || applicableDay === null) return;
  if (nowDay !== null && approvedDay > nowDay) issues.push(`${path}:approval-date-in-future`);
  if (applicableDay < approvedDay) issues.push(`${path}:invalid-applicability-range`);
  if (nowDay !== null && applicableDay < nowDay) {
    const ageDays = Math.floor((nowDay - applicableDay) / DAY_MS);
    issues.push(`${path}:applicability-expired-${String(ageDays)}-days`);
  }
}

type FormalEvidence = FormalProductionConfig["goEvidence"];
type FormalApproval = FormalEvidence["researchPlan"];
type FormalReview = FormalEvidence["releaseVerification"]["reviews"][number];

function assessApprovalRecord(
  path: string,
  record: FormalApproval,
  nowDay: number | null,
  issues: string[],
): void {
  if (record.status !== "GO") issues.push(`${path}:status-not-go`);
  if (record.protocolVersion !== FORMAL_SCREEN_PROTOCOL_VERSION) {
    issues.push(`${path}:protocol-version-mismatch`);
  }
  if (isPlaceholderDigest(record.contentSha256)) {
    issues.push(`${path}:content-sha256-unapproved`);
  }
  if (containsPlaceholderToken(record.documentId)) {
    issues.push(`${path}:${/PENDING/iu.test(record.documentId) ? "document-id-pending" : "document-id-placeholder"}`);
  }
  if (containsPlaceholderToken(record.documentVersion)) {
    issues.push(`${path}:${/PENDING/iu.test(record.documentVersion) ? "document-version-pending" : "document-version-placeholder"}`);
  }
  assessEvidenceDates(path, record.approvedOn, record.applicableUntil, nowDay, issues);
}

function assessReleaseReview(
  path: string,
  review: FormalReview,
  criticalConfigSha256: string,
  nowDay: number | null,
  issues: string[],
): void {
  if (review.status !== "GO") issues.push(`${path}:status-not-go`);
  if (review.protocolVersion !== FORMAL_SCREEN_PROTOCOL_VERSION) {
    issues.push(`${path}:protocol-version-mismatch`);
  }
  if (review.criticalConfigSha256 !== criticalConfigSha256) {
    issues.push(`${path}:critical-config-sha256-mismatch`);
  }
  if (isPlaceholderDigest(review.attestationSha256)) {
    issues.push(`${path}:attestation-sha256-unapproved`);
  }
  for (const [field, value] of [
    ["review-id", review.reviewId],
    ["reviewer-code", review.reviewerCode],
    ["review-version", review.reviewVersion],
  ] as const) {
    if (containsPlaceholderToken(value)) {
      issues.push(`${path}:${field}-${/PENDING/iu.test(value) ? "pending" : "placeholder"}`);
    }
  }
  assessEvidenceDates(path, review.reviewedOn, review.applicableUntil, nowDay, issues);
  if (review.reviewedOn !== null && nowDay !== null) {
    const reviewedDay = calendarDateToUtcMs(review.reviewedOn);
    if (reviewedDay !== null && reviewedDay <= nowDay) {
      const ageDays = Math.floor((nowDay - reviewedDay) / DAY_MS);
      if (ageDays > MAX_RELEASE_REVIEW_AGE_DAYS) {
        issues.push(`${path}:review-stale-${String(ageDays)}-days`);
      }
    }
  }
}

function assessFormalGoEvidence(
  evidence: FormalEvidence,
  now: Date,
  criticalConfigSha256: string,
): readonly string[] {
  const issues: string[] = [];
  const nowCalendarDate = japanCalendarDate(now);
  const nowDay = nowCalendarDate === null ? null : calendarDateToUtcMs(nowCalendarDate);
  if (nowDay === null) issues.push("clock:calendar-date-invalid");
  if (evidence.status !== "GO") issues.push("status-not-go");
  if (evidence.protocolVersion !== FORMAL_SCREEN_PROTOCOL_VERSION) {
    issues.push("protocol-version-mismatch");
  }
  if (evidence.criticalConfigSha256 !== criticalConfigSha256) {
    issues.push("critical-config-sha256-mismatch");
  }
  for (const [path, record] of [
    ["researchPlan", evidence.researchPlan],
    ["ethicsDetermination", evidence.ethicsDetermination],
    ["preStimulusConsent", evidence.preStimulusConsent],
    ["dataManagementPlan", evidence.dataManagementPlan],
    ["screenPilot", evidence.screenPilot],
  ] as const) {
    assessApprovalRecord(path, record, nowDay, issues);
  }
  if (evidence.screenPilot.completedSessions === null) {
    issues.push("screenPilot:completed-sessions-missing");
  }
  if (isPlaceholderDigest(evidence.screenPilot.sourceTreeSha256)) {
    issues.push("screenPilot:source-tree-sha256-unapproved");
  }
  if (isPlaceholderDigest(evidence.screenPilot.pilotConfigFileHash)) {
    issues.push("screenPilot:pilot-config-file-hash-unapproved");
  }
  const releaseVerification = evidence.releaseVerification;
  if (releaseVerification.status !== "GO") {
    issues.push("releaseVerification:status-not-go");
  }
  if (releaseVerification.protocolVersion !== FORMAL_SCREEN_PROTOCOL_VERSION) {
    issues.push("releaseVerification:protocol-version-mismatch");
  }
  if (containsPlaceholderToken(releaseVerification.appVersion)) {
    issues.push("releaseVerification:app-version-placeholder");
  }
  if (isPlaceholderDigest(releaseVerification.sourceTreeSha256)) {
    issues.push("releaseVerification:source-tree-sha256-unapproved");
  }
  if (evidence.screenPilot.sourceTreeSha256 !== releaseVerification.sourceTreeSha256) {
    issues.push("screenPilot:source-tree-sha256-mismatch");
  }
  if (releaseVerification.criticalConfigSha256 !== criticalConfigSha256) {
    issues.push("releaseVerification:critical-config-sha256-mismatch");
  }
  releaseVerification.reviews.forEach((review, index) => {
    assessReleaseReview(
      `releaseVerification.reviews.${String(index)}`,
      review,
      criticalConfigSha256,
      nowDay,
      issues,
    );
  });
  const [firstReview, secondReview] = releaseVerification.reviews;
  if (firstReview.reviewId === secondReview.reviewId) {
    issues.push("releaseVerification:duplicate-review-id");
  }
  if (firstReview.reviewerCode === secondReview.reviewerCode) {
    issues.push("releaseVerification:duplicate-reviewer-code");
  }
  if (firstReview.reviewVersion !== secondReview.reviewVersion) {
    issues.push("releaseVerification:review-version-mismatch");
  }
  if (firstReview.attestationSha256 === secondReview.attestationSha256) {
    issues.push("releaseVerification:duplicate-attestation-sha256");
  }
  return Object.freeze(issues);
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
    || (!pathFromAllowedDirectory.startsWith("..") && !isAbsolute(pathFromAllowedDirectory))
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
  const criticalConfigSha256 = hashFormalProductionCriticalConfig(config);
  const evidenceIssues = assessFormalGoEvidence(
    config.goEvidence,
    options.currentDate ?? new Date(),
    criticalConfigSha256,
  );
  if (evidenceIssues.length > 0) {
    throw new Error(`Production GO evidence gate rejected the config (${evidenceIssues.join(", ")}).`);
  }
  return Object.freeze({
    config,
    configHash: hashFormalProductionConfig(config),
    configFileHash: createHash("sha256").update(sourceBytes).digest("hex"),
    sourceBytes: Uint8Array.from(sourceBytes),
    path: configPath,
  });
}
