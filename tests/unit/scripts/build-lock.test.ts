import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUILD_LOCK_ENVIRONMENT_VARIABLE,
  acquireBuildLock,
} from "../../../scripts/build-lock.mjs";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sechack-build-lock-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared build and release lock", () => {
  it("lets verified child builds inherit one release lock without releasing the owner", async () => {
    const root = await temporaryRoot();
    const owner = await acquireBuildLock(root, { kind: "release" });
    const inheritedEnvironment = owner.childEnvironment({ PATH: process.env.PATH });
    expect(inheritedEnvironment[BUILD_LOCK_ENVIRONMENT_VARIABLE]).toBe(owner.token);

    const child = await acquireBuildLock(root, {
      environment: inheritedEnvironment,
      kind: "build",
    });
    expect(child.owned).toBe(false);
    await child.release();
    await expect(access(join(root, "release", ".build.lock"))).resolves.toBeUndefined();

    await owner.release();
    await expect(access(join(root, "release", ".build.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an unrelated build immediately while a release is being sealed", async () => {
    const root = await temporaryRoot();
    const owner = await acquireBuildLock(root, { kind: "release" });
    try {
      await expect(acquireBuildLock(root, { kind: "build", waitMs: 0 }))
        .rejects.toThrow(/sealed release is currently being generated/iu);
    } finally {
      await owner.release();
    }
  });

  it("serializes ordinary builds within a bounded wait", async () => {
    const root = await temporaryRoot();
    const first = await acquireBuildLock(root, { kind: "build" });
    const secondPromise = acquireBuildLock(root, { kind: "build", waitMs: 2_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await first.release();
    const second = await secondPromise;
    expect(second.owned).toBe(true);
    await second.release();
  });

  it("waits through another owner's atomic lock initialization window", async () => {
    const root = await temporaryRoot();
    const preparatory = await acquireBuildLock(root);
    await preparatory.release();
    const lockPath = join(root, "release", ".build.lock");
    await writeFile(lockPath, "", "utf8");

    const contender = acquireBuildLock(root, { kind: "build", waitMs: 2_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      token: "00000000-0000-4000-8000-000000000000",
      kind: "build",
      pid: 2_147_483_647,
      createdAt: "2026-07-21T00:00:00.000Z",
    })}\n`, "utf8");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await rm(lockPath, { force: true });

    const acquired = await contender;
    expect(acquired.owned).toBe(true);
    await acquired.release();
  });

  it("serializes a burst of owners without treating handoff as an unsafe file", async () => {
    const root = await temporaryRoot();
    const completions: number[] = [];
    await Promise.all(Array.from({ length: 12 }, async (_value, index) => {
      const lock = await acquireBuildLock(root, { kind: "build", waitMs: 5_000 });
      completions.push(index);
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      await lock.release();
    }));
    expect(completions).toHaveLength(12);
    expect(new Set(completions).size).toBe(12);
  });

  it("fails closed on a mismatched inherited token and leaves the owner lock intact", async () => {
    const root = await temporaryRoot();
    const owner = await acquireBuildLock(root, { kind: "release" });
    try {
      await expect(acquireBuildLock(root, {
        environment: { [BUILD_LOCK_ENVIRONMENT_VARIABLE]: "00000000-0000-4000-8000-000000000000" },
      })).rejects.toThrow(/does not match/iu);
      await expect(access(join(root, "release", ".build.lock"))).resolves.toBeUndefined();
    } finally {
      await owner.release();
    }
  });

  it("never lets another release inherit an active release lock", async () => {
    const root = await temporaryRoot();
    const owner = await acquireBuildLock(root, { kind: "release" });
    try {
      await expect(acquireBuildLock(root, {
        environment: owner.childEnvironment(),
        kind: "release",
      })).rejects.toThrow(/only a build child may inherit/iu);
      await expect(access(join(root, "release", ".build.lock"))).resolves.toBeUndefined();
    } finally {
      await owner.release();
    }
  });

  it("never lets another build inherit an ordinary build lock", async () => {
    const root = await temporaryRoot();
    const owner = await acquireBuildLock(root, { kind: "build" });
    try {
      await expect(acquireBuildLock(root, {
        environment: owner.childEnvironment(),
        kind: "build",
      })).rejects.toThrow(/only a build child may inherit/iu);
      await expect(access(join(root, "release", ".build.lock"))).resolves.toBeUndefined();
    } finally {
      await owner.release();
    }
  });

  it("never deletes a malformed stale lock automatically", async () => {
    const root = await temporaryRoot();
    const releaseDirectory = join(root, "release");
    const preparatory = await acquireBuildLock(root);
    await preparatory.release();
    const lockPath = join(releaseDirectory, ".build.lock");
    await writeFile(lockPath, "not-json\n", "utf8");

    await expect(acquireBuildLock(root, { kind: "release" })).rejects.toThrow(/malformed/iu);
    await expect(access(lockPath)).resolves.toBeUndefined();
  });
});
