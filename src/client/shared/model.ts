export const EXPERIMENT_PHASES = [
  "idle",
  "setup",
  "intro",
  "handling",
  "processing",
  "result",
  "reset",
  "summary",
  "completed",
  "aborted",
  "error",
  "recovery",
] as const;

export type ExperimentPhase = ServerExperimentPhase | "recovery";
export type ProcessingLocation = SharedProcessingLocation;
export type PresentationMode = SharedPresentationMode;
export type OrderCode = SharedOrderCode;
export type ConditionCode = SharedConditionCode;
export type FixedState = SharedFixedState;

export interface PublicCondition {
  readonly processing: ProcessingLocation;
  readonly presentation: PresentationMode;
}

export interface ParticipantSnapshot {
  readonly phase: ExperimentPhase;
  readonly sequenceIndex: 0 | 1 | 2 | 3 | null;
  readonly condition: PublicCondition | null;
  readonly fixedState: FixedState;
  readonly phaseEndsAt: string | null;
  readonly serverNow: string | null;
  readonly summary: readonly PublicCondition[];
  readonly formUrl: string | null;
}

export interface DeviceStatus {
  readonly mode: "mock" | "serial" | "unknown";
  readonly state:
    | "disconnected"
    | "connecting"
    | "idle"
    | "inflating"
    | "holding"
    | "deflating"
    | "stopped"
    | "fault"
    | "unknown";
  readonly level: number | null;
  readonly fault: string | null;
  readonly connected: boolean;
}

export interface OperatorEvent {
  readonly at: string;
  readonly type: string;
  readonly detail: string;
}

export interface OperatorSnapshot extends ParticipantSnapshot {
  readonly sessionId: string;
  readonly researchId: string;
  readonly displayToken: string | null;
  readonly displayUrl: string | null;
  readonly orderCode: OrderCode;
  readonly conditionCode: ConditionCode | null;
  readonly displayConnected: boolean;
  readonly device: DeviceStatus;
  readonly protocolVersion: string;
  readonly configVersion: string;
  readonly recentEvents: readonly OperatorEvent[];
}

export interface CreatedSession {
  readonly session: OperatorSnapshot;
  readonly displayToken: string;
  readonly displayUrl: string;
}

const DEFAULT_FIXED_STATE: FixedState = {
  score: 72,
  label: "高ストレス",
  pufferLevel: 0.6,
};

export const EMPTY_DEVICE_STATUS: DeviceStatus = {
  mode: "unknown",
  state: "disconnected",
  level: null,
  fault: null,
  connected: false,
};

export const EMPTY_PARTICIPANT_SNAPSHOT: ParticipantSnapshot = {
  phase: "recovery",
  sequenceIndex: null,
  condition: null,
  fixedState: DEFAULT_FIXED_STATE,
  phaseEndsAt: null,
  serverNow: null,
  summary: [],
  formUrl: null,
};

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: JsonRecord, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function numberValue(record: JsonRecord, ...keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function booleanValue(record: JsonRecord, ...keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function nestedRecord(record: JsonRecord, key: string): JsonRecord | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function phaseValue(value: unknown): ExperimentPhase | null {
  return typeof value === "string" && (EXPERIMENT_PHASES as readonly string[]).includes(value)
    ? (value as ExperimentPhase)
    : null;
}

function sequenceIndexValue(value: unknown): 0 | 1 | 2 | 3 | null {
  return value === 0 || value === 1 || value === 2 || value === 3 ? value : null;
}

function processingValue(value: unknown): ProcessingLocation | null {
  return value === "cloud" || value === "local" ? value : null;
}

function presentationValue(value: unknown): PresentationMode | null {
  return value === "label" || value === "puffer" ? value : null;
}

function orderValue(value: unknown): OrderCode | null {
  return value === "ABDC" || value === "BCAD" || value === "CDBA" || value === "DACB"
    ? value
    : null;
}

function conditionCodeValue(value: unknown): ConditionCode | null {
  return value === "A" || value === "B" || value === "C" || value === "D" ? value : null;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function parseFixedState(record: JsonRecord): FixedState {
  const fixed = nestedRecord(record, "fixedState") ?? record;
  return {
    score: numberValue(fixed, "score", "fixedScore") ?? DEFAULT_FIXED_STATE.score,
    label: stringValue(fixed, "label", "fixedLabel") ?? DEFAULT_FIXED_STATE.label,
    pufferLevel:
      numberValue(fixed, "pufferLevel", "fixedPufferLevel") ?? DEFAULT_FIXED_STATE.pufferLevel,
  };
}

function parseCondition(value: unknown, fallback: JsonRecord): PublicCondition | null {
  const condition = isRecord(value) ? value : fallback;
  const processing = processingValue(condition["processing"]);
  const presentation = presentationValue(condition["presentation"]);
  return processing !== null && presentation !== null ? { processing, presentation } : null;
}

function parseSummary(value: unknown): readonly PublicCondition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const parsed = parseCondition(item, item);
    return parsed === null ? [] : [parsed];
  }).slice(0, 4);
}

