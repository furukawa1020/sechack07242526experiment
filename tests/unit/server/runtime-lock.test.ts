import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer, type RunningExperimentServer } from "../../../src/server/index.js";
import { acquireExperimentServerLock } from "../../../src/server/runtime-lock.js";

const LOCK_FILE_NAME = ".experiment-server.lock";
const CONFIG_HASH_A = "a".repeat(64);
const CONFIG_HASH_B = "b".repeat(64);
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sechack-runtime-lock-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "data"));
  return root;
}

async function listenOnEphemeralPort(): Promise<{
  readonly port: number;
  readonly server: NetServer;
}> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine the temporary TCP port.");
  }
  return { port: address.port, server };
}

async function closeNetServer(server: NetServer): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

async function availablePort(): Promise<number> {
  const reserved = await listenOnEphemeralPort();
  await closeNetServer(reserved.server);
  return reserved.port;
}

async function writeTestConfig(root: string, port: number): Promise<void> {
  const source: unknown = JSON.parse(
    await readFile(resolve(process.cwd(), "config", "experiment.e2e.json"), "utf8"),
  );
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("The E2E experiment configuration is invalid.");
  }
  await mkdir(join(root, "config"));
  await writeFile(
    join(root, "config", "experiment.json"),
    `${JSON.stringify(
      {
        ...source,
        port,
        logging: {
          directory: "./data/sessions",
          includeAbortedInOrderBalancing: true,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeStaleLock(dataDirectory: string): Promise<void> {
  await writeFile(
    join(dataDirectory, LOCK_FILE_NAME),
    `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      startedAt: "2026-07-19T00:00:00.000Z",
      configHash: CONFIG_HASH_A,
      token: randomUUID(),
    })}\n`,
    "utf8",
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("experiment server runtime lock", () => {
  it("rejects a second active owner and permits idempotent release by the owner", async () => {
    const root = await temporaryRoot();
    const first = await acquireExperimentServerLock(join(root, "data"), CONFIG_HASH_A);

    await expect(acquireExperimentServerLock(join(root, "data"), CONFIG_HASH_B)).rejects.toThrow(
      /Another experiment server process is active/iu,
    );
    await first.release();
    await expect(first.release()).resolves.toBeUndefined();

    const next = await acquireExperimentServerLock(join(root, "data"), CONFIG_HASH_B);
    await next.release();
  });

  it("does not unlink a lock whose ownership token changed", async () => {
    const root = await temporaryRoot();
    const lock = await acquireExperimentServerLock(join(root, "data"), CONFIG_HASH_A);
    const current: unknown = JSON.parse(await readFile(lock.path, "utf8"));
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      throw new Error("The acquired lock payload is invalid.");
    }
    await writeFile(lock.path, `${JSON.stringify({ ...current, token: randomUUID() })}\n`, "utf8");

    await expect(lock.release()).rejects.toThrow(/no longer owned/iu);
    await expect(readFile(lock.path, "utf8")).resolves.toContain("token");
  });

  it("does not steal a recently created incomplete lock", async () => {
    const root = await temporaryRoot();
    const lockPath = join(root, "data", LOCK_FILE_NAME);
    await writeFile(lockPath, "", "utf8");

    await expect(acquireExperimentServerLock(join(root, "data"), CONFIG_HASH_A)).rejects.toThrow(
      /after multiple attempts/iu,
    );
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
    expect((await readdir(join(root, "data"))).some((name) => name.includes(".stale-"))).toBe(
      false,
    );
  });

  it("warns after stale-lock recovery, holds the lock while listening, and releases it on shutdown", async () => {
    const root = await temporaryRoot();
    await writeTestConfig(root, await availablePort());
    await writeStaleLock(join(root, "data"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let running: RunningExperimentServer | null = null;

    try {
      running = await startServer({ rootDirectory: root, mode: "test" });
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Recovered a stale experiment server lock"),
      );
      expect((await readdir(join(root, "data"))).some((name) => name.includes(".stale-"))).toBe(
        true,
      );
      await expect(acquireExperimentServerLock(join(root, "data"), CONFIG_HASH_B)).rejects.toThrow(
        /Another experiment server process is active/iu,
      );
    } finally {
      await running?.close();
    }

    const next = await acquireExperimentServerLock(join(root, "data"), CONFIG_HASH_B);
    await next.release();
  });

  it("releases the lock when startup fails while binding the listening socket", async () => {
    const root = await temporaryRoot();
    const occupied = await listenOnEphemeralPort();
    await writeTestConfig(root, occupied.port);

    try {
      await expect(startServer({ rootDirectory: root, mode: "test" })).rejects.toThrow(
        /EADDRINUSE/iu,
      );
    } finally {
      await closeNetServer(occupied.server);
    }

    const next = await acquireExperimentServerLock(join(root, "data"), CONFIG_HASH_B);
    await next.release();
  });
});
