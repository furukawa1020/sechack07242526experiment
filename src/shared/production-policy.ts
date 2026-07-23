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

export {
  SCREEN_PRODUCTION_BIND_HOST,
  SCREEN_PRODUCTION_FIXED_STATE,
  SCREEN_PRODUCTION_ORDERS,
  SCREEN_PRODUCTION_PORT,
  SCREEN_PRODUCTION_RESEARCH_ID_PATTERN,
  SCREEN_PRODUCTION_TIMING_MS,
} from "./screen-production-protocol.js";

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

export interface ProductionPolicyAssessment {
  readonly technicalReadiness: "GO" | "NO-GO";
  readonly participantMode: "enabled" | "disabled";
  readonly complianceMode: "external";
  readonly approvalEvidence: "managed-outside-system";
  readonly approvalVerifiedByApplication: false;
  readonly deviceIssues: readonly ProductionDevicePolicyIssueCode[];
  readonly protocolIssues: readonly ProductionProtocolPolicyIssueCode[];
  readonly formIssues: readonly ProductionFormPolicyIssueCode[];
  readonly networkIssues: readonly ProductionNetworkPolicyIssueCode[];
  readonly complianceIssues: readonly ProductionCompliancePolicyIssueCode[];
}

export interface ProductionPolicyContext {
  /** Optional technical-integrity hash; never an approval-evidence hash. */
  readonly criticalConfigSha256?: string;
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

export function isWindowsComPath(value: string): boolean {
  return /^(?:COM[1-9][0-9]*|\\\\\.\\COM[1-9][0-9]*)$/iu.test(value.trim());
}

/**
 * Evaluates the formal screen-v3 technical and privacy boundary. Ethics
 * approval is deliberately not evaluated here: in external-compliance mode
 * the responsible organization manages that evidence outside this system.
 */
export function assessProductionPolicy(
  subject: ProductionPolicySubject,
  _now = new Date(),
  _context: ProductionPolicyContext = {},
): ProductionPolicyAssessment {
  void _now;
  void _context;
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

  const technicalReadiness = deviceIssues.length === 0
      && protocolIssues.length === 0
      && formIssues.length === 0
      && networkIssues.length === 0
      && complianceIssues.length === 0
    ? "GO"
    : "NO-GO";

  return Object.freeze({
    technicalReadiness,
    participantMode: subject.participantMode,
    complianceMode: "external",
    approvalEvidence: "managed-outside-system",
    approvalVerifiedByApplication: false,
    deviceIssues: Object.freeze(deviceIssues),
    protocolIssues: Object.freeze(protocolIssues),
    formIssues: Object.freeze(formIssues),
    networkIssues: Object.freeze(networkIssues),
    complianceIssues: Object.freeze(complianceIssues),
  });
}
