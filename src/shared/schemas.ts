import { z } from "zod";

import { ORDER_CODES } from "./conditions.js";

export { STUDY_FORM_URL } from "./form-audit.js";

export const SCREEN_PROTOCOL_VERSION = "R8-010-2x2-screen-v1";

const singleLineText = z.string().min(1).max(200).refine(
  (value) => !/[\r\n]/u.test(value),
  "Line breaks are not allowed.",
);

const safeRelativeDirectory = z.string().min(1).max(240).refine(
  (value) => !/[\0\r\n]/u.test(value),
  "The logging directory contains a forbidden character.",
);

export const OrderCodeSchema = z.enum(ORDER_CODES);

const ordersSchema = z.array(OrderCodeSchema).length(4).superRefine((orders, context) => {
  const uniqueOrders = new Set(orders);
  if (
    uniqueOrders.size !== ORDER_CODES.length
    || ORDER_CODES.some((order) => !uniqueOrders.has(order))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "orders must contain ABDC, BCAD, CDBA and DACB exactly once.",
    });
  }
});

export const FixedStateSchema = z.object({
  score: z.number().int().min(0).max(100),
  label: singleLineText,
  pufferLevel: z.number().min(0).max(1),
}).strict();

export const TimingSchema = z.object({
  handling: z.number().int().positive().max(600_000),
  processing: z.number().int().positive().max(600_000),
  result: z.number().int().positive().max(600_000),
  reset: z.number().int().positive().max(600_000),
  inflateRamp: z.number().int().positive().max(600_000),
  deflateRamp: z.number().int().positive().max(600_000),
}).strict().superRefine((timing, context) => {
  if (timing.result < timing.inflateRamp) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["result"],
      message: "result must be at least as long as inflateRamp.",
    });
  }
  if (timing.reset < timing.deflateRamp) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reset"],
      message: "reset must be at least as long as deflateRamp.",
    });
  }
});

export const DeviceConfigSchema = z.object({
  mode: z.enum(["mock", "serial", "screen"]),
  serialPath: z.string().max(240).refine((value) => !/[\0\r\n]/u.test(value)),
  baudRate: z.number().int().min(1_200).max(4_000_000),
  ackTimeout: z.number().int().min(50).max(60_000),
  allowMockInProduction: z.boolean(),
}).strict().superRefine((device, context) => {
  if (device.mode === "serial" && device.serialPath.trim().length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["serialPath"],
      message: "serialPath is required in serial mode.",
    });
  }
  if (device.mode === "screen" && device.serialPath !== "") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["serialPath"],
      message: "serialPath must be empty in screen mode.",
    });
  }
});

const formUrlSchema = z.string().max(2_048).superRefine((value, context) => {
  if (value === "") {
    return;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "formUrl must use HTTPS.",
      });
    }
    const googleFormHost = parsed.hostname === "forms.gle"
      || (parsed.hostname === "docs.google.com" && parsed.pathname.startsWith("/forms/"));
    if (!googleFormHost || parsed.username !== "" || parsed.password !== "") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "formUrl must be an approved Google Forms HTTPS URL.",
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "formUrl must be empty or a valid HTTPS URL.",
    });
  }
});

const auditDateSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/u,
  "auditedOn must use YYYY-MM-DD.",
).refine((value) => {
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString().slice(0, 10) === value;
}, "auditedOn must be a valid calendar date.");

export const FormAuditSchema = z.object({
  status: z.enum(["GO", "NO-GO"]),
  protocolVersion: singleLineText,
  formUrl: formUrlSchema,
  auditedOn: auditDateSchema,
  contentSha256: z.string().regex(
    /^[a-f0-9]{64}$/u,
    "contentSha256 must be a lowercase SHA-256 digest.",
  ),
  twoPersonVerified: z.boolean(),
}).strict();

export const ExperimentConfigSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: singleLineText,
  studyTitle: singleLineText,
  bindHost: singleLineText,
  port: z.number().int().min(1_024).max(65_535),
  researchIdPattern: z.string().min(1).max(160).refine((pattern) => {
    if (/[\r\n]/u.test(pattern)) {
      return false;
    }
    try {
      void new RegExp(pattern, "u");
      return true;
    } catch {
      return false;
    }
  }, "researchIdPattern must be a valid single-line regular expression."),
  orders: ordersSchema,
  fixedState: FixedStateSchema,
  timingMs: TimingSchema,
  device: DeviceConfigSchema,
  formUrl: formUrlSchema,
  // Required by repository-owned deployment configs. Optional parsing keeps
  // synthetic development fixtures usable; production always rejects missing evidence.
  formAudit: FormAuditSchema.optional(),
  logging: z.object({
    directory: safeRelativeDirectory,
    includeAbortedInOrderBalancing: z.boolean(),
  }).strict(),
  network: z.object({
    allowLan: z.boolean(),
    allowExternalRuntimeRequests: z.boolean(),
  }).strict(),
}).strict().superRefine((config, context) => {
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!config.network.allowLan && !loopbackHosts.has(config.bindHost)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bindHost"],
      message: "bindHost must be loopback unless allowLan is enabled.",
    });
  }
  if (config.network.allowExternalRuntimeRequests) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["network", "allowExternalRuntimeRequests"],
      message: "External runtime requests are prohibited by the experiment protocol.",
    });
  }
  if (
    config.device.mode === "screen"
    && config.protocolVersion !== SCREEN_PROTOCOL_VERSION
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["protocolVersion"],
      message: `screen mode requires protocolVersion ${SCREEN_PROTOCOL_VERSION}.`,
    });
  }
  if (
    config.protocolVersion === SCREEN_PROTOCOL_VERSION
    && config.device.mode === "serial"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["device", "mode"],
      message: `${SCREEN_PROTOCOL_VERSION} requires screen or mock device mode.`,
    });
  }
});

export type FixedState = Readonly<z.infer<typeof FixedStateSchema>>;
export type TimingConfig = Readonly<z.infer<typeof TimingSchema>>;
export type DeviceConfig = Readonly<z.infer<typeof DeviceConfigSchema>>;
export type DeviceMode = DeviceConfig["mode"];
export type FormAudit = Readonly<z.infer<typeof FormAuditSchema>>;

type ParsedExperimentConfig = z.infer<typeof ExperimentConfigSchema>;

export type ExperimentConfig = Readonly<{
  [Key in keyof ParsedExperimentConfig]: ParsedExperimentConfig[Key] extends object
    ? Readonly<ParsedExperimentConfig[Key]>
    : ParsedExperimentConfig[Key];
}>;

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function parseExperimentConfig(input: unknown): ExperimentConfig {
  return deepFreeze(ExperimentConfigSchema.parse(input));
}

export function formatConfigError(error: unknown): readonly string[] {
  if (error instanceof z.ZodError) {
    return Object.freeze(error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${path}: ${issue.message}`;
    }));
  }
  return Object.freeze([error instanceof Error ? error.message : "Unknown configuration error."]);
}

export function isResearchIdValid(config: ExperimentConfig, researchId: string): boolean {
  if (researchId.length === 0 || researchId.length > 64 || /[\r\n\0]/u.test(researchId)) {
    return false;
  }
  const expression = new RegExp(config.researchIdPattern, "u");
  return expression.test(researchId);
}
