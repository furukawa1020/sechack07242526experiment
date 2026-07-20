import { z } from "zod";

import { ORDER_CODES } from "./conditions.js";

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
  mode: z.enum(["mock", "serial"]),
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
});

export type FixedState = Readonly<z.infer<typeof FixedStateSchema>>;
export type TimingConfig = Readonly<z.infer<typeof TimingSchema>>;
export type DeviceConfig = Readonly<z.infer<typeof DeviceConfigSchema>>;
export type DeviceMode = DeviceConfig["mode"];

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
