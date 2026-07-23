import {
  SCREEN_PROTOCOL_VERSION,
  type ApprovalEvidence,
  type ExperimentConfig,
  type ProductionGoEvidence,
  type ReleaseReview,
} from "./schemas.js";

export type ProductionDevicePolicyIssueCode =
  | "mock-device-not-allowed"
  | "serial-device-not-allowed"
  | "serial-path-not-windows-com"
  | "screen-serial-path-not-empty"
  | "production-protocol-version-not-screen"
  | "screen-mode-protocol-mismatch"
  | "screen-protocol-mode-mismatch"
  | "allow-mock-in-production-enabled";

export type ProductionProtocolPolicyIssueCode =
  | "screen-fixed-state-mismatch"
  | "screen-timing-mismatch"
  | "screen-orders-mismatch"
  | "screen-research-id-pattern-mismatch";

export type ProductionFormPolicyIssueCode =
  | "production-form-url-not-empty"
  | "production-form-audit-present";

export type ProductionNetworkPolicyIssueCode =
  | "production-bind-host-not-127-0-0-1"
  | "production-port-not-4173"
  | "production-lan-access-enabled"
  | "production-external-runtime-requests-enabled";

export type ProductionCompliancePolicyIssueCode =
  | "production-environment-not-production"
  | "production-participant-mode-not-enabled"
  | "production-compliance-mode-not-external"
  | "production-evidence-storage-not-outside-system"
  | "production-evidence-verified-by-application"
  | "production-approval-document-required"
  | "production-approval-hash-required"
  | "production-second-verifier-required"
  | "production-reviewer-identity-required"
  | "production-screen-pilot-required"
  | "production-manual-go-ticket-required"
  | "production-go-evidence-present"
  | "production-operator-confirmation-not-required"
  | "production-operator-confirmation-persisted"
  | "production-consent-confirmation-not-required"
  | "production-emergency-stop-check-not-required"
  | "production-operator-identity-storage-enabled"
  | "production-approval-evidence-storage-enabled"
  | "production-approval-hash-storage-enabled"
  | "production-ip-storage-enabled"
  | "production-analytics-enabled"
  | "production-telemetry-enabled";

export const SCREEN_PRODUCTION_FIXED_STATE = Object.freeze({
  score: 72,
  label: "高ストレス",
  pufferLevel: 0.6,
} as const);

export const SCREEN_PRODUCTION_TIMING_MS = Object.freeze({
  handling: 8_000,
  processing: 3_000,
  result: 15_000,
  reset: 7_000,
  inflateRamp: 6_000,
  deflateRamp: 6_000,
} as const);

export const SCREEN_PRODUCTION_ORDERS = Object.freeze([
  "ABDC",
  "BCAD",
  "CDBA",
  "DACB",
] as const);

export const SCREEN_PRODUCTION_RESEARCH_ID_PATTERN = "^SH26-[0-9]{3}$";
export const SCREEN_PRODUCTION_BIND_HOST = "127.0.0.1";
export const SCREEN_PRODUCTION_PORT = 4_173;

export interface ProductionPolicyAssessment {
  readonly approved: boolean;
  readonly deviceIssues: readonly ProductionDevicePolicyIssueCode[];
  readonly protocolIssues: readonly ProductionProtocolPolicyIssueCode[];
  readonly formIssues: readonly ProductionFormPolicyIssueCode[];
  readonly networkIssues: readonly ProductionNetworkPolicyIssueCode[];
  readonly complianceIssues: readonly ProductionCompliancePolicyIssueCode[];
}

export interface ProductionPolicyContext {
  /** Canonical SHA-256 of the production config with goEvidence omitted. */
  readonly criticalConfigSha256?: string;
}

export interface ProductionGoEvidenceAssessment {
  readonly approved: boolean;
  readonly issues: readonly string[];
  readonly criticalConfigSha256: string | null;
}

export type ProductionPolicySubject = Pick<
  ExperimentConfig,
  | "device"
  | "bindHost"
  | "compliance"
  | "environment"
  | "fixedState"
  | "formAudit"
  | "formUrl"
  | "goEvidence"
  | "orders"
  | "port"
  | "protocolVersion"
  | "researchIdPattern"
  | "timingMs"
  | "network"
  | "participantMode"
  | "privacy"
  | "runtime"
>;

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PLACEHOLDER_SHA256 = "0".repeat(64);
const PLACEHOLDER_TOKEN_PATTERN = /(?:^|[._:/-])(?:PENDING|TBD|TODO|EXAMPLE|PLACEHOLDER|DUMMY|SAMPLE)(?:[0-9]+)?(?:$|[._:/-])/iu;
const MAX_RELEASE_REVIEW_AGE_DAYS = 30;

