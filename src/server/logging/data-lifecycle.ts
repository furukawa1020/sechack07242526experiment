import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, parse, relative, resolve } from "node:path";

import { z } from "zod";

import { parseLogEvent } from "./experiment-log.js";

const MAX_SESSION_LOG_BYTES = 64 * 1024 * 1024;
const FORMAL_RESEARCH_ID_PATTERN = /^SH26-[0-9]{3}$/u;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const GOOGLE_FORM_MANUAL_ACTION_NOTICE =
  "Googleフォーム側に同じ研究用IDの回答がある場合、このツールでは取得・変更できません。承認済み手順に従い、フォーム管理者が同じ研究用IDを手動照合してください。";

export const FORMAL_MUTATION_DISABLED_MESSAGE =
  "このアプリによる研究データの除外・削除は安全上無効です。研究責任者が事前承認した外部手順で実施してください。";

export const ResearchIdSchema = z.string()
  .regex(FORMAL_RESEARCH_ID_PATTERN, "researchId must exactly match SH26-[0-9]{3}.");

export type ResearchId = z.infer<typeof ResearchIdSchema>;
export type LifecycleAction = "exclude" | "delete";

export interface LifecycleTarget {
  readonly relativePath: string;
  readonly sessionId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly lastModifiedIso: string;
}

export interface LifecyclePlan {
  readonly schemaVersion: 1;
  readonly planType: "research-data-lifecycle";
  readonly action: LifecycleAction;
  readonly researchId: ResearchId;
  readonly dataRoot: "data/sessions";
  readonly generatedAt: string;
  readonly planId: string;
  readonly targetCount: number;
  readonly totalBytes: number;
  readonly targets: readonly LifecycleTarget[];
  readonly mutationSupported: false;
  readonly googleFormManualActionRequired: true;
  readonly googleFormNotice: string;
}

export interface RetentionEntry extends LifecycleTarget {
  readonly researchId: ResearchId;
  readonly collectedOn: string;
  readonly expiresOn: string;
  readonly status: "retain" | "retention-expired";
}

export interface RetentionReport {
  readonly schemaVersion: 1;
  readonly reportType: "research-data-retention";
  readonly dataRoot: "data/sessions";
  readonly generatedAt: string;
  readonly asOf: string;
  readonly retentionDays: number;
  readonly fileCount: number;
  readonly expiredCount: number;
  readonly entries: readonly RetentionEntry[];
  readonly mutationSupported: false;
  readonly googleFormManualActionRequired: true;
  readonly googleFormNotice: string;
}

export interface LifecycleOptions {
  readonly repositoryRoot: string;
  readonly now?: Date;
}

export interface DeleteResearchDataOptions extends LifecycleOptions {
  readonly researchId: string;
  readonly confirmPlanId: string;
  readonly confirmDeletePhrase: string;
}

export interface ExcludeResearchDataOptions extends LifecycleOptions {
  readonly researchId: string;
  readonly confirmPlanId: string;
}

export interface CreateRetentionReportOptions extends LifecycleOptions {
  readonly retentionDays: number;
  readonly asOf?: string;
}

interface SessionsContext {
  readonly sessionsRoot: string;
  readonly realSessionsRoot: string | null;
}

interface InspectedTarget extends LifecycleTarget {
  readonly researchId: ResearchId;
  readonly collectedOn: string;
}

function assertInside(directory: string, path: string, message: string): void {
  const relativePath = relative(directory, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(message);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function resolveSessionsContext(repositoryRootInput: string): Promise<SessionsContext> {
  if (repositoryRootInput.length === 0 || /[\0\r\n]/u.test(repositoryRootInput)) {
    throw new TypeError("repositoryRoot is required.");
  }
  const repositoryRoot = resolve(repositoryRootInput);
  if (parse(repositoryRoot).root === repositoryRoot) {
    throw new Error("The filesystem root cannot be used as repositoryRoot.");
  }
  const rootStat = await lstat(repositoryRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("repositoryRoot must be a real directory.");
  }
  const realRepositoryRoot = await realpath(repositoryRoot);
  const dataRoot = resolve(repositoryRoot, "data");
  const sessionsRoot = resolve(dataRoot, "sessions");
  if (!(await pathExists(sessionsRoot))) {
    if (await pathExists(dataRoot)) {
      const dataStat = await lstat(dataRoot);
      if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
        throw new Error("data must be a real directory.");
      }
      const realDataRoot = await realpath(dataRoot);
      assertInside(realRepositoryRoot, realDataRoot, "data escaped repositoryRoot.");
    }
    return Object.freeze({ sessionsRoot, realSessionsRoot: null });
  }
  const sessionsStat = await lstat(sessionsRoot);
  if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
    throw new Error("data/sessions must be a real directory.");
  }
  const realSessionsRoot = await realpath(sessionsRoot);
  assertInside(realRepositoryRoot, realSessionsRoot, "data/sessions escaped repositoryRoot.");
  return Object.freeze({ sessionsRoot, realSessionsRoot });
}

function validIsoDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsedDate = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsedDate.valueOf()) && parsedDate.toISOString().slice(0, 10) === value;
}

function parseFileName(fileName: string): { researchId: ResearchId; sessionId: string } | null {
  const match = /^(SH26-[0-9]{3})_([0-9a-f-]{36})\.jsonl$/u.exec(fileName);
  if (match === null) return null;
  const researchId = match[1];
  const sessionId = match[2];
  if (researchId === undefined || sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  return Object.freeze({ researchId: ResearchIdSchema.parse(researchId), sessionId });
}

function statsEqual(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function assertOpenFile(
  handle: FileHandle,
  path: string,
  realSessionsRoot: string,
): Promise<Stats> {
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1) {
    throw new Error("A session log must be a single-link regular file.");
  }
  if (pathStat.size > MAX_SESSION_LOG_BYTES) {
    throw new Error("A session log exceeds the read-only inspection size limit.");
  }
  const realFile = await realpath(path);
  assertInside(realSessionsRoot, realFile, "A session log escaped data/sessions.");
  const handleStat = await handle.stat();
  if (!statsEqual(handleStat, pathStat)) {
    throw new Error("A session log changed while it was being opened.");
  }
  return handleStat;
}

async function inspectLog(
  path: string,
  relativePath: string,
  realSessionsRoot: string,
  researchId: ResearchId,
  sessionId: string,
  date: string,
): Promise<InspectedTarget> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await assertOpenFile(handle, path, realSessionsRoot);
    const bytes = await handle.readFile();
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (!statsEqual(before, afterHandle) || !statsEqual(afterHandle, afterPath)) {
      throw new Error("A session log changed while it was being inspected.");
    }
    const source = bytes.toString("utf8");
    const lines = source.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length === 0) throw new Error("A session log must not be empty.");
    for (const [index, line] of lines.entries()) {
      let candidate: unknown;
      try {
        candidate = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`Invalid JSONL at ${relativePath}:${String(index + 1)}.`, { cause: error });
      }
      const event = parseLogEvent(candidate);
      if (event.researchId !== researchId || event.sessionId !== sessionId) {
        throw new Error("A session log event does not match its canonical filename.");
      }
    }
    return Object.freeze({
      relativePath,
      sessionId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: afterHandle.size,
      lastModifiedIso: afterHandle.mtime.toISOString(),
      researchId,
      collectedOn: date,
    });
  } finally {
    await handle.close();
  }
}

async function discoverTargets(context: SessionsContext): Promise<readonly InspectedTarget[]> {
  if (context.realSessionsRoot === null) return Object.freeze([]);
  const targets: InspectedTarget[] = [];
  const dateEntries = await readdir(context.sessionsRoot, { withFileTypes: true });
  for (const dateEntry of dateEntries) {
    if (!validIsoDate(dateEntry.name)) continue;
    if (dateEntry.isSymbolicLink() || !dateEntry.isDirectory()) {
      throw new Error("A dated session directory must be a real directory.");
    }
    const datePath = resolve(context.sessionsRoot, dateEntry.name);
    const realDatePath = await realpath(datePath);
    assertInside(context.realSessionsRoot, realDatePath, "A dated session directory escaped data/sessions.");
    const fileEntries = await readdir(datePath, { withFileTypes: true });
    for (const fileEntry of fileEntries) {
      if (!fileEntry.name.endsWith(".jsonl")) continue;
      if (fileEntry.isSymbolicLink() || !fileEntry.isFile()) {
        throw new Error("A session log must be a real file.");
      }
      const parsedName = parseFileName(fileEntry.name);
      if (parsedName === null) {
        throw new Error("A JSONL filename in data/sessions is not canonical.");
      }
      const path = resolve(datePath, fileEntry.name);
      const relativePath = `${dateEntry.name}/${fileEntry.name}`;
      targets.push(await inspectLog(
        path,
        relativePath,
        context.realSessionsRoot,
        parsedName.researchId,
        parsedName.sessionId,
        dateEntry.name,
      ));
    }
  }
  targets.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return Object.freeze(targets);
}

