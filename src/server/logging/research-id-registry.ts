import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve } from "node:path";

import { z } from "zod";

const RESEARCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const WALL_CLOCK_PATTERN = /^\d{4}-\d{2}-\d{2}T/u;
const ANCHOR_CONTENT = `${JSON.stringify({
  schemaVersion: 1,
  recordType: "research-id-registry-initialized",
})}\n`;

const ResearchIdReservationSchema = z.object({
  schemaVersion: z.literal(1),
  recordType: z.literal("research-id-reservation"),
  researchId: z.string().regex(RESEARCH_ID_PATTERN),
  sessionId: z.string().uuid(),
  reservedAt: z.string().refine((value) => (
    WALL_CLOCK_PATTERN.test(value) && Number.isFinite(Date.parse(value))
  ), "reservedAt must be an ISO 8601 timestamp."),
}).strict();

export interface ResearchIdReservationInput {
  readonly researchId: string;
  readonly sessionId: string;
  readonly reservedAt: string;
}

type ResearchIdReservation = Readonly<z.infer<typeof ResearchIdReservationSchema>>;

interface RegistryContext {
  readonly logDirectory: string;
  readonly parentDirectory: string;
  readonly registryDirectory: string;
  readonly anchorPath: string;
}

function assertInside(directory: string, path: string): void {
  const relativePath = relative(directory, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("The research ID registry path escaped its configured directory.");
  }
}

function registryContextFor(logDirectory: string): RegistryContext {
  const resolvedLogDirectory = resolve(logDirectory);
  if (parse(resolvedLogDirectory).root === resolvedLogDirectory) {
    throw new Error("The filesystem root cannot be used as the logging directory.");
  }
  const parentDirectory = dirname(resolvedLogDirectory);
  const logDirectoryName = basename(resolvedLogDirectory);
  const registryName = logDirectoryName === "sessions"
    ? "research-id-registry"
    : `.${logDirectoryName}.research-id-registry`;
  const anchorName = logDirectoryName === "sessions"
    ? ".research-id-registry-initialized.json"
    : `.${logDirectoryName}.research-id-registry-initialized.json`;
  const registryDirectory = resolve(parentDirectory, registryName);
  const anchorPath = resolve(parentDirectory, anchorName);
  assertInside(parentDirectory, registryDirectory);
  assertInside(parentDirectory, anchorPath);
  return Object.freeze({
    logDirectory: resolvedLogDirectory,
    parentDirectory,
    registryDirectory,
    anchorPath,
  });
}

async function secureParent(context: RegistryContext, create: boolean): Promise<string> {
  if (create) {
    await mkdir(context.parentDirectory, { recursive: true, mode: 0o700 });
  }
  const parentStat = await lstat(context.parentDirectory);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("The logging parent directory must be a real directory.");
  }
  const realParent = await realpath(context.parentDirectory);
  if (await pathExists(context.logDirectory)) {
    const logStat = await lstat(context.logDirectory);
    if (logStat.isSymbolicLink() || !logStat.isDirectory()) {
      throw new Error("The logging directory must be a real directory.");
    }
    const realLogDirectory = await realpath(context.logDirectory);
    if (dirname(realLogDirectory) !== realParent) {
      throw new Error("The logging directory escaped its real parent directory.");
    }
  }
  return realParent;
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

async function assertRegistryDirectory(
  context: RegistryContext,
  realParent: string,
): Promise<string> {
  const stat = await lstat(context.registryDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("The research ID registry must be a real directory.");
  }
  const realRegistryDirectory = await realpath(context.registryDirectory);
  if (
    dirname(realRegistryDirectory) !== realParent
    || basename(realRegistryDirectory) !== basename(context.registryDirectory)
  ) {
    throw new Error("The research ID registry escaped the real logging parent directory.");
  }
  return realRegistryDirectory;
}

function statsEqual(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

async function assertHandleMatchesPath(
  handle: FileHandle,
  path: string,
  realParent: string,
): Promise<Stats> {
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1) {
    throw new Error("A research ID registry record must be a single-link regular file.");
  }
  const realFile = await realpath(path);
  if (dirname(realFile) !== realParent) {
    throw new Error("A research ID registry record escaped its real parent directory.");
  }
  const handleStat = await handle.stat();
  if (
    handleStat.nlink !== 1
    || handleStat.dev !== pathStat.dev
    || handleStat.ino !== pathStat.ino
  ) {
    throw new Error("A research ID registry record changed while it was being opened.");
  }
  return handleStat;
}