function isPlaceholderDigest(value: string): boolean {
  if (!SHA256_PATTERN.test(value)) return true;
  if (value === PLACEHOLDER_SHA256) return true;
  // Reject conspicuously synthetic values such as aaaa… or deadbeefdeadbeef… .
  // A real SHA-256 digest matching a period of 16 characters or less is
  // cryptographically negligible, while these values are common placeholders.
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
  return new Date(milliseconds).toISOString().slice(0, 10) === value
    ? milliseconds
    : null;
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
  if (approvedOn === null) {
    issues.push(`${path}:approval-date-missing`);
  }
  if (applicableUntil === null) {
    issues.push(`${path}:applicability-deadline-missing`);
  }
  if (approvedOn === null || applicableUntil === null) return;
  const approvedDay = calendarDateToUtcMs(approvedOn);
  const applicableDay = calendarDateToUtcMs(applicableUntil);
  if (approvedDay === null) issues.push(`${path}:approval-date-invalid`);
  if (applicableDay === null) issues.push(`${path}:applicability-deadline-invalid`);
  if (approvedDay === null || applicableDay === null) return;
  if (nowDay !== null && approvedDay > nowDay) {
    issues.push(`${path}:approval-date-in-future`);
  }
  if (applicableDay < approvedDay) issues.push(`${path}:invalid-applicability-range`);
  if (nowDay !== null && applicableDay < nowDay) {
    const ageDays = Math.floor((nowDay - applicableDay) / DAY_MS);
    issues.push(`${path}:applicability-expired-${String(ageDays)}-days`);
  }
}

