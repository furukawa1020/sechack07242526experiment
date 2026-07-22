import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertResearchIdReservation,
  hasReservedResearchId,
  reserveResearchId,
} from "../../../../src/server/logging/research-id-registry.js";

const SESSION_1 = "11111111-1111-4111-8111-111111111111";
const SESSION_2 = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

async function fixture(): Promise<{ readonly root: string; readonly logs: string }> {
  const root = await mkdtemp(join(tmpdir(), "sechack-registry-"));
  roots.push(root);
  const logs = join(root, "data", "sessions");
  await mkdir(logs, { recursive: true });
  return { root, logs };
}

function input(researchId = "SH26-001", sessionId = SESSION_1) {
  return {
    researchId,
    sessionId,
    reservedAt: "2026-07-21T00:00:00.000Z",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable research ID registry", () => {
  it("distinguishes a never-initialized registry and reserves with exclusive records", async () => {
    const { root, logs } = await fixture();
    await expect(hasReservedResearchId(logs, "SH26-001")).resolves.toBe(false);
    await expect(reserveResearchId(logs, input())).resolves.toBe(true);
    await expect(reserveResearchId(logs, input("SH26-001", SESSION_2))).resolves.toBe(false);
    await expect(hasReservedResearchId(logs, "SH26-001")).resolves.toBe(true);
    await expect(hasReservedResearchId(logs, "SH26-002")).resolves.toBe(false);
    await expect(assertResearchIdReservation(logs, input())).resolves.toBeUndefined();
    await expect(assertResearchIdReservation(logs, input("SH26-001", SESSION_2)))
      .rejects.toThrow(/does not own/iu);

    const record = JSON.parse(
      await readFile(join(root, "data", "research-id-registry", "SH26-001.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(record).toEqual({
      schemaVersion: 1,
      recordType: "research-id-reservation",
      researchId: "SH26-001",
      sessionId: SESSION_1,
      reservedAt: "2026-07-21T00:00:00.000Z",
    });
  });

  it("fails closed when either initialized registry component disappears", async () => {
    const { root, logs } = await fixture();
    await reserveResearchId(logs, input());
    await rm(join(root, "data", "research-id-registry"), { recursive: true, force: true });
    await expect(hasReservedResearchId(logs, "SH26-001")).rejects.toThrow(/removed|incomplete/iu);
    await expect(reserveResearchId(logs, input("SH26-002", SESSION_2)))
      .rejects.toThrow(/removed|incomplete/iu);

    const second = await fixture();
    await reserveResearchId(second.logs, input());
    await rm(join(second.root, "data", ".research-id-registry-initialized.json"), { force: true });
    await expect(hasReservedResearchId(second.logs, "SH26-001"))
      .rejects.toThrow(/removed|incomplete/iu);
  });

  it("rejects a pre-positioned registry junction outside the real logging parent", async () => {
    const { root, logs } = await fixture();
    const outside = join(root, "outside-registry");
    await mkdir(outside);
    await symlink(outside, join(root, "data", "research-id-registry"), "junction");
    await expect(reserveResearchId(logs, input())).rejects.toThrow(/initialization|real directory/iu);
    await expect(readFile(join(outside, "SH26-001.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects hard-linked reservation records", async () => {
    const { root, logs } = await fixture();
    await reserveResearchId(logs, input());
    const recordPath = join(root, "data", "research-id-registry", "SH26-001.json");
    const linkedPath = join(root, "outside-reservation.json");
    await link(recordPath, linkedPath);
    await expect(hasReservedResearchId(logs, "SH26-001")).rejects.toThrow(/single-link/iu);
  });

  it("fails closed on a malformed anchor", async () => {
    const { root, logs } = await fixture();
    await reserveResearchId(logs, input());
    await writeFile(
      join(root, "data", ".research-id-registry-initialized.json"),
      "tampered\n",
      "utf8",
    );
    await expect(hasReservedResearchId(logs, "SH26-001")).rejects.toThrow(/anchor/iu);
  });
});
