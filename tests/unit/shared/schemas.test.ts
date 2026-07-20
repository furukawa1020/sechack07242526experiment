import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  hashExperimentConfig,
  loadExperimentConfig,
} from "../../../src/shared/config-loader.js";
import {
  ExperimentConfigSchema,
  formatConfigError,
  isResearchIdValid,
  parseExperimentConfig,
} from "../../../src/shared/schemas.js";

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocolVersion: "R8-010-2x2-mock-v1",
    studyTitle: "身体状態の提示実験",
    bindHost: "127.0.0.1",
    port: 4173,
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
      mode: "mock",
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

describe("experiment config schema", () => {
  it("parses and deeply freezes the approved configuration", () => {
    const config = parseExperimentConfig(validConfig());
    expect(config.fixedState).toEqual({ score: 72, label: "高ストレス", pufferLevel: 0.6 });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.fixedState)).toBe(true);
    expect(Object.isFrozen(config.orders)).toBe(true);
    expect(isResearchIdValid(config, "SH26-001")).toBe(true);
    expect(isResearchIdValid(config, "SH26-01")).toBe(false);
    expect(isResearchIdValid(config, "SH26-001\nmail@example.test")).toBe(false);
    expect(isResearchIdValid(config, "X".repeat(65))).toBe(false);
  });

  it("rejects unknown keys, modified orders and unsafe network settings", () => {
    expect(() => parseExperimentConfig({ ...validConfig(), email: "person@example.test" })).toThrow();
    expect(() => parseExperimentConfig({ ...validConfig(), orders: ["ABDC", "ABDC", "CDBA", "DACB"] }))
      .toThrow(/orders/iu);
    expect(() => parseExperimentConfig({ ...validConfig(), bindHost: "0.0.0.0" }))
      .toThrow(/loopback/iu);
    expect(() => parseExperimentConfig({
      ...validConfig(),
      network: { allowLan: true, allowExternalRuntimeRequests: true },
    })).toThrow(/External runtime requests/iu);
  });

  it("validates serial, timing, URL and regular-expression fields", () => {
    expect(() => parseExperimentConfig({
      ...validConfig(),
      device: { ...(validConfig()["device"] as object), mode: "serial", serialPath: "" },
    })).toThrow(/serialPath/iu);
    expect(() => parseExperimentConfig({
      ...validConfig(),
      timingMs: { ...(validConfig()["timingMs"] as object), reset: 1_000 },
    })).toThrow(/deflateRamp/iu);
    expect(() => parseExperimentConfig({
      ...validConfig(),
      timingMs: { ...(validConfig()["timingMs"] as object), result: 1_000 },
    })).toThrow(/inflateRamp/iu);
    expect(() => parseExperimentConfig({ ...validConfig(), formUrl: "http://example.test/form" }))
      .toThrow(/HTTPS/iu);
    expect(() => parseExperimentConfig({ ...validConfig(), formUrl: "not a url" }))
      .toThrow(/valid HTTPS URL/iu);
    expect(() => parseExperimentConfig({ ...validConfig(), formUrl: "https://example.test/form" }))
      .toThrow(/Google Forms/iu);
    expect(parseExperimentConfig({
      ...validConfig(),
      formUrl: "https://docs.google.com/forms/d/e/example/viewform",
    }).formUrl).toContain("docs.google.com/forms/");
    expect(() => parseExperimentConfig({ ...validConfig(), researchIdPattern: "[" }))
      .toThrow(/regular expression/iu);
  });

  it("formats validation errors without exposing an exception object", () => {
    const parsed = ExperimentConfigSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatConfigError(parsed.error)[0]).toMatch(/^schemaVersion:/u);
    }
    expect(formatConfigError(new Error("plain failure"))).toEqual(["plain failure"]);
    expect(formatConfigError(null)).toEqual(["Unknown configuration error."]);
  });
});

describe("config file loading", () => {
  it("loads the repository config and returns a stable SHA-256", async () => {
    const loaded = await loadExperimentConfig();
    expect(loaded.config.protocolVersion).toBe("R8-010-2x2-mock-v1");
    expect(loaded.configHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashExperimentConfig(loaded.config)).toBe(loaded.configHash);
  });

  it("blocks path traversal and production MockDevice misuse", async () => {
    await expect(loadExperimentConfig("../outside.json")).rejects.toThrow(/allowed config directory/iu);
    await expect(loadExperimentConfig("config/experiment.json", { production: true }))
      .rejects.toThrow(/Mock device mode is disabled/iu);
  });

  it("reports malformed JSON from an allowed temporary config directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-config-"));
    const configDirectory = join(root, "config");
    await mkdir(configDirectory);
    await writeFile(join(configDirectory, "broken.json"), "{ broken", "utf8");
    await expect(loadExperimentConfig("config/broken.json", { rootDirectory: root }))
      .rejects.toThrow(/not valid JSON/iu);
  });
});