function isoNow(now: Date | undefined): string {
  const value = now ?? new Date();
  if (!Number.isFinite(value.valueOf())) throw new TypeError("now must be a valid date.");
  return value.toISOString();
}

function publicTarget(target: InspectedTarget): LifecycleTarget {
  return Object.freeze({
    relativePath: target.relativePath,
    sessionId: target.sessionId,
    sha256: target.sha256,
    sizeBytes: target.sizeBytes,
    lastModifiedIso: target.lastModifiedIso,
  });
}

function calculatePlanId(
  action: LifecycleAction,
  researchId: ResearchId,
  targets: readonly LifecycleTarget[],
): string {
  return createHash("sha256").update(JSON.stringify({ action, researchId, targets })).digest("hex");
}

export async function createLifecyclePlan(options: LifecycleOptions & {
  readonly action: LifecycleAction;
  readonly researchId: string;
}): Promise<LifecyclePlan> {
  const researchId = ResearchIdSchema.parse(options.researchId);
  if (options.action !== "exclude" && options.action !== "delete") {
    throw new TypeError("action must be exclude or delete.");
  }
  const context = await resolveSessionsContext(options.repositoryRoot);
  const targets = Object.freeze((await discoverTargets(context))
    .filter((target) => target.researchId === researchId)
    .map(publicTarget));
  return Object.freeze({
    schemaVersion: 1,
    planType: "research-data-lifecycle",
    action: options.action,
    researchId,
    dataRoot: "data/sessions",
    generatedAt: isoNow(options.now),
    planId: calculatePlanId(options.action, researchId, targets),
    targetCount: targets.length,
    totalBytes: targets.reduce((total, target) => total + target.sizeBytes, 0),
    targets,
    mutationSupported: false,
    googleFormManualActionRequired: true,
    googleFormNotice: GOOGLE_FORM_MANUAL_ACTION_NOTICE,
  });
}

export async function excludeResearchData(
  options: ExcludeResearchDataOptions,
): Promise<never> {
  void options;
  throw new Error(FORMAL_MUTATION_DISABLED_MESSAGE);
}

export async function deleteResearchData(
  options: DeleteResearchDataOptions,
): Promise<never> {
  void options;
  throw new Error(FORMAL_MUTATION_DISABLED_MESSAGE);
}

function parseIsoDate(value: string, name: string): string {
  if (!validIsoDate(value)) throw new TypeError(`${name} must be YYYY-MM-DD.`);
  return value;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function createRetentionReport(
  options: CreateRetentionReportOptions,
): Promise<RetentionReport> {
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1 || options.retentionDays > 3650) {
    throw new TypeError("retentionDays must be an integer between 1 and 3650.");
  }
  const generatedAt = isoNow(options.now);
  const asOf = parseIsoDate(options.asOf ?? generatedAt.slice(0, 10), "asOf");
  const targets = await discoverTargets(await resolveSessionsContext(options.repositoryRoot));
  const entries = Object.freeze(targets.map((target): RetentionEntry => {
    const expiresOn = addUtcDays(target.collectedOn, options.retentionDays);
    return Object.freeze({
      ...publicTarget(target),
      researchId: target.researchId,
      collectedOn: target.collectedOn,
      expiresOn,
      status: expiresOn <= asOf ? "retention-expired" : "retain",
    });
  }));
  return Object.freeze({
    schemaVersion: 1,
    reportType: "research-data-retention",
    dataRoot: "data/sessions",
    generatedAt,
    asOf,
    retentionDays: options.retentionDays,
    fileCount: entries.length,
    expiredCount: entries.filter((entry) => entry.status === "retention-expired").length,
    entries,
    mutationSupported: false,
    googleFormManualActionRequired: true,
    googleFormNotice: GOOGLE_FORM_MANUAL_ACTION_NOTICE,
  });
}
