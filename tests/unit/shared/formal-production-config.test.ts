import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatFormalProductionConfigError,
  hashFormalProductionConfig,
  hashFormalProductionCriticalConfig,
  hashFormalProductionGoEvidence,
  loadFormalProductionConfig,
  parseFormalProductionConfig,
} from "../../../src/shared/formal-production-config.js";
import {
  hashExperimentConfig,
  hashProductionCriticalConfig,
} from "../../../src/shared/config-loader.js";

function formalSource(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocolVersion: "R8-010-2x2-screen-v3",
    environment: "production",
    participantMode: "enabled",
    compliance: {
      mode: "external",
      evidenceStorage: "outside-system",
      verifiedByApplication: false,
      requireApprovalDocument: false,
      requireApprovalHash: false,
      requireSecondVerifier: false,
      requireReviewerIdentity: false,
      requireScreenPilotForRelease: false,
      requireManualGoTicket: false,
    },
    runtime: {
      requireOperatorSessionConfirmation: true,
      persistOperatorConfirmation: false,
      requireConsentConfirmation: true,
      requireEmergencyStopCheck: true,
    },
    privacy: {
      storeOperatorIdentity: false,
      storeApprovalEvidence: false,
      storeApprovalHash: false,
      storeIpAddress: false,
      analyticsEnabled: false,
      telemetryEnabled: false,
    },
    studyTitle: "正式設定テスト",
    bindHost: "127.0.0.1",
    port: 4_173,
    researchIdPattern: "^SH26-[0-9]{3}$",
    orders: ["ABDC", "BCAD", "CDBA", "DACB"],
    fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
    timingMs: {
      handling: 8_000,
      processing: 3_000,
      result: 15_000,
      reset: 7_000,
      inflateRamp: 6_000,
      deflateRamp: 6_000,
    },
    device: {
      mode: "screen",
      serialPath: "",
      baudRate: 115_200,
      ackTimeout: 1_000,
      allowMockInProduction: false,
    },
    formUrl: "",
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: { allowLan: false, allowExternalRuntimeRequests: false },
  };
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("formal external-compliance config", () => {
  it("starts without approval documents, hashes, reviewer identities or pilot counts", () => {
    const parsed = parseFormalProductionConfig(formalSource());
    expect(parsed).toMatchObject({
      environment: "production",
      participantMode: "enabled",
      compliance: {
        mode: "external",
        evidenceStorage: "outside-system",
        verifiedByApplication: false,
        requireApprovalDocument: false,
        requireApprovalHash: false,
        requireSecondVerifier: false,
        requireReviewerIdentity: false,
        requireScreenPilotForRelease: false,
        requireManualGoTicket: false,
      },
      runtime: {
        requireOperatorSessionConfirmation: true,
        persistOperatorConfirmation: false,
        requireConsentConfirmation: true,
        requireEmergencyStopCheck: true,
      },
    });
    expect(parsed.goEvidence).toBeUndefined();
    expect(hashFormalProductionGoEvidence(parsed)).toBeNull();
    expect(hashFormalProductionConfig(parsed)).toBe(hashExperimentConfig(parsed));
    expect(hashFormalProductionCriticalConfig(parsed))
      .toBe(hashProductionCriticalConfig(parsed));
  });

  it("discards known legacy PENDING approval state in external mode", () => {
    const parsed = parseFormalProductionConfig({
      ...formalSource(),
      approvalStatus: "PENDING",
      pendingApproval: true,
      approvalHash: "0".repeat(64),
      secondVerifier: "REV-PENDING",
      screenPilot: { completedSessions: 0 },
      manualGo: null,
      goEvidence: {
        status: "NO-GO",
        protocolVersion: "legacy",
      },
    });
    expect(parsed.goEvidence).toBeUndefined();
    expect(parsed).not.toHaveProperty("approvalStatus");
    expect(parsed).not.toHaveProperty("approvalHash");
    expect(parsed).not.toHaveProperty("secondVerifier");
    expect(parsed).not.toHaveProperty("screenPilot");
  });

  it.each([
    ["participant mode", { participantMode: "disabled" }, /participant-mode/iu],
    ["environment", { environment: "development" }, /environment/iu],
    ["form URL", { formUrl: "https://forms.gle/example" }, /form-url/iu],
    ["LAN", { network: { allowLan: true, allowExternalRuntimeRequests: false } }, /lan-access/iu],
    ["wrong port", { port: 4_174 }, /port-not-4173/iu],
    ["Mock", {
      device: {
        mode: "mock",
        serialPath: "",
        baudRate: 115_200,
        ackTimeout: 1_000,
        allowMockInProduction: false,
      },
    }, /mock-device/iu],
  ] as const)("rejects a non-formal %s value", (_label, override, pattern) => {
    expect(() => parseFormalProductionConfig({
      ...formalSource(),
      ...override,
    })).toThrow(pattern);
  });

  it("requires the closed external-compliance declaration", () => {
    expect(() => parseFormalProductionConfig({
      ...formalSource(),
      compliance: {
        ...(formalSource()["compliance"] as Record<string, unknown>),
        requireApprovalHash: true,
      },
    })).toThrow();
    expect(() => parseFormalProductionConfig({
      ...formalSource(),
      runtime: {
        ...(formalSource()["runtime"] as Record<string, unknown>),
        persistOperatorConfirmation: true,
      },
    })).toThrow();
  });

  it("loads a production file and returns no legacy approval state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-external-formal-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "config"));
    await writeFile(
      join(root, "config", "experiment.json"),
      JSON.stringify({ ...formalSource(), approvalStatus: "PENDING" }),
      "utf8",
    );
    const loaded = await loadFormalProductionConfig(undefined, { rootDirectory: root });
    expect(loaded.config.participantMode).toBe("enabled");
    expect(loaded.config).not.toHaveProperty("approvalStatus");
    expect(loaded.config.goEvidence).toBeUndefined();
  });

  it("rejects paths outside config and reports parse failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-external-path-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "config"));
    await writeFile(join(root, "outside.json"), JSON.stringify(formalSource()), "utf8");
    await expect(loadFormalProductionConfig("../outside.json", {
      rootDirectory: root,
    })).rejects.toThrow(/inside the allowed config directory/iu);
    expect(formatFormalProductionConfigError(new Error("read failed"))).toEqual([
      "read failed",
    ]);
  });
});
