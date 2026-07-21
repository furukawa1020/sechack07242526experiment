export const EXPERIMENT_LOG_EVENT_ALLOWED_FIELDS = Object.freeze([
  "schemaVersion",
  "protocolVersion",
  "appVersion",
  "configHash",
  "sessionId",
  "researchId",
  "orderCode",
  "sequenceIndex",
  "conditionCode",
  "processing",
  "presentation",
  "phase",
  "eventType",
  "wallClockIso",
  "monotonicMs",
  "fixedScore",
  "pufferLevel",
  "deviceMode",
  "deviceStatus",
  "result",
  "errorCode",
] as const);

export type ExperimentLogEventAllowedField =
  (typeof EXPERIMENT_LOG_EVENT_ALLOWED_FIELDS)[number];

const allowedFields = new Set<string>(EXPERIMENT_LOG_EVENT_ALLOWED_FIELDS);

export function findUnexpectedExperimentLogEventFields(
  input: object,
): readonly string[] {
  return Object.freeze(
    Object.keys(input)
      .filter((field) => !allowedFields.has(field))
      .sort(),
  );
}

export function assertExperimentLogEventFieldAllowlist(
  input: unknown,
): asserts input is Readonly<Record<string, unknown>> {
  if (typeof input !== "object") {
    throw new TypeError("An experiment log event must be an object.");
  }
  if (input === null) {
    throw new TypeError("An experiment log event must be an object.");
  }
  if (Array.isArray(input)) {
    throw new TypeError("An experiment log event must be an object.");
  }

  const eventRecord = input as Readonly<Record<string, unknown>>;
  const unexpectedFields = findUnexpectedExperimentLogEventFields(eventRecord);
  if (unexpectedFields.length > 0) {
    throw new TypeError(
      `Experiment log event contains forbidden fields: ${unexpectedFields.join(", ")}.`,
    );
  }
}
