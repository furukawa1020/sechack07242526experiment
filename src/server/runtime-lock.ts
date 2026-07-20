import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_FILE_NAME = ".experiment-server.lock";
const LOCK_INITIALIZATION_GRACE_MS = 5_000;
const LOCK_RETRY_DELAY_MS = 50;
const MAX_ACQUIRE_ATTEMPTS = 10;

interface LockPayload {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly configHash: string;
  readonly token: string;
}

export interface ExperimentServerLock {
  readonly path: string;
  readonly recoveredStaleLock: boolean;
  release(): Promise<void>;
}

function parseLockPayload(source: string): LockPayload | null {
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed === null || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.schemaVersion !== 1 ||
      !Number.isSafeInteger(candidate.pid) ||
      Number(candidate.pid) <= 0 ||
      typeof candidate.startedAt !== "string" ||
      typeof candidate.configHash !== "string" ||
      typeof candidate.token !== "string"
    ) {
      return null;
    }
    return candidate as unknown as LockPayload;
  } catch {
    return null;
  }
}

function processIsActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

export async function acquireExperimentServerLock(
  dataDirectory: string,
  configHash: string,
): Promise<ExperimentServerLock> {
  if (!/^[a-f0-9]{64}$/u.test(configHash))
    throw new TypeError("configHash must be a SHA-256 digest.");
  const rootDirectory = resolve(dataDirectory);
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  const lockPath = resolve(rootDirectory, LOCK_FILE_NAME);
  const payload: LockPayload = Object.freeze({
    schemaVersion: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    configHash,
    token: randomUUID(),
  });
  const serialized = `${JSON.stringify(payload)}\n`;
  let recoveredStaleLock = false;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    let createdByThisAttempt = false;
    try {
      const handle = await open(lockPath, "wx", 0o600);
      createdByThisAttempt = true;
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      let released = false;
      return Object.freeze({
        path: lockPath,
        recoveredStaleLock,
        async release(): Promise<void> {
          if (released) return;
          const current = parseLockPayload(await readFile(lockPath, "utf8"));
          if (current?.token !== payload.token) {
            throw new Error("The experiment server lock is no longer owned by this process.");
          }
          await unlink(lockPath);
          released = true;
        },
      });
    } catch (error) {
      if (createdByThisAttempt) {
        try {
          await unlink(lockPath);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new AggregateError(
              [
                error instanceof Error ? error : new Error("Runtime lock initialization failed."),
                cleanupError instanceof Error
                  ? cleanupError
                  : new Error("Partial runtime lock cleanup failed."),
              ],
              "The experiment server lock could not be initialized or cleaned up.",
              { cause: cleanupError },
            );
          }
        }
        throw error;
      }
      if (!isAlreadyExists(error)) throw error;
      let existing: LockPayload | null;
      try {
        existing = parseLockPayload(await readFile(lockPath, "utf8"));
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      if (existing !== null && processIsActive(existing.pid)) {
        throw new Error(
          `Another experiment server process is active (PID ${String(existing.pid)}).`,
          { cause: error },
        );
      }
      if (existing === null) {
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs < LOCK_INITIALIZATION_GRACE_MS) {
            await delay(LOCK_RETRY_DELAY_MS);
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
      }
      const stalePath = resolve(
        rootDirectory,
        `.experiment-server.stale-${Date.now().toString()}-${randomUUID()}.json`,
      );
      try {
        await rename(lockPath, stalePath);
        recoveredStaleLock = true;
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new Error("Could not acquire the experiment server lock after multiple attempts.");
}