export function parseParticipantSnapshot(value: unknown): ParticipantSnapshot | null {
  if (!isRecord(value)) return null;
  const parsedPhase = phaseValue(value["phase"]);
  if (parsedPhase === null) return null;
  const shouldRecover = value["recoveryRequired"] === true
    && parsedPhase !== "completed"
    && parsedPhase !== "aborted"
    && parsedPhase !== "error";
  const phase: ExperimentPhase = shouldRecover ? "recovery" : parsedPhase;
  const current = value["condition"] ?? value["current"];
  const currentRecord = isRecord(current) ? current : null;
  const explicitSequenceIndex = sequenceIndexValue(value["sequenceIndex"]);
  const currentPosition = currentRecord === null ? null : numberValue(currentRecord, "position");
  const sequenceIndex = explicitSequenceIndex ?? (
    currentPosition === 1 || currentPosition === 2 || currentPosition === 3 || currentPosition === 4
      ? (currentPosition - 1) as 0 | 1 | 2 | 3
      : null
  );

  return {
    phase,
    sequenceIndex,
    condition: parseCondition(current, value),
    fixedState: parseFixedState(value),
    phaseEndsAt: stringValue(value, "phaseEndsAt", "phaseEndAt", "deadlineIso"),
    serverNow: stringValue(value, "serverNow", "serverNowIso"),
    summary: parseSummary(value["summary"] ?? value["presentations"]),
    formUrl: safeHttpsUrl(value["formUrl"]),
  };
}

export function parseDeviceStatus(value: unknown): DeviceStatus | null {
  if (!isRecord(value)) return null;
  const stateRaw = stringValue(value, "state", "deviceState") ?? "unknown";
  const allowedStates: readonly DeviceStatus["state"][] = [
    "disconnected",
    "connecting",
    "idle",
    "inflating",
    "holding",
    "deflating",
    "stopped",
    "fault",
    "unknown",
  ];
  const state = (allowedStates as readonly string[]).includes(stateRaw)
    ? (stateRaw as DeviceStatus["state"])
    : "unknown";
  const modeRaw = stringValue(value, "mode");
  const mode: DeviceStatus["mode"] = modeRaw === "mock" || modeRaw === "serial" ? modeRaw : "unknown";
  return {
    mode,
    state,
    level: numberValue(value, "level"),
    fault: stringValue(value, "fault", "errorCode"),
    connected: booleanValue(value, "connected") ?? !["disconnected", "unknown"].includes(state),
  };
}

function parseEvents(value: unknown): readonly OperatorEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const type = stringValue(item, "type", "eventType");
    if (type === null) return [];
    return [{
      at: stringValue(item, "at", "wallClockIso") ?? "",
      type,
      detail: stringValue(item, "detail", "deviceStatus", "errorCode") ?? "",
    }];
  }).slice(-20);
}

export function parseOperatorSnapshot(value: unknown): OperatorSnapshot | null {
  if (!isRecord(value)) return null;
  const publicSnapshot = parseParticipantSnapshot(value);
  const sessionId = stringValue(value, "sessionId", "id");
  const researchId = stringValue(value, "researchId");
  const orderCode = orderValue(value["orderCode"]);
  if (publicSnapshot === null || sessionId === null || researchId === null || orderCode === null) return null;

  const conditionCode = conditionCodeValue(value["conditionCode"] ?? value["currentCondition"]);
  const derivedCondition = conditionCode === null ? publicSnapshot.condition : CONDITIONS[conditionCode];
  const deviceValue = isRecord(value["device"])
    ? value["device"]
    : {
        mode: value["deviceMode"],
        state: value["deviceStatus"],
        level: value["deviceLevel"],
      };
  return {
    ...publicSnapshot,
    condition: derivedCondition,
    sessionId,
    researchId,
    displayToken: stringValue(value, "displayToken"),
    displayUrl: stringValue(value, "displayUrl"),
    orderCode,
    conditionCode,
    displayConnected: booleanValue(value, "displayConnected", "participantConnected") ?? false,
    device: parseDeviceStatus(deviceValue) ?? EMPTY_DEVICE_STATUS,
    protocolVersion: stringValue(value, "protocolVersion") ?? "—",
    configVersion: stringValue(value, "configVersion", "configHash") ?? "—",
    recentEvents: parseEvents(value["recentEvents"] ?? value["events"]),
  };
}

export function parseCreatedSession(value: unknown): CreatedSession | null {
  if (!isRecord(value)) return null;
  const session = parseOperatorSnapshot(value["snapshot"] ?? value["session"]);
  const displayToken = stringValue(value, "displayToken") ?? session?.displayToken ?? null;
  const displayUrl = stringValue(value, "displayUrl") ?? session?.displayUrl ?? null;
  return session !== null && displayToken !== null && displayUrl !== null
    ? { session: { ...session, displayToken, displayUrl }, displayToken, displayUrl }
    : null;
}

export function payloadFromSocketMessage(value: unknown): { readonly type: string; readonly payload: unknown } | null {
  if (!isRecord(value)) return null;
  const type = stringValue(value, "type");
  return type === null ? null : { type, payload: value["payload"] };
}
import {
  CONDITIONS,
  type ConditionCode as SharedConditionCode,
  type ExperimentPhase as ServerExperimentPhase,
  type FixedState as SharedFixedState,
  type OrderCode as SharedOrderCode,
  type PresentationMode as SharedPresentationMode,
  type ProcessingLocation as SharedProcessingLocation,
} from "../../shared/index.js";
