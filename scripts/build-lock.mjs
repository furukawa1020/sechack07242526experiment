import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const BUILD_LOCK_ENVIRONMENT_VARIABLE = "SECHACK_BUILD_LOCK_TOKEN";

const LOCK_FILE_NAME = ".build.lock";
const MAX_LOCK_BYTES = 2_048;
const DEFAULT_BUILD_WAIT_MS = 15_000;
const RETRY_INTERVAL_MS = 100;
const INITIALIZATION_GRACE_MS = 500;
const INITIALIZATION_RETRY_MS = 10;
const TOKEN_PATTERN = /^[a-f0-9-]{36}$/u;

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent));
}

function lockError(detail) {
  return new Error(
    `${detail} Stop every build/release process first. If none is running, inspect `
      + "release/.build.lock and remove it manually only after confirming it is stale.",
  );
}

async function safeLockPath(rootDirectory) {
  const root = resolve(rootDirectory);
  const releaseDirectory = resolve(root, "release");
  await mkdir(releaseDirectory, { recursive: true, mode: 0o700 });
  const [releaseStat, realRoot, realRelease] = await Promise.all([
    lstat(releaseDirectory),
    realpath(root),
    realpath(releaseDirectory),
  ]);
  if (releaseStat.isSymbolicLink() || !releaseStat.isDirectory() || !isInside(realRoot, realRelease)) {
    throw lockError("The release build-lock directory is not a normal directory inside the workspace.");
  }
  return resolve(realRelease, LOCK_FILE_NAME);
}

async function readLockOnce(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    let pathStat;
    try {
      pathStat = await lstat(lockPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || !stat.isFile()
      || stat.size > MAX_LOCK_BYTES
    ) {
      throw lockError("The release build lock has an unsafe structure.");
    }
    if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      return Object.freeze({
        initializationError: "The release build lock changed owners while it was inspected.",
      });
    }
    if (stat.size < 2) {
      return Object.freeze({
        initializationError: "The release build lock has an unsafe structure.",
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(await handle.readFile("utf8"));
    } catch {
      return Object.freeze({
        initializationError: "The release build lock is unreadable or malformed.",
      });
    }
    if (
      parsed === null
      || typeof parsed !== "object"
      || !TOKEN_PATTERN.test(String(parsed.token))
      || !["build", "release"].includes(parsed.kind)
      || !Number.isSafeInteger(parsed.pid)
      || parsed.pid < 1
      || typeof parsed.createdAt !== "string"
    ) {
      throw lockError("The release build lock has invalid metadata.");
    }
    return Object.freeze({
      token: parsed.token,
      kind: parsed.kind,
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      device: stat.dev,
      inode: stat.ino,
    });
  } finally {
    await handle.close();
  }
}

async function readLock(lockPath) {
  const initializationDeadline = Date.now() + INITIALIZATION_GRACE_MS;
  while (true) {
    const current = await readLockOnce(lockPath);
    if (current === null || !("initializationError" in current)) return current;
    if (Date.now() >= initializationDeadline) {
      throw lockError(current.initializationError);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, INITIALIZATION_RETRY_MS));
  }
}

function childEnvironment(token, baseEnvironment = process.env) {
  return { ...baseEnvironment, [BUILD_LOCK_ENVIRONMENT_VARIABLE]: token };
}

async function inheritedLock(lockPath, inheritedToken, requestedKind) {
  if (!TOKEN_PATTERN.test(inheritedToken)) {
    throw lockError("The inherited release build-lock token is invalid.");
  }
  const current = await readLock(lockPath);
  if (current === null || current.token !== inheritedToken) {
    throw lockError("The inherited release build-lock token does not match the active lock.");
  }
  if (requestedKind !== "build" || current.kind !== "release") {
    throw lockError(
      "Only a build child may inherit the token of an active release lock.",
    );
  }
  return Object.freeze({
    token: inheritedToken,
    owned: false,
    childEnvironment(baseEnvironment) {
      return childEnvironment(inheritedToken, baseEnvironment);
    },
    async release() {},
  });
}

async function waitForStandaloneBuild(lockPath, waitMs) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const current = await readLock(lockPath);
    if (current === null) return;
    if (current.kind === "release") {
      throw lockError("A sealed release is currently being generated.");
    }
    if (Date.now() >= deadline) {
      throw lockError("Another build is still active after the bounded wait.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, RETRY_INTERVAL_MS));
  }
}

export async function acquireBuildLock(rootDirectory, options = {}) {
  const kind = options.kind ?? "build";
  if (!(kind === "build" || kind === "release")) {
    throw new Error("Build-lock kind must be build or release.");
  }
  const waitMs = options.waitMs ?? DEFAULT_BUILD_WAIT_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
    throw new Error("Build-lock waitMs must be an integer between 0 and 60000.");
  }
  const environment = options.environment ?? process.env;
  const lockPath = await safeLockPath(rootDirectory);
  const inheritedToken = environment[BUILD_LOCK_ENVIRONMENT_VARIABLE];
  if (inheritedToken !== undefined) {
    return inheritedLock(lockPath, inheritedToken, kind);
  }

  const token = randomUUID();
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (kind === "release") {
        const current = await readLock(lockPath);
        if (current === null) continue;
        throw lockError("Another build or release already owns the workspace artifacts.");
      }
      await waitForStandaloneBuild(lockPath, waitMs);
      continue;
    }

    let createdStat;
    try {
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: 1,
        token,
        kind,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`, "utf8");
      await handle.sync();
      createdStat = await handle.stat();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    await handle.close();

    let released = false;
    return Object.freeze({
      token,
      owned: true,
      childEnvironment(baseEnvironment) {
        return childEnvironment(token, baseEnvironment);
      },
      async release() {
        if (released) return;
        const current = await readLock(lockPath);
        if (
          current === null
          || current.token !== token
          || current.device !== createdStat.dev
          || current.inode !== createdStat.ino
        ) {
          throw lockError("The release build lock changed before its owner could release it.");
        }
        await unlink(lockPath);
        released = true;
      },
    });
  }
}
