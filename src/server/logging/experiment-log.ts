import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";

import { z } from "zod";

import { CONDITIONS, OrderCodeSchema } from "../../shared/index.js";
import {
  EXPERIMENT_PHASES,
  PUFFER_DEVICE_STATES,
  type Session,
} from "../../shared/experiment-machine.js";
import {
  assertExperimentLogEventFieldAllowlist,
  type ExperimentLogEventAllowedField,
} from "./log-event-allowlist.js";

const safeToken = (name: string, maxLength: number): z.ZodString => z.string()
  .min(1)
  .max(maxLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, `${name} contains forbidden characters.`);

const wallClockSchema = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && /^\d{4}-\d{2}-\d{2}T/u.test(value);
}, "wallClockIso must be an ISO 8601 timestamp.");

const experimentLogEventShape = {
  schemaVersion: z.literal(1),
  protocolVersion: safeToken("protocolVersion", 200),
  appVersion: safeToken("appVersion", 80),
  configHash: z.string().regex(/^[a-f0-9]{64}$/u, "configHash must be a SHA-256 hex digest."),
  sessionId: z.string().uuid(),
  researchId: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  orderCode: OrderCodeSchema,
  sequenceIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  conditionCode: z.enum(["A", "B", "C", "D"]).optional(),
  processing: z.enum(["cloud", "local"]).optional(),
  presentation: z.enum(["label", "puffer"]).optional(),
  phase: z.enum(EXPERIMENT_PHASES),
  eventType: safeToken("eventType", 100),
  wallClockIso: wallClockSchema,
  monotonicMs: z.number().finite().nonnegative(),
  fixedScore: z.number().int().min(0).max(100),
  pufferLevel: z.number().min(0).max(1),
  deviceMode: z.enum(["mock", "serial"]),
  deviceStatus: z.enum(PUFFER_DEVICE_STATES).optional(),
  result: z.enum(["ok", "aborted", "error"]).optional(),
  errorCode: safeToken("errorCode", 100).optional(),
} satisfies Record<ExperimentLogEventAllowedField, z.ZodType>;

export const ExperimentLogEventSchema = z.object(experimentLogEventShape).strict().superRefine((event, context) => {
  if (event.conditionCode !== undefined) {
    const expected = CONDITIONS[event.conditionCode];
    if (event.processing !== undefined && event.processing !== expected.processing) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processing"],
        message: "processing does not match conditionCode.",
      });
    }
    if (event.presentation !== undefined && event.presentation !== expected.presentation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["presentation"],
        message: "presentation does not match conditionCode.",
      });
    }
  }
});

export type ExperimentLogEvent = Readonly<z.infer<typeof ExperimentLogEventSchema>>;

export interface CreateLogEventInput {
  readonly session: Session;
  readonly appVersion: string;
  readonly eventType: string;
  readonly wallClockIso: string;
  readonly monotonicMs: number;
  readonly deviceStatus?: Session["deviceStatus"];
  readonly errorCode?: string;
}

export interface SessionLogSummary {
  readonly schemaVersion: 1;
  readonly protocolVersion: string;
  readonly appVersion: string;
  readonly configHash: string;
  readonly sessionId: string;
  readonly researchId: string;
  readonly orderCode: ExperimentLogEvent["orderCode"];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly result: "ok" | "aborted" | "error" | null;
  readonly presentationsStarted: number;
  readonly fixedScore: number;
  readonly pufferLevel: number;
  readonly deviceMode: ExperimentLogEvent["deviceMode"];
  readonly errorCode: string | null;
  readonly eventCount: number;
}

export interface ExperimentLoggerOptions {
  readonly directory: string;
}

function toErrorCode(error: unknown): string | null {
  return typeof error === "string" && error.length > 0 ? error : null;
}

export function createLogEvent(input: CreateLogEventInput): ExperimentLogEvent {
  const { session } = input;
  const condition = session.currentCondition === null ? null : CONDITIONS[session.currentCondition];
  const candidate = {
    schemaVersion: 1 as const,
    protocolVersion: session.protocolVersion,
    appVersion: input.appVersion,
    configHash: session.configHash,
    sessionId: session.id,
    researchId: session.researchId,
    orderCode: session.orderCode,
    ...(session.sequenceIndex === null ? {} : { sequenceIndex: session.sequenceIndex }),
    ...(session.currentCondition === null ? {} : { conditionCode: session.currentCondition }),
    ...(condition === null ? {} : {
      processing: condition.processing,
      presentation: condition.presentation,
    }),
    phase: session.phase,
    eventType: input.eventType,
    wallClockIso: input.wallClockIso,
    monotonicMs: input.monotonicMs,
    fixedScore: session.fixedState.score,
    pufferLevel: session.fixedState.pufferLevel,
    deviceMode: session.deviceMode,
    deviceStatus: input.deviceStatus ?? session.deviceStatus,
    ...(session.result === null ? {} : { result: session.result }),
    ...((input.errorCode ?? session.errorCode) === null || (input.errorCode ?? session.errorCode) === undefined
      ? {}
      : { errorCode: input.errorCode ?? session.errorCode ?? "UNKNOWN_ERROR" }),
  };
  return parseLogEvent(candidate);
}

