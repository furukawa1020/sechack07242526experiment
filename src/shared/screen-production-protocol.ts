/**
 * Formal screen-v3 stimulus and runtime constants.
 *
 * This module must stay free of legacy questionnaire, approval-evidence,
 * development-device, and test-only dependencies because it is included in
 * the sealed participant runtime.
 */
export const SCREEN_PROTOCOL_VERSION = "R8-010-2x2-screen-v3";

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
