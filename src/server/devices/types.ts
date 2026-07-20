import type { PufferDeviceState } from "../../shared/experiment-machine.js";

export type DeviceCommandName = "ping" | "status" | "inflate" | "deflate" | "stop";

export interface DeviceStatus {
  readonly connected: boolean;
  readonly state: PufferDeviceState;
  readonly level: number;
  readonly fault: string | null;
  readonly updatedAt: string;
}

export interface DeviceAck {
  readonly requestId: string;
  readonly ok: boolean;
  readonly state: PufferDeviceState;
  readonly level: number;
  readonly errorCode: string | null;
}

export interface InflateInput {
  readonly level: number;
  readonly rampMs: number;
  readonly requestId: string;
}

export interface DeflateInput {
  readonly rampMs: number;
  readonly requestId: string;
}

export interface StopInput {
  readonly requestId: string;
}

export interface DeviceCommandHistoryEntry {
  readonly command: DeviceCommandName;
  readonly requestId: string;
  readonly level: number | null;
  readonly rampMs: number | null;
  readonly issuedAt: string;
}

export type DeviceStatusListener = (status: DeviceStatus) => void;

export interface PufferDevice {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<DeviceStatus>;
  getStatus(): Promise<DeviceStatus>;
  inflate(input: InflateInput): Promise<DeviceAck>;
  deflate(input: DeflateInput): Promise<DeviceAck>;
  stop(input: StopInput): Promise<DeviceAck>;
  onStatus(listener: DeviceStatusListener): () => void;
}

export class PufferDeviceError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PufferDeviceError";
  }
}

export class DeviceNotConnectedError extends PufferDeviceError {
  public constructor(message = "The puffer device is not connected.") {
    super(message, "DEVICE_DISCONNECTED");
    this.name = "DeviceNotConnectedError";
  }
}

export class DeviceTimeoutError extends PufferDeviceError {
  public constructor(command: DeviceCommandName, options?: ErrorOptions) {
    super(`Timed out waiting for ${command} acknowledgement.`, "ACK_TIMEOUT", options);
    this.name = "DeviceTimeoutError";
  }
}

export class DeviceProtocolError extends PufferDeviceError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "INVALID_DEVICE_RESPONSE", options);
    this.name = "DeviceProtocolError";
  }
}

export class DeviceFaultError extends PufferDeviceError {
  public constructor(public readonly faultCode: string) {
    super(`The puffer device reported fault ${faultCode}.`, faultCode);
    this.name = "DeviceFaultError";
  }
}

export class DeviceCommandSupersededError extends PufferDeviceError {
  public constructor(command: DeviceCommandName) {
    super(`${command} was superseded by STOP.`, "SUPERSEDED_BY_STOP");
    this.name = "DeviceCommandSupersededError";
  }
}

export class DeviceSafeStateUnconfirmedError extends PufferDeviceError {
  public constructor(message = "The puffer device did not confirm idle at level 0.", options?: ErrorOptions) {
    super(message, "DEVICE_SAFE_STATE_UNCONFIRMED", options);
    this.name = "DeviceSafeStateUnconfirmedError";
  }
}

export function assertNormalizedLevel(level: number): void {
  if (!Number.isFinite(level) || level < 0 || level > 1) {
    throw new RangeError("Puffer level must be a finite normalized value in [0, 1].");
  }
}

export function assertRampMs(rampMs: number): void {
  if (!Number.isInteger(rampMs) || rampMs < 0 || rampMs > 600_000) {
    throw new RangeError("rampMs must be an integer between 0 and 600000.");
  }
}

export function assertRequestId(requestId: string): void {
  if (requestId.length === 0 || requestId.length > 128 || /[\r\n\0]/u.test(requestId)) {
    throw new TypeError("requestId must be a non-empty single-line value of at most 128 characters.");
  }
}

export function isConfirmedDeflatedStatus(status: DeviceStatus): boolean {
  return status.connected
    && status.state === "idle"
    && status.level <= 0
    && status.fault === null;
}

export async function waitForConfirmedDeflatedStatus(
  device: Pick<PufferDevice, "getStatus">,
  options: {
    readonly timeoutMs: number;
    readonly pollIntervalMs?: number;
    readonly monotonicNow?: () => number;
    readonly delay?: (milliseconds: number) => Promise<void>;
  },
): Promise<DeviceStatus> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive integer.");
  }
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError("pollIntervalMs must be a positive integer.");
  }
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  }));
  const deadline = monotonicNow() + options.timeoutMs;
  let lastStatus: DeviceStatus | null = null;
  while (monotonicNow() <= deadline) {
    lastStatus = await device.getStatus();
    if (isConfirmedDeflatedStatus(lastStatus)) return lastStatus;
    if (lastStatus.fault !== null || lastStatus.state === "fault") {
      throw new DeviceFaultError(lastStatus.fault ?? "DEVICE_FAULT");
    }
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) break;
    await delay(Math.min(pollIntervalMs, remaining));
  }
  throw new DeviceSafeStateUnconfirmedError(
    lastStatus === null
      ? "The puffer device did not return a status while confirming deflation."
      : `The puffer device remained ${lastStatus.state} at level ${String(lastStatus.level)}.`,
  );
}

export interface SafeStopResult {
  readonly stopAcknowledged: boolean;
  readonly deflateAcknowledged: boolean;
  readonly stopError: Error | null;
  readonly deflateError: Error | null;
}

/** Always attempts STOP before DEFLATE and reports both failures to the caller. */
export async function stopAndDeflateSafely(
  device: PufferDevice,
  input: {
    readonly stopRequestId: string;
    readonly deflateRequestId: string;
    readonly deflateRampMs: number;
  },
): Promise<SafeStopResult> {
  let stopError: Error | null = null;
  let deflateError: Error | null = null;
  try {
    await device.stop({ requestId: input.stopRequestId });
  } catch (error) {
    stopError = error instanceof Error ? error : new Error("Unknown STOP failure.");
  }
  try {
    await device.deflate({ requestId: input.deflateRequestId, rampMs: input.deflateRampMs });
  } catch (error) {
    deflateError = error instanceof Error ? error : new Error("Unknown DEFLATE failure.");
  }
  return Object.freeze({
    stopAcknowledged: stopError === null,
    deflateAcknowledged: deflateError === null,
    stopError,
    deflateError,
  });
}
