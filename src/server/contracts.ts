import type {
  ExperimentConfig,
  PublicSnapshot,
  Session,
  PresentationMode,
  ProcessingLocation,
} from "../shared/index.js";
import type { DeviceAck, DeviceStatus, PufferDevice } from "./devices/index.js";
import type {
  ExperimentLogEvent,
  ResearchIdReservationInput,
  SessionLogSummary,
} from "./logging/index.js";

export type { DeviceAck, DeviceStatus, PufferDevice };

export type ServerExperimentConfig = ExperimentConfig;
export type RuntimeSession = Session;

export interface PublicCondition {
  readonly position: 1 | 2 | 3 | 4;
  readonly processing: ProcessingLocation;
  readonly presentation: PresentationMode;
}

export interface PublicSessionSnapshot extends PublicSnapshot {
  readonly sequenceIndex: 0 | 1 | 2 | 3 | null;
}

export interface OperatorSessionSnapshot extends RuntimeSession {
  readonly rehearsal: boolean;
  readonly serverNow: string;
  readonly pufferSurface: PublicSnapshot["pufferSurface"];
  readonly pufferRamp: PublicSnapshot["pufferRamp"];
  readonly displayToken: string;
  readonly displayUrl: string;
  readonly current: PublicCondition | null;
  readonly summary: readonly PublicCondition[];
  readonly recentEvents: readonly OperatorRecentEvent[];
  readonly displayFullscreen: boolean | null;
}

/**
 * Transient Operator acknowledgement for the current browser/server run.
 * It deliberately carries no person, document, evidence, signature, or time.
 */
export interface OperatorSessionConfirmationChecks {
  readonly todayProcedureConfirmed: boolean;
  readonly participantConsentConfirmed: boolean;
  readonly stopOperationConfirmed: boolean;
  readonly physicalDeviceSafetyConfirmed: boolean;
}

export interface OperatorSessionConfirmationInput {
  readonly todayProcedureConfirmed: true;
  readonly participantConsentConfirmed: true;
  readonly stopOperationConfirmed: true;
  readonly physicalDeviceSafetyConfirmed: true;
}

export interface OperatorSessionConfirmationStatus {
  readonly confirmed: boolean;
  readonly checks: OperatorSessionConfirmationChecks;
  readonly technicalReadiness: "GO" | "NO-GO";
  readonly participantMode: "enabled" | "disabled";
  readonly complianceMode: "external";
  readonly approvalEvidence: "managed-outside-system";
  readonly approvalVerifiedByApplication: false;
}

export interface OperatorRecentEvent {
  readonly wallClockIso: string;
  readonly eventType: string;
  readonly deviceStatus: string;
  readonly errorCode?: string;
}

export interface SessionLogWriter {
  append(event: ExperimentLogEvent): Promise<void>;
  exportCsv(): Promise<string>;
  hasResearchId(researchId: string): Promise<boolean>;
  reserveResearchId(input: ResearchIdReservationInput): Promise<boolean>;
  listSessionSummaries(): Promise<readonly SessionLogSummary[]>;
}

export interface ServerEvent {
  readonly type:
    | "session.snapshot"
    | "session.phaseChanged"
    | "session.completed"
    | "session.aborted"
    | "session.error"
    | "device.status";
  readonly sessionId?: string;
  readonly deviceStatus?: DeviceStatus;
}