export function parseLogEvent(input: unknown): ExperimentLogEvent {
  assertExperimentLogEventFieldAllowlist(input);
  return Object.freeze(ExperimentLogEventSchema.parse(input));
}

export class ExperimentLogger {
  private readonly directory: string;
  private readonly writes = new Map<string, Promise<void>>();

  public constructor(options: ExperimentLoggerOptions) {
    if (options.directory.length === 0 || /[\0\r\n]/u.test(options.directory)) {
      throw new TypeError("A logging directory is required.");
    }
    this.directory = resolve(options.directory);
    if (parse(this.directory).root === this.directory) {
      throw new Error("The filesystem root cannot be used as the logging directory.");
    }
  }

  public async append(event: ExperimentLogEvent): Promise<void> {
    const validated = parseLogEvent(event);
    const dateDirectory = validated.wallClockIso.slice(0, 10);
    const fileName = `${validated.researchId}_${validated.sessionId}.jsonl`;
    const path = resolve(this.directory, dateDirectory, fileName);
    this.assertInsideLogDirectory(path);
    const previousWrite = this.writes.get(path) ?? Promise.resolve();
    const currentWrite = previousWrite.then(async () => {
      const realLogDirectory = await this.ensureSecureLogRoot();
      await this.ensureSecureDateDirectory(dirname(path), realLogDirectory);
      const handle = await this.openSecureLogFile(path, realLogDirectory);
      try {
        await handle.writeFile(`${JSON.stringify(validated)}\n`, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.writes.set(path, currentWrite);
    try {
      await currentWrite;
    } finally {
      if (this.writes.get(path) === currentWrite) {
        this.writes.delete(path);
      }
    }
  }

  public async readSession(sessionId: string): Promise<readonly ExperimentLogEvent[]> {
    const parsedSessionId = z.string().uuid().parse(sessionId);
    const events = await this.listEvents();
    return Object.freeze(events.filter((event) => event.sessionId === parsedSessionId));
  }

  public async listEvents(): Promise<readonly ExperimentLogEvent[]> {
    await Promise.all(this.writes.values());
    const paths = await this.listLogPaths();
    const events: ExperimentLogEvent[] = [];
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      const lines = source.split(/\r?\n/u).filter((line) => line.length > 0);
      lines.forEach((line, index) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error(`Invalid JSONL at ${path}:${index + 1}.`, { cause: error });
        }
        events.push(parseLogEvent(parsed));
      });
    }
    events.sort((left, right) => {
      const byWallClock = left.wallClockIso.localeCompare(right.wallClockIso);
      return byWallClock !== 0 ? byWallClock : left.monotonicMs - right.monotonicMs;
    });
    return Object.freeze(events);
  }

  public async hasResearchId(researchId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(researchId)) {
      return false;
    }
    const events = await this.listEvents();
    return events.some((event) => event.researchId === researchId);
  }

  public async listSessionSummaries(): Promise<readonly SessionLogSummary[]> {
    const events = await this.listEvents();
    const groups = new Map<string, ExperimentLogEvent[]>();
    for (const event of events) {
      const group = groups.get(event.sessionId) ?? [];
      group.push(event);
      groups.set(event.sessionId, group);
    }

    const summaries = [...groups.values()].map((sessionEvents): SessionLogSummary => {
      const first = sessionEvents[0];
      const last = sessionEvents.at(-1);
      if (first === undefined || last === undefined) {
        throw new Error("Cannot summarize an empty event group.");
      }
      const terminalEvent = [...sessionEvents].reverse().find((event) => event.result !== undefined);
      const startedIndices = new Set(sessionEvents.flatMap((event) =>
        event.sequenceIndex === undefined ? [] : [event.sequenceIndex],
      ));
      const errorCode = [...sessionEvents].reverse()
        .map((event) => event.errorCode)
        .find((value) => value !== undefined);
      return Object.freeze({
        schemaVersion: 1,
        protocolVersion: first.protocolVersion,
        appVersion: first.appVersion,
        configHash: first.configHash,
        sessionId: first.sessionId,
        researchId: first.researchId,
        orderCode: first.orderCode,
        startedAt: first.wallClockIso,
        endedAt: last.wallClockIso,
        result: terminalEvent?.result ?? null,
        presentationsStarted: startedIndices.size,
        fixedScore: first.fixedScore,
        pufferLevel: first.pufferLevel,
        deviceMode: first.deviceMode,
        errorCode: toErrorCode(errorCode),
        eventCount: sessionEvents.length,
      });
    });
    summaries.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return Object.freeze(summaries);
  }