async function readStableFile(
  path: string,
  realParent: string,
  expectedContent?: string,
): Promise<string> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await assertHandleMatchesPath(handle, path, realParent);
    const source = await handle.readFile("utf8");
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (!statsEqual(before, afterHandle) || !statsEqual(afterHandle, afterPath)) {
      throw new Error("A research ID registry record changed while it was being read.");
    }
    if (expectedContent !== undefined && source !== expectedContent) {
      throw new Error("The research ID registry initialization anchor is invalid.");
    }
    return source;
  } finally {
    await handle.close();
  }
}

async function writeExclusiveStableFile(
  path: string,
  realParent: string,
  source: string,
): Promise<boolean> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await assertHandleMatchesPath(handle, path, realParent);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !statsEqual(afterHandle, afterPath)
      || afterHandle.size !== Buffer.byteLength(source)
    ) {
      throw new Error("A research ID registry record changed while it was being persisted.");
    }
    return true;
  } finally {
    await handle.close();
  }
}

async function resolveInitializedRegistry(
  context: RegistryContext,
): Promise<{ readonly realParent: string; readonly realRegistryDirectory: string } | null> {
  let realParent: string;
  try {
    realParent = await secureParent(context, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const [anchorExists, registryExists] = await Promise.all([
    pathExists(context.anchorPath),
    pathExists(context.registryDirectory),
  ]);
  if (!anchorExists && !registryExists) return null;
  if (anchorExists !== registryExists) {
    throw new Error(
      "The research ID registry is incomplete or was removed after initialization; ID allocation is blocked.",
    );
  }
  await readStableFile(context.anchorPath, realParent, ANCHOR_CONTENT);
  const realRegistryDirectory = await assertRegistryDirectory(context, realParent);
  return Object.freeze({ realParent, realRegistryDirectory });
}

async function ensureInitializedRegistry(
  context: RegistryContext,
): Promise<{ readonly realParent: string; readonly realRegistryDirectory: string }> {
  const existing = await resolveInitializedRegistry(context);
  if (existing !== null) return existing;
  const realParent = await secureParent(context, true);
  const anchorCreated = await writeExclusiveStableFile(
    context.anchorPath,
    realParent,
    ANCHOR_CONTENT,
  );
  if (!anchorCreated) {
    throw new Error("Concurrent research ID registry initialization was detected; retry after inspection.");
  }
  try {
    await mkdir(context.registryDirectory, { mode: 0o700 });
  } catch (error) {
    throw new Error(
      "Research ID registry initialization is incomplete; ID allocation is blocked pending inspection.",
      { cause: error },
    );
  }
  return Object.freeze({
    realParent,
    realRegistryDirectory: await assertRegistryDirectory(context, realParent),
  });
}

function reservationPath(registryDirectory: string, researchId: string): string {
  const parsedResearchId = z.string().regex(RESEARCH_ID_PATTERN).parse(researchId);
  const path = resolve(registryDirectory, `${parsedResearchId}.json`);
  assertInside(registryDirectory, path);
  return path;
}

async function readReservation(
  context: RegistryContext,
  researchId: string,
): Promise<ResearchIdReservation | null> {
  const initialized = await resolveInitializedRegistry(context);
  if (initialized === null) return null;
  const path = reservationPath(context.registryDirectory, researchId);
  if (!(await pathExists(path))) return null;
  const source = await readStableFile(path, initialized.realRegistryDirectory);
  const record = ResearchIdReservationSchema.parse(JSON.parse(source) as unknown);
  if (record.researchId !== researchId) {
    throw new Error("A research ID reservation filename does not match its record.");
  }
  return Object.freeze(record);
}

function parseReservationInput(input: ResearchIdReservationInput): ResearchIdReservation {
  return Object.freeze(ResearchIdReservationSchema.parse({
    schemaVersion: 1,
    recordType: "research-id-reservation",
    ...input,
  }));
}

export async function reserveResearchId(
  logDirectory: string,
  input: ResearchIdReservationInput,
): Promise<boolean> {
  const record = parseReservationInput(input);
  const context = registryContextFor(logDirectory);
  const initialized = await ensureInitializedRegistry(context);
  return writeExclusiveStableFile(
    reservationPath(context.registryDirectory, record.researchId),
    initialized.realRegistryDirectory,
    `${JSON.stringify(record)}\n`,
  );
}

export async function hasReservedResearchId(
  logDirectory: string,
  researchId: string,
): Promise<boolean> {
  if (!RESEARCH_ID_PATTERN.test(researchId)) return false;
  return (await readReservation(registryContextFor(logDirectory), researchId)) !== null;
}

export async function assertResearchIdReservation(
  logDirectory: string,
  input: ResearchIdReservationInput,
): Promise<void> {
  const expected = parseReservationInput(input);
  const actual = await readReservation(registryContextFor(logDirectory), expected.researchId);
  if (actual === null || actual.sessionId !== expected.sessionId) {
    throw new Error("The session does not own the durable research ID reservation.");
  }
}