function assessApprovalRecord(
  path: string,
  record: ApprovalEvidence,
  protocolVersion: string,
  nowDay: number | null,
  issues: string[],
): void {
  if (record.status !== "GO") issues.push(`${path}:status-not-go`);
  if (record.protocolVersion !== protocolVersion) {
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
  assessEvidenceDates(
    path,
    record.approvedOn,
    record.applicableUntil,
    nowDay,
    issues,
  );
}

function assessReleaseReview(
  path: string,
  review: ReleaseReview,
  protocolVersion: string,
  criticalConfigSha256: string | undefined,
  nowDay: number | null,
  issues: string[],
): void {
  if (review.status !== "GO") issues.push(`${path}:status-not-go`);
  if (review.protocolVersion !== protocolVersion) {
    issues.push(`${path}:protocol-version-mismatch`);
  }
  if (
    criticalConfigSha256 === undefined
    || review.criticalConfigSha256 !== criticalConfigSha256
  ) {
    issues.push(`${path}:critical-config-sha256-mismatch`);
  }
  if (
    isPlaceholderDigest(review.attestationSha256)
  ) {
    issues.push(`${path}:attestation-sha256-unapproved`);
  }
  if (containsPlaceholderToken(review.reviewId)) {
    issues.push(`${path}:${/PENDING/iu.test(review.reviewId) ? "review-id-pending" : "review-id-placeholder"}`);
  }
  if (containsPlaceholderToken(review.reviewerCode)) {
    issues.push(`${path}:${/PENDING/iu.test(review.reviewerCode) ? "reviewer-code-pending" : "reviewer-code-placeholder"}`);
  }
  if (containsPlaceholderToken(review.reviewVersion)) {
    issues.push(`${path}:${/PENDING/iu.test(review.reviewVersion) ? "review-version-pending" : "review-version-placeholder"}`);
  }
  assessEvidenceDates(
    path,
    review.reviewedOn,
    review.applicableUntil,
    nowDay,
    issues,
  );
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

/**
 * Verifies local, non-PII approval evidence only. documentId, reviewId and
 * reviewerCode are opaque operational codes; names and email addresses do not
 * belong in this configuration or in release artifacts.
 */
export function assessProductionGoEvidence(
  evidence: ProductionGoEvidence | undefined,
  protocolVersion: string,
  now: Date,
  criticalConfigSha256: string | undefined,
): ProductionGoEvidenceAssessment {
  if (evidence === undefined) {
    return Object.freeze({
      approved: false,
      issues: Object.freeze(["missing"]),
      criticalConfigSha256: criticalConfigSha256 ?? null,
    });
  }
  const issues: string[] = [];
  const nowCalendarDate = japanCalendarDate(now);
  const nowDay = nowCalendarDate === null ? null : calendarDateToUtcMs(nowCalendarDate);
  if (nowDay === null) {
    issues.push("clock:calendar-date-invalid");
  }
  if (evidence.status !== "GO") issues.push("status-not-go");
  if (evidence.protocolVersion !== protocolVersion) {
    issues.push("protocol-version-mismatch");
  }
  if (criticalConfigSha256 === undefined) {
    issues.push("critical-config-sha256-unavailable");
  } else if (evidence.criticalConfigSha256 !== criticalConfigSha256) {
    issues.push("critical-config-sha256-mismatch");
  }

  const approvalRecords = [
    ["researchPlan", evidence.researchPlan],
    ["ethicsDetermination", evidence.ethicsDetermination],
    ["preStimulusConsent", evidence.preStimulusConsent],
    ["dataManagementPlan", evidence.dataManagementPlan],
    ["screenPilot", evidence.screenPilot],
  ] as const;
  for (const [path, record] of approvalRecords) {
    assessApprovalRecord(path, record, protocolVersion, nowDay, issues);
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
  if (releaseVerification.protocolVersion !== protocolVersion) {
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
  if (
    criticalConfigSha256 === undefined
    || releaseVerification.criticalConfigSha256 !== criticalConfigSha256
  ) {
    issues.push("releaseVerification:critical-config-sha256-mismatch");
  }
  releaseVerification.reviews.forEach((review, index) => {
    assessReleaseReview(
      `releaseVerification.reviews.${String(index)}`,
      review,
      protocolVersion,
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

  return Object.freeze({
    approved: issues.length === 0,
    issues: Object.freeze(issues),
    criticalConfigSha256: criticalConfigSha256 ?? null,
  });
}

export function isWindowsComPath(value: string): boolean {
  return /^(?:COM[1-9][0-9]*|\\\\\.\\COM[1-9][0-9]*)$/iu.test(value.trim());
}

/**
 * Evaluates every production entry point. The formal runtime has no Google
 * Form integration: questionnaire handoff is an external staff operation, so
 * both the runtime URL and the legacy in-app form-audit record must be absent.
 * Approval evidence remains outside this application. Production enforces only
 * the closed external-compliance declaration and runtime safety confirmations.
 */
export function assessProductionPolicy(
  subject: ProductionPolicySubject,
  _now = new Date(),
  _context: ProductionPolicyContext = {},
): ProductionPolicyAssessment {
  const deviceIssues: ProductionDevicePolicyIssueCode[] = [];
  const protocolIssues: ProductionProtocolPolicyIssueCode[] = [];
  const formIssues: ProductionFormPolicyIssueCode[] = [];
  const networkIssues: ProductionNetworkPolicyIssueCode[] = [];
  const complianceIssues: ProductionCompliancePolicyIssueCode[] = [];

  if (subject.device.mode === "mock") {
    deviceIssues.push("mock-device-not-allowed");
  } else if (subject.device.mode === "serial") {
    deviceIssues.push("serial-device-not-allowed");
    if (!isWindowsComPath(subject.device.serialPath)) {
      deviceIssues.push("serial-path-not-windows-com");
    }
  } else if (subject.device.serialPath !== "") {
    deviceIssues.push("screen-serial-path-not-empty");
  }

  if (
    subject.device.mode === "screen"
    && subject.protocolVersion !== SCREEN_PROTOCOL_VERSION
  ) {
    deviceIssues.push("screen-mode-protocol-mismatch");
  }
  if (
    subject.protocolVersion === SCREEN_PROTOCOL_VERSION
    && subject.device.mode !== "screen"
  ) {
    deviceIssues.push("screen-protocol-mode-mismatch");
  }
  if (subject.protocolVersion !== SCREEN_PROTOCOL_VERSION) {
    deviceIssues.push("production-protocol-version-not-screen");
  }

  if (subject.device.allowMockInProduction) {
    deviceIssues.push("allow-mock-in-production-enabled");
  }

  if (
    subject.fixedState.score !== SCREEN_PRODUCTION_FIXED_STATE.score
    || subject.fixedState.label !== SCREEN_PRODUCTION_FIXED_STATE.label
    || subject.fixedState.pufferLevel !== SCREEN_PRODUCTION_FIXED_STATE.pufferLevel
  ) {
    protocolIssues.push("screen-fixed-state-mismatch");
  }
  if (
    subject.timingMs.handling !== SCREEN_PRODUCTION_TIMING_MS.handling
    || subject.timingMs.processing !== SCREEN_PRODUCTION_TIMING_MS.processing
    || subject.timingMs.result !== SCREEN_PRODUCTION_TIMING_MS.result
    || subject.timingMs.reset !== SCREEN_PRODUCTION_TIMING_MS.reset
    || subject.timingMs.inflateRamp !== SCREEN_PRODUCTION_TIMING_MS.inflateRamp
    || subject.timingMs.deflateRamp !== SCREEN_PRODUCTION_TIMING_MS.deflateRamp
  ) {
    protocolIssues.push("screen-timing-mismatch");
  }
  if (
    subject.orders.length !== SCREEN_PRODUCTION_ORDERS.length
    || subject.orders.some((order, index) => order !== SCREEN_PRODUCTION_ORDERS[index])
  ) {
    protocolIssues.push("screen-orders-mismatch");
  }
  if (subject.researchIdPattern !== SCREEN_PRODUCTION_RESEARCH_ID_PATTERN) {
    protocolIssues.push("screen-research-id-pattern-mismatch");
  }

  if (subject.formUrl !== "") {
    formIssues.push("production-form-url-not-empty");
  }
  if (subject.formAudit !== undefined) {
    formIssues.push("production-form-audit-present");
  }

  if (subject.bindHost !== SCREEN_PRODUCTION_BIND_HOST) {
    networkIssues.push("production-bind-host-not-127-0-0-1");
  }
  if (subject.port !== SCREEN_PRODUCTION_PORT) {
    networkIssues.push("production-port-not-4173");
  }
  if (subject.network.allowLan) {
    networkIssues.push("production-lan-access-enabled");
  }
  if (subject.network.allowExternalRuntimeRequests) {
    networkIssues.push("production-external-runtime-requests-enabled");
  }

  if (subject.environment !== "production") {
    complianceIssues.push("production-environment-not-production");
  }
  if (subject.participantMode !== "enabled") {
    complianceIssues.push("production-participant-mode-not-enabled");
  }
  if (subject.compliance.mode !== "external") {
    complianceIssues.push("production-compliance-mode-not-external");
  }
  if (subject.compliance.evidenceStorage !== "outside-system") {
    complianceIssues.push("production-evidence-storage-not-outside-system");
  }
  if (subject.compliance.verifiedByApplication !== false) {
    complianceIssues.push("production-evidence-verified-by-application");
  }
  if (subject.compliance.requireApprovalDocument !== false) {
    complianceIssues.push("production-approval-document-required");
  }
  if (subject.compliance.requireApprovalHash !== false) {
    complianceIssues.push("production-approval-hash-required");
  }
  if (subject.compliance.requireSecondVerifier !== false) {
    complianceIssues.push("production-second-verifier-required");
  }
  if (subject.compliance.requireReviewerIdentity !== false) {
    complianceIssues.push("production-reviewer-identity-required");
  }
  if (subject.compliance.requireScreenPilotForRelease !== false) {
    complianceIssues.push("production-screen-pilot-required");
  }
  if (subject.compliance.requireManualGoTicket !== false) {
    complianceIssues.push("production-manual-go-ticket-required");
  }
  if (subject.goEvidence !== undefined) {
    complianceIssues.push("production-go-evidence-present");
  }
  if (subject.runtime.requireOperatorSessionConfirmation !== true) {
    complianceIssues.push("production-operator-confirmation-not-required");
  }
  if (subject.runtime.persistOperatorConfirmation !== false) {
    complianceIssues.push("production-operator-confirmation-persisted");
  }
  if (subject.runtime.requireConsentConfirmation !== true) {
    complianceIssues.push("production-consent-confirmation-not-required");
  }
  if (subject.runtime.requireEmergencyStopCheck !== true) {
    complianceIssues.push("production-emergency-stop-check-not-required");
  }
  if (subject.privacy.storeOperatorIdentity !== false) {
    complianceIssues.push("production-operator-identity-storage-enabled");
  }
  if (subject.privacy.storeApprovalEvidence !== false) {
    complianceIssues.push("production-approval-evidence-storage-enabled");
  }
  if (subject.privacy.storeApprovalHash !== false) {
    complianceIssues.push("production-approval-hash-storage-enabled");
  }
  if (subject.privacy.storeIpAddress !== false) {
    complianceIssues.push("production-ip-storage-enabled");
  }
  if (subject.privacy.analyticsEnabled !== false) {
    complianceIssues.push("production-analytics-enabled");
  }
  if (subject.privacy.telemetryEnabled !== false) {
    complianceIssues.push("production-telemetry-enabled");
  }

  return Object.freeze({
    approved: deviceIssues.length === 0
      && protocolIssues.length === 0
      && formIssues.length === 0
      && networkIssues.length === 0
      && complianceIssues.length === 0,
    deviceIssues: Object.freeze(deviceIssues),
    protocolIssues: Object.freeze(protocolIssues),
    formIssues: Object.freeze(formIssues),
    networkIssues: Object.freeze(networkIssues),
    complianceIssues: Object.freeze(complianceIssues),
  });
}
