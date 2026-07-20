import {
  parseCreatedSession,
  parseDeviceAck,
  parseDeviceStatus,
  parseOperatorSnapshot,
  parseParticipantSnapshot,
  type CreatedSession,
  type DeviceActionResult,
  type DeviceStatus,
  type OperatorSnapshot,
  type OrderCode,
  type ParticipantSnapshot,
} from "./model.js";

export class ApiError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const OPERATOR_TOKEN_KEY = "sechack.operator-token";

function validOperatorToken(value: string | null): value is string {
  return value !== null
    && value.length >= 16
    && value.length <= 512
    && !/[\r\n\0]/u.test(value);
}

export function captureOperatorTokenFromLocation(): void {
  const queryToken = new URLSearchParams(window.location.search).get("operatorToken");
  if (validOperatorToken(queryToken)) {
    window.sessionStorage.setItem(OPERATOR_TOKEN_KEY, queryToken);
    const sanitized = new URL(window.location.href);
    sanitized.searchParams.delete("operatorToken");
    window.history.replaceState(
      window.history.state,
      "",
      `${sanitized.pathname}${sanitized.search}${sanitized.hash}`,
    );
  }
}

export function getOperatorToken(): string | null {
  const stored = window.sessionStorage.getItem(OPERATOR_TOKEN_KEY);
  return validOperatorToken(stored) ? stored : null;
}

function needsOperatorAuthorization(path: string): boolean {
  return path.startsWith("/api/sessions")
    || path.startsWith("/api/device")
    || path.startsWith("/api/exports")
    || path.startsWith("/api/operator");
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const value: unknown = await response.clone().json();
    if (typeof value === "object" && value !== null) {
      const record = value as Readonly<Record<string, unknown>>;
      const message = record["message"] ?? record["error"];
      if (typeof message === "string") return message;
    }
  } catch {
    // The generic status message below is intentionally used for non-JSON errors.
  }
  return `リクエストに失敗しました（HTTP ${response.status}）`;
}

async function requestJson(path: `/${string}`, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const operatorToken = needsOperatorAuthorization(path) ? getOperatorToken() : null;
  if (operatorToken !== null) headers.set("X-Operator-Token", operatorToken);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    redirect: "error",
  });
  if (!response.ok) throw new ApiError(await responseMessage(response), response.status);
  if (response.status === 204) return null;
  return response.json() as Promise<unknown>;
}

async function requestBlob(path: `/${string}`): Promise<Blob> {
  const headers = new Headers({ Accept: "text/csv" });
  const operatorToken = getOperatorToken();
  if (operatorToken !== null) headers.set("X-Operator-Token", operatorToken);
  const response = await fetch(path, {
    headers,
    credentials: "same-origin",
    redirect: "error",
  });
  if (!response.ok) throw new ApiError(await responseMessage(response), response.status);
  return response.blob();
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function invalidResponse(): ApiError {
  return new ApiError("サーバーから不正な応答を受信しました。", 502);
}

export interface CreateSessionInput {
  readonly researchId: string;
  readonly consentConfirmed: true;
  readonly orderCode: OrderCode | "auto";
}

export const experimentApi = {
  async getOperatorConfig(): Promise<{ readonly researchIdPattern: string; readonly protocolVersion: string }> {
    const raw = await requestJson("/api/operator/config");
    if (typeof raw !== "object" || raw === null) throw invalidResponse();
    const record = raw as Readonly<Record<string, unknown>>;
    const researchIdPattern = record["researchIdPattern"];
    const protocolVersion = record["protocolVersion"];
    if (typeof researchIdPattern !== "string" || typeof protocolVersion !== "string") throw invalidResponse();
    try {
      void new RegExp(researchIdPattern, "u");
    } catch {
      throw invalidResponse();
    }
    return { researchIdPattern, protocolVersion };
  },

  async createSession(input: CreateSessionInput): Promise<CreatedSession> {
    const raw = await requestJson("/api/sessions", { method: "POST", body: JSON.stringify(input) });
    const parsed = parseCreatedSession(raw);
    if (parsed === null) throw invalidResponse();
    return parsed;
  },

  async getSession(sessionId: string): Promise<OperatorSnapshot> {
    const raw = await requestJson(`/api/sessions/${encoded(sessionId)}`);
    const record = typeof raw === "object" && raw !== null ? raw as Readonly<Record<string, unknown>> : null;
    const parsed = parseOperatorSnapshot(record?.["snapshot"] ?? record?.["session"] ?? raw);
    if (parsed === null) throw invalidResponse();
    return parsed;
  },

  async getDisplay(displayToken: string): Promise<ParticipantSnapshot> {
    const raw = await requestJson(`/api/display/${encoded(displayToken)}`);
    const record = typeof raw === "object" && raw !== null ? raw as Readonly<Record<string, unknown>> : null;
    const parsed = parseParticipantSnapshot(record?.["snapshot"] ?? raw);
    if (parsed === null) throw invalidResponse();
    return parsed;
  },

  async sessionAction(
    sessionId: string,
    action: "prepare" | "start" | "resume" | "abort" | "emergency-stop" | "confirm-form-complete",
  ): Promise<OperatorSnapshot | null> {
    const raw = await requestJson(`/api/sessions/${encoded(sessionId)}/${action}`, { method: "POST" });
    if (raw === null) return null;
    const record = typeof raw === "object" && raw !== null ? raw as Readonly<Record<string, unknown>> : null;
    return parseOperatorSnapshot(record?.["snapshot"] ?? record?.["session"] ?? raw);
  },

  async deleteSession(sessionId: string): Promise<void> {
    await requestJson(`/api/sessions/${encoded(sessionId)}`, { method: "DELETE" });
  },

  async deviceAction(
    action: "connect" | "disconnect" | "ping" | "status" | "inflate" | "deflate" | "stop",
  ): Promise<DeviceActionResult> {
    const raw = await requestJson(`/api/device/${action}`, { method: "POST" });
    const record = typeof raw === "object" && raw !== null ? raw as Readonly<Record<string, unknown>> : null;
    const parsed = parseDeviceStatus(record?.["status"] ?? record?.["device"] ?? raw);
    if (parsed === null) throw invalidResponse();
    const ackValue = record?.["ack"];
    const ack = ackValue === null || ackValue === undefined ? null : parseDeviceAck(ackValue);
    if (ackValue !== null && ackValue !== undefined && ack === null) throw invalidResponse();
    return { status: parsed, ack };
  },

  async getDeviceStatus(): Promise<DeviceStatus> {
    const raw = await requestJson("/api/device/status");
    const record = typeof raw === "object" && raw !== null ? raw as Readonly<Record<string, unknown>> : null;
    const parsed = parseDeviceStatus(record?.["status"] ?? record?.["device"] ?? raw);
    if (parsed === null) throw invalidResponse();
    return parsed;
  },

  async exportSessionsCsv(): Promise<Blob> {
    return requestBlob("/api/exports/sessions.csv");
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "予期しないエラーが発生しました。";
}
