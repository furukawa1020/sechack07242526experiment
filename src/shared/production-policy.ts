import {
  assessFormAudit,
  STUDY_FORM_URL,
  type FormAuditAssessment,
} from "./form-audit.js";
import {
  SCREEN_PROTOCOL_VERSION,
  type ExperimentConfig,
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

export interface ProductionPolicyAssessment {
  readonly approved: boolean;
  readonly deviceIssues: readonly ProductionDevicePolicyIssueCode[];
  readonly protocolIssues: readonly ProductionProtocolPolicyIssueCode[];
  readonly formUrlMatchesStudy: boolean;
  readonly formAudit: FormAuditAssessment;
}

export type ProductionPolicySubject = Pick<
  ExperimentConfig,
  | "device"
  | "fixedState"
  | "formAudit"
  | "formUrl"
  | "orders"
  | "protocolVersion"
  | "researchIdPattern"
  | "timingMs"
>;

export function isWindowsComPath(value: string): boolean {
  return /^(?:COM[1-9][0-9]*|\\\\\.\\COM[1-9][0-9]*)$/iu.test(value.trim());
}

/**
 * Evaluates the device and Google Form evidence that every production entry
 * point must enforce. It never fetches the form or turns human evidence into
 * an approval automatically.
 */
export function assessProductionPolicy(
  subject: ProductionPolicySubject,
  now = new Date(),
): ProductionPolicyAssessment {
  const deviceIssues: ProductionDevicePolicyIssueCode[] = [];
  const protocolIssues: ProductionProtocolPolicyIssueCode[] = [];

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

  const formUrlMatchesStudy = subject.formUrl === STUDY_FORM_URL;
  const formAudit = assessFormAudit(subject, now);

  return Object.freeze({
    approved: deviceIssues.length === 0
      && protocolIssues.length === 0
      && formUrlMatchesStudy
      && formAudit.approved,
    deviceIssues: Object.freeze(deviceIssues),
    protocolIssues: Object.freeze(protocolIssues),
    formUrlMatchesStudy,
    formAudit,
  });
}