  public async exportCsv(): Promise<string> {
    const summaries = await this.listSessionSummaries();
    return sessionSummariesToCsv(summaries);
  }

  private async listLogPaths(): Promise<readonly string[]> {
    let realLogDirectory: string;
    try {
      realLogDirectory = await this.resolveSecureLogRoot();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze([]);
      }
      throw error;
    }
    const dateEntries = await readdir(this.directory, { withFileTypes: true });

    const paths: string[] = [];
    for (const dateEntry of dateEntries) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateEntry.name)) {
        continue;
      }
      const datePath = resolve(this.directory, dateEntry.name);
      if (dateEntry.isSymbolicLink()) {
        throw new Error("A dated logging directory must not be a symbolic link or junction.");
      }
      if (!dateEntry.isDirectory()) {
        continue;
      }
      await this.assertSecureDirectory(datePath, realLogDirectory);
      const files = await readdir(datePath, { withFileTypes: true });
      for (const file of files) {
        if (!file.name.endsWith(".jsonl")) {
          continue;
        }
        if (file.isSymbolicLink()) {
          throw new Error("A session log must not be a symbolic link or junction.");
        }
        if (!file.isFile()) {
          continue;
        }
        const path = resolve(datePath, file.name);
        this.assertInsideLogDirectory(path);
        await this.assertSecureExistingLogFile(path, realLogDirectory);
        paths.push(path);
      }
    }
    paths.sort((left, right) => left.localeCompare(right));
    return Object.freeze(paths);
  }

  private assertInsideLogDirectory(path: string): void {
    this.assertInsideDirectory(this.directory, path);
  }

  private assertInsideDirectory(directory: string, path: string): void {
    const relativePath = relative(directory, path);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("Resolved log path escaped the configured logging directory.");
    }
  }

  private async ensureSecureLogRoot(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return this.resolveSecureLogRoot();
  }

  private async resolveSecureLogRoot(): Promise<string> {
    const directoryStat = await lstat(this.directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error("The logging directory must not be a symbolic link or junction.");
    }
    return realpath(this.directory);
  }

  private async ensureSecureDateDirectory(
    datePath: string,
    realLogDirectory: string,
  ): Promise<void> {
    try {
      await mkdir(datePath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    await this.assertSecureDirectory(datePath, realLogDirectory);
  }

  private async assertSecureDirectory(path: string, realLogDirectory: string): Promise<void> {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
      throw new Error("A dated logging directory must not be a symbolic link or junction.");
    }
    const realDirectory = await realpath(path);
    this.assertInsideDirectory(realLogDirectory, realDirectory);
  }

  private async openSecureLogFile(path: string, realLogDirectory: string): Promise<FileHandle> {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY
          | constants.O_APPEND
          | constants.O_CREAT
          | constants.O_EXCL
          | noFollow,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      await this.assertSecureExistingLogFile(path, realLogDirectory);
      handle = await open(path, constants.O_WRONLY | constants.O_APPEND | noFollow, 0o600);
    }

    try {
      await this.assertOpenHandleMatchesPath(handle, path, realLogDirectory);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async assertSecureExistingLogFile(
    path: string,
    realLogDirectory: string,
  ): Promise<void> {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error("A session log must not be a symbolic link or junction.");
    }
    const realFile = await realpath(path);
    this.assertInsideDirectory(realLogDirectory, realFile);
  }

  private async assertOpenHandleMatchesPath(
    handle: FileHandle,
    path: string,
    realLogDirectory: string,
  ): Promise<void> {
    await this.assertSecureExistingLogFile(path, realLogDirectory);
    const [handleStat, pathStat] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || handleStat.dev !== pathStat.dev
      || handleStat.ino !== pathStat.ino
    ) {
      throw new Error("The session log changed while it was being opened.");
    }
  }
}

export function escapeCsvCell(value: string | number | null): string {
  if (value === null) {
    return "";
  }
  let text = String(value);
  if (/^[\t ]*[=+\-@]/u.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/u.test(text)) {
    return `"${text.replace(/"/gu, '""')}"`;
  }
  return text;
}

export function sessionSummariesToCsv(summaries: readonly SessionLogSummary[]): string {
  const columns = [
    "schemaVersion",
    "protocolVersion",
    "appVersion",
    "configHash",
    "sessionId",
    "researchId",
    "orderCode",
    "startedAt",
    "endedAt",
    "result",
    "presentationsStarted",
    "fixedScore",
    "pufferLevel",
    "deviceMode",
    "errorCode",
    "eventCount",
  ] as const;
  const lines = [columns.join(",")];
  for (const summary of summaries) {
    lines.push(columns.map((column) => escapeCsvCell(summary[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
