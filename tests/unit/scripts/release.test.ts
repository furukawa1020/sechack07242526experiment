import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRelease,
  hashTrackedSourceTreeAtCommit,
  inspectProductionSourceEvidence,
  parseCreateReleaseArguments,
} from "../../../scripts/create-release.js";
import {
  createReleaseManifest,
  isCredentialFreeSourceRepository,
  RELEASE_MANIFEST_NAME,
  sha256ReleaseManifest,
  verifyReleaseDirectory,
  verifyReleaseDirectoryDetailed,
  writeReleaseManifest,
  type ReleaseManifest,
} from "../../../scripts/release-manifest.js";
import { runReleaseVerification } from "../../../scripts/verify-release.js";
import {
  hashExperimentConfig,
  hashProductionCriticalConfig,
  hashProductionGoEvidence,
} from "../../../src/shared/config-loader.js";
import {
  parseExperimentConfig,
  SCREEN_PROTOCOL_VERSION,
} from "../../../src/shared/schemas.js";

interface ConfigOverrides {
  readonly allowLan?: boolean;
  readonly mode?: "mock" | "serial" | "screen";
  readonly protocolVersion?: string;
  readonly serialPath?: string;
  readonly allowMockInProduction?: boolean;
  readonly bindHost?: string;
  readonly formUrl?: string;
  readonly loggingDirectory?: string;
  readonly allowExternalRuntimeRequests?: boolean;
  readonly researchIdPattern?: string;
}

const execFileAsync = promisify(execFile);
const SYNTHETIC_SOURCE_COMMIT = "1".repeat(40);
const SYNTHETIC_SOURCE_REPOSITORY = "https://github.com/example/sechack-release-fixture.git";
const STUDY_FORM_URL = "https://forms.gle/BeShY7cY5zMjunto9";
const EXPECTED_FORM_TITLE =
  "身体状態の外化デバイスがユーザの心理状態に及ぼす影響の評価｜研究説明・参加同意・アンケート";
const EXPECTED_FORM_FINAL_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSea5PhAbtkSS_Pg-xL-O7scpRddMn5ReoKzgAt7lSE7GTlA9Q/viewform?usp=send_form";
const TODAY_IN_JAPAN = new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);

function fixtureDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function approvedFormPayload(): { readonly html: string; readonly sha256: string } {
  const content = [
    "この実験では、同じ固定模擬データを4つの方法で提示します。",
    "表示される値は、あなた自身を測定したものではありません。",
    "この実験では、心拍その他の生体データを取得しません。",
    "状態は画面上のフグのふくらみで表します。",
    "アンケート回答は、Googleフォームの送信時にGoogleへ送信・保存されます。",
    "この実験用Webアプリから、固定模擬身体データを外部へ送信・保存することはありません。",
    "4つの提示をすべて見終え、サマリーが表示された後、このフォームへ戻ってください。",
    "各提示の直後には回答せず、4つの提示がすべて終了してから回答してください。",
    "第1提示から第4提示までを、11問でそれぞれ評価してください。",
  ].join(" ");
  const rows = ["第1提示", "第2提示", "第3提示", "第4提示"];
  const scale = ["1全くそう思わない", "2", "3", "4", "5", "6", "7非常にそう思う"];
  const items = [
    [
      null,
      "研究用ID",
      "研究スタッフから伝えられた研究用IDを入力してください。",
      0,
      [[null, null, 1, null, [[4, 301, ["^SH26-[0-9]{3}$"], "形式を確認してください"]]]],
    ],
    ...Array.from({ length: 11 }, (_unused, questionIndex) => [
      null,
      `評価質問${String(questionIndex + 1)}`,
      null,
      7,
      rows.map((row) => [null, scale.map((label) => [label]), 0, [row]]),
    ]),
  ];
  const payload = JSON.stringify([content, [null, items]]);
  return Object.freeze({
    html: `<title>${EXPECTED_FORM_TITLE}</title><script>var FB_PUBLIC_LOAD_DATA_ = ${payload};</script>`,
    sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
  });
}

const APPROVED_FORM = approvedFormPayload();

const approvedFormFetch = (async (): Promise<Response> => {
  const response = new Response(APPROVED_FORM.html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  Object.defineProperty(response, "url", { value: EXPECTED_FORM_FINAL_URL });
  return response;
}) as typeof fetch;

function configSource(overrides: ConfigOverrides = {}): Record<string, unknown> {
  const mode = overrides.mode ?? "screen";
  const protocolVersion = overrides.protocolVersion
    ?? (mode === "screen" ? SCREEN_PROTOCOL_VERSION : "release-test-v1");
  const formUrl = overrides.formUrl ?? STUDY_FORM_URL;
  const source = {
    schemaVersion: 1,
    protocolVersion,
    studyTitle: "リリース合成設定",
    bindHost: overrides.bindHost ?? "127.0.0.1",
    port: 4173,
    researchIdPattern: overrides.researchIdPattern
      ?? (mode === "screen" ? "^SH26-[0-9]{3}$" : "^TEST-[0-9]{3}$"),
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
      mode,
      serialPath: overrides.serialPath ?? (mode === "serial" ? "COM3" : ""),
      baudRate: 115_200,
      ackTimeout: 1_000,
      allowMockInProduction: overrides.allowMockInProduction ?? false,
    },
    formUrl,
    formAudit: {
      status: formUrl === "" ? "NO-GO" : "GO",
      protocolVersion,
      formUrl,
      auditedOn: TODAY_IN_JAPAN,
      contentSha256: formUrl === "" ? "0".repeat(64) : APPROVED_FORM.sha256,
      twoPersonVerified: formUrl !== "",
    },
    logging: {
      directory: overrides.loggingDirectory ?? "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: {
      allowLan: overrides.allowLan ?? false,
      allowExternalRuntimeRequests: overrides.allowExternalRuntimeRequests ?? false,
    },
  };
  if (mode !== "screen" || formUrl !== STUDY_FORM_URL) return source;
  let criticalConfigSha256: string;
  try {
    criticalConfigSha256 = hashProductionCriticalConfig(parseExperimentConfig(source));
  } catch {
    // Invalid-config tests must reach the real loader and fail there rather
    // than being made synthetically valid by this approved-evidence helper.
    return source;
  }
  const approval = (documentId: string, contentSha256: string) => ({
    status: "GO",
    protocolVersion,
    documentId,
    documentVersion: "1.0",
    contentSha256,
    approvedOn: TODAY_IN_JAPAN,
    applicableUntil: TODAY_IN_JAPAN,
  });
  return {
    ...source,
    goEvidence: {
      status: "GO",
      protocolVersion,
      criticalConfigSha256,
      researchPlan: approval("PLAN-001", fixtureDigest("research-plan")),
      ethicsDetermination: approval("ETHICS-001", fixtureDigest("ethics")),
      preStimulusConsent: approval("CONSENT-001", fixtureDigest("consent")),
      dataManagementPlan: approval("DATA-PLAN-001", fixtureDigest("data-plan")),
      screenPilot: {
        ...approval("SCREEN-PILOT-001", fixtureDigest("screen-pilot")),
        completedSessions: 3,
        sourceTreeSha256: fixtureDigest("source-tree"),
        pilotConfigFileHash: fixtureDigest("pilot-config"),
      },
      releaseVerification: {
        status: "GO",
        protocolVersion,
        appVersion: "9.8.7",
        criticalConfigSha256,
        sourceTreeSha256: fixtureDigest("source-tree"),
        reviews: [
          {
            reviewId: "RELEASE-REVIEW-001",
            reviewerCode: "REV-0001",
            reviewVersion: "1.0",
            status: "GO",
            protocolVersion,
            criticalConfigSha256,
            reviewedOn: TODAY_IN_JAPAN,
            applicableUntil: TODAY_IN_JAPAN,
            attestationSha256: fixtureDigest("release-attestation-1"),
          },
          {
            reviewId: "RELEASE-REVIEW-002",
            reviewerCode: "REV-0002",
            reviewVersion: "1.0",
            status: "GO",
            protocolVersion,
            criticalConfigSha256,
            reviewedOn: TODAY_IN_JAPAN,
            applicableUntil: TODAY_IN_JAPAN,
            attestationSha256: fixtureDigest("release-attestation-2"),
          },
        ],
      },
    },
  };
}

function mockRehearsalConfigSource(overrides: ConfigOverrides = {}): Record<string, unknown> {
  return {
    ...configSource({
      mode: "mock",
      serialPath: "",
      formUrl: "",
      loggingDirectory: "./data/mock-sessions",
      researchIdPattern: "^DEMO-[0-9]{3}$",
      ...overrides,
    }),
    formAudit: undefined,
    goEvidence: undefined,
  };
}

const temporaryRoots: string[] = [];

async function newTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeRelative(root: string, path: string, contents: string): Promise<void> {
  const destination = join(root, ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, "utf8");
}

async function runGit(root: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    try {
      await readdir(path);
      return true;
    } catch {
      return false;
    }
  }
}

async function listFiles(root: string, current = root): Promise<readonly string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push(relative(root, absolutePath).split(sep).join("/"));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function createManifestFixture(): Promise<{
  readonly root: string;
  readonly manifest: ReleaseManifest;
}> {
  const root = await newTemporaryRoot("sechack-manifest-");
  await writeRelative(root, "app.txt", "alpha");
  await writeRelative(root, "nested/config.txt", "bravo");
  await writeRelative(root, "package.json", JSON.stringify({ version: "9.8.7" }));
  const configBytes = JSON.stringify(configSource());
  const parsedConfig = parseExperimentConfig(JSON.parse(configBytes) as unknown);
  await writeRelative(root, "config/experiment.json", configBytes);
  await writeRelative(root, "data/sessions/runtime.jsonl", "ignored runtime data");
  const manifest = await createReleaseManifest(root, {
    appVersion: "9.8.7",
    protocolVersion: parsedConfig.protocolVersion,
    configHash: hashExperimentConfig(parsedConfig),
    configFileHash: createHash("sha256").update(configBytes).digest("hex"),
    sourceCommit: SYNTHETIC_SOURCE_COMMIT,
    sourceTreeSha256: fixtureDigest("source-tree"),
    sourceRepository: SYNTHETIC_SOURCE_REPOSITORY,
  });
  await writeReleaseManifest(root, manifest);
  return { root, manifest };
}

async function createReleaseSource(overrides: ConfigOverrides = {}): Promise<string> {
  const root = await newTemporaryRoot("sechack-release-");
  await writeRelative(root, ".gitignore", "release/\ndata/**\n*.ignored-config\n");
  await writeRelative(
    root,
    "config/experiment.production.json",
    JSON.stringify(configSource(overrides)),
  );
  await writeRelative(
    root,
    "config/experiment.screen-pilot.json",
    `${JSON.stringify({ fixture: "screen-pilot", protocolVersion: SCREEN_PROTOCOL_VERSION })}\n`,
  );
  await writeRelative(
    root,
    "config/site-mock-rehearsal.json",
    JSON.stringify(mockRehearsalConfigSource(overrides)),
  );
  await writeRelative(root, "config/experiment.e2e.json", "must not be released");
  await writeRelative(root, "data/sessions/synthetic.jsonl", "must not be released");
  await writeRelative(root, "tests/private-fixture.txt", "must not be released");
  await writeRelative(root, "artifacts/test-results/trace.zip", "must not be released");
  await writeRelative(root, ".env", "SECRET=must-not-be-released");

  await writeRelative(root, "dist/index.html", "<!doctype html><title>release test</title>");
  await writeRelative(root, "dist/assets/app.js", "console.info('synthetic client');");
  await writeRelative(root, "dist/assets/app.css", "body { color: black; }");
  await writeRelative(root, "dist/assets/app.js.map", "must not be released");
  for (const name of [
    "index",
    "rehearsal",
    "preflight",
    "healthcheck",
    "data-lifecycle",
    "verify-release",
  ] as const) {
    await writeRelative(
      root,
      `dist-server/${name}.js`,
      `export const name = ${JSON.stringify(name)};`,
    );
  }
  await writeRelative(root, "dist-server/index.js.map", "must not be released");
  await writeRelative(root, "dist-server/stale.js", "must not be released");

  for (const name of [
    "RUNBOOK",
    "DEVICE_PROTOCOL",
    "EXPERIMENT_SPEC",
    "UI_COPY",
    "PROTOCOL_CHANGELOG",
    "TEST_REPORT",
    "RELEASE_CHECKLIST",
    "FORM_AUDIT",
    "FORM_RELEASE_GATE",
    "FORM_OWNER_FIX_GUIDE",
    "MOCK_REHEARSAL",
    "PUBLIC_DEMO",
    "GO_EVIDENCE",
    "DATA_LIFECYCLE",
  ] as const) {
    await writeRelative(root, `docs/${name}.md`, `# ${name}\n`);
  }
  await writeRelative(root, "docs/DEPLOYMENT.md", "# Synthetic deployment\n");

  await writeRelative(
    root,
    "package.json",
    JSON.stringify({
      name: "synthetic-release-fixture",
      version: "9.8.7",
      private: true,
      type: "module",
      scripts: { build: "node -e \"process.exit(0)\"" },
      dependencies: {},
    }),
  );
  await writeRelative(
    root,
    "package-lock.json",
    JSON.stringify({
      name: "synthetic-release-fixture",
      version: "9.8.7",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "synthetic-release-fixture",
          version: "9.8.7",
        },
      },
    }),
  );
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.name", "Release Fixture"]);
  await runGit(root, ["config", "user.email", "release-fixture@example.invalid"]);
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "--quiet", "-m", "Create release fixture"]);
  const evidenceCommit = await runGit(root, ["rev-parse", "HEAD"]);
  const sourceTreeSha256 = await hashTrackedSourceTreeAtCommit(root, evidenceCommit);
  const pilotConfigFileHash = createHash("sha256").update(
    await readFile(join(root, "config", "experiment.screen-pilot.json")),
  ).digest("hex");
  const productionConfigPath = join(root, "config", "experiment.production.json");
  const productionConfig = JSON.parse(
    await readFile(productionConfigPath, "utf8"),
  ) as Record<string, unknown>;
  const goEvidence = productionConfig["goEvidence"];
  if (goEvidence !== null && typeof goEvidence === "object") {
    const releaseVerification = (goEvidence as Record<string, unknown>)["releaseVerification"];
    if (releaseVerification !== null && typeof releaseVerification === "object") {
      (releaseVerification as Record<string, unknown>)["sourceTreeSha256"] = sourceTreeSha256;
    }
    const screenPilot = (goEvidence as Record<string, unknown>)["screenPilot"];
    if (screenPilot !== null && typeof screenPilot === "object") {
      (screenPilot as Record<string, unknown>)["sourceTreeSha256"] = sourceTreeSha256;
      (screenPilot as Record<string, unknown>)["pilotConfigFileHash"] = pilotConfigFileHash;
    }
    await writeFile(productionConfigPath, JSON.stringify(productionConfig), "utf8");
    await runGit(root, ["add", "--", "config/experiment.production.json"]);
    await runGit(root, ["commit", "--quiet", "-m", "Bind production source evidence"]);
  }
  await runGit(root, ["remote", "add", "origin", SYNTHETIC_SOURCE_REPOSITORY]);
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("release argument validation", () => {
  it("accepts split and equals forms", () => {
    expect(
      parseCreateReleaseArguments(["--config", "config/site.json", "--output=release/site"]),
    ).toEqual({
      help: false,
      mockRehearsal: false,
      configPath: "config/site.json",
      outputPath: "release/site",
    });
    expect(
      parseCreateReleaseArguments(["--config=config/site.json", "--output", "release/site"]),
    ).toEqual({
      help: false,
      mockRehearsal: false,
      configPath: "config/site.json",
      outputPath: "release/site",
    });
    expect(parseCreateReleaseArguments(["--mock-rehearsal"])).toEqual({
      help: false,
      mockRehearsal: true,
    });
  });

  it("rejects missing, duplicate, and unknown options", () => {
    expect(() => parseCreateReleaseArguments(["--config"])).toThrow("requires a value");
    expect(() => parseCreateReleaseArguments(["--output="])).toThrow("requires a value");
    expect(() => parseCreateReleaseArguments(["--config=a", "--config=b"])).toThrow(
      "only be specified once",
    );
    expect(() => parseCreateReleaseArguments(["--output=a", "--output=b"])).toThrow(
      "only be specified once",
    );
    expect(() => parseCreateReleaseArguments(["--mock-rehearsal", "--mock-rehearsal"])).toThrow(
      "only be specified once",
    );
    expect(() => parseCreateReleaseArguments(["--allow-mock"])).toThrow("Unknown option");
  });
});

describe("deployment manifest verification", () => {
  it("accepts only credential-free Git repository URLs", () => {
    expect(isCredentialFreeSourceRepository("https://github.com/example/project.git")).toBe(true);
    expect(isCredentialFreeSourceRepository("git@github.com:example/project.git")).toBe(true);
    expect(isCredentialFreeSourceRepository("ssh://git@github.com/example/project.git")).toBe(true);
    expect(isCredentialFreeSourceRepository("ssh://alice@github.com/example/project.git")).toBe(false);
    expect(isCredentialFreeSourceRepository("git://alice@github.com/example/project.git")).toBe(false);
    expect(isCredentialFreeSourceRepository("https://alice@github.com/example/project.git")).toBe(false);
  });

  it("creates a sorted manifest and verifies an unchanged release", async () => {
    const { root, manifest } = await createManifestFixture();
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.sourceCommit).toBe(SYNTHETIC_SOURCE_COMMIT);
    expect(manifest.sourceTreeSha256).toBe(fixtureDigest("source-tree"));
    expect(manifest.sourceRepository).toBe(SYNTHETIC_SOURCE_REPOSITORY);
    const fixtureConfig = parseExperimentConfig(configSource());
    expect(manifest.criticalConfigSha256).toBe(hashProductionCriticalConfig(fixtureConfig));
    expect(manifest.goEvidenceSha256).toBe(hashProductionGoEvidence(fixtureConfig));
    expect(manifest.sourceEvidenceBindingSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "app.txt",
      "config/experiment.json",
      "nested/config.txt",
      "package.json",
    ]);
    expect(manifest.files[0]).toEqual({
      path: "app.txt",
      bytes: 5,
      sha256: createHash("sha256").update("alpha").digest("hex"),
    });
    expect(manifest.buildRuntime).toEqual({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    });
    expect(Number.isNaN(Date.parse(manifest.createdAt))).toBe(false);
    await expect(verifyReleaseDirectory(root)).resolves.toEqual([]);
    const manifestSource = await readFile(join(root, RELEASE_MANIFEST_NAME));
    const expectedManifestSha256 = createHash("sha256").update(manifestSource).digest("hex");
    await expect(sha256ReleaseManifest(root)).resolves.toBe(expectedManifestSha256);
    await expect(sha256ReleaseManifest(root)).resolves.toBe(expectedManifestSha256);
    await expect(verifyReleaseDirectoryDetailed(root)).resolves.toEqual({
      errors: [],
      manifestSha256: expectedManifestSha256,
      sourceCommit: SYNTHETIC_SOURCE_COMMIT,
      sourceRepository: SYNTHETIC_SOURCE_REPOSITORY,
      manifest: {
        appVersion: manifest.appVersion,
        protocolVersion: manifest.protocolVersion,
        configHash: manifest.configHash,
        configFileHash: manifest.configFileHash,
        criticalConfigSha256: manifest.criticalConfigSha256,
        goEvidenceSha256: manifest.goEvidenceSha256,
        sourceTreeSha256: manifest.sourceTreeSha256,
        sourceEvidenceBindingSha256: manifest.sourceEvidenceBindingSha256,
      },
    });

    const output: string[] = [];
    await expect(
      runReleaseVerification({
        directory: root,
        writeLine: (line) => output.push(line),
      }),
    ).resolves.toBe(0);
    expect(output).toContain(`Deployment manifest SHA-256: ${expectedManifestSha256}`);
    expect(output).toContain(`Source commit: ${SYNTHETIC_SOURCE_COMMIT}`);
    expect(output).toContain(`App version: ${manifest.appVersion}`);
    expect(output).toContain(`Source tree SHA-256: ${manifest.sourceTreeSha256}`);
    expect(output).toContain(`Source repository: ${SYNTHETIC_SOURCE_REPOSITORY}`);
    expect(output).toContainEqual(expect.stringContaining("結果: PASS"));
  });

  it("rejects a different valid source commit when it no longer matches the evidence binding", async () => {
    const { root, manifest } = await createManifestFixture();
    await writeFile(
      join(root, RELEASE_MANIFEST_NAME),
      `${JSON.stringify({ ...manifest, sourceCommit: "2".repeat(40) }, null, 2)}\n`,
      "utf8",
    );
    await expect(verifyReleaseDirectory(root)).resolves.toContain(
      "Source, application, config, and GO evidence binding SHA-256 mismatch.",
    );
  });

  it.each([
    ["appVersion", "8.8.8"],
    ["sourceCommit", "2".repeat(40)],
    ["sourceTreeSha256", "3".repeat(64)],
    ["criticalConfigSha256", "4".repeat(64)],
    ["goEvidenceSha256", "5".repeat(64)],
  ] as const)("binds %s into the integrated source evidence digest", async (field, value) => {
    const { root, manifest } = await createManifestFixture();
    await writeFile(
      join(root, RELEASE_MANIFEST_NAME),
      `${JSON.stringify({ ...manifest, [field]: value }, null, 2)}\n`,
      "utf8",
    );
    await expect(verifyReleaseDirectory(root)).resolves.toContain(
      "Source, application, config, and GO evidence binding SHA-256 mismatch.",
    );
  });

  it.each(["missing", "invalid"] as const)("rejects a %s source commit", async (variant) => {
    const { root } = await createManifestFixture();
    const manifestPath = join(root, RELEASE_MANIFEST_NAME);
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    if (variant === "missing") {
      delete parsed.sourceCommit;
    } else {
      parsed.sourceCommit = "not-a-full-git-commit";
    }
    await writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    const verification = await verifyReleaseDirectoryDetailed(root);
    expect(verification.errors).toEqual(["Deployment manifest has an invalid structure."]);
    expect(verification.sourceCommit).toBeNull();
    expect(verification.manifest).toBeNull();
    expect(verification.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("detects controlled file modification even when its byte length is unchanged", async () => {
    const { root } = await createManifestFixture();
    await writeRelative(root, "app.txt", "omega");
    const errors = await verifyReleaseDirectory(root);
    expect(errors).toContain("SHA-256 mismatch: app.txt");
    expect(errors.some((error) => error.startsWith("Size mismatch"))).toBe(false);
  });

  it("rejects hard-linked files during both manifest creation and verification", async () => {
    const verificationFixture = await createManifestFixture();
    await link(
      join(verificationFixture.root, "app.txt"),
      join(verificationFixture.root, "hardlink-alias.txt"),
    );
    await expect(verifyReleaseDirectory(verificationFixture.root)).resolves.toContain(
      "Hard-linked controlled file is not allowed: app.txt",
    );

    const creationFixture = await createManifestFixture();
    await rm(join(creationFixture.root, RELEASE_MANIFEST_NAME));
    await link(
      join(creationFixture.root, "app.txt"),
      join(creationFixture.root, "hardlink-alias.txt"),
    );
    await expect(createReleaseManifest(creationFixture.root, {
      appVersion: creationFixture.manifest.appVersion,
      protocolVersion: creationFixture.manifest.protocolVersion,
      configHash: creationFixture.manifest.configHash,
      configFileHash: creationFixture.manifest.configFileHash,
      sourceCommit: creationFixture.manifest.sourceCommit,
      sourceTreeSha256: creationFixture.manifest.sourceTreeSha256,
      ...(creationFixture.manifest.sourceRepository === undefined
        ? {}
        : { sourceRepository: creationFixture.manifest.sourceRepository }),
    })).rejects.toThrow("must be a unique regular file");
  });

  it("detects a modified digest inside an otherwise valid manifest", async () => {
    const { root, manifest } = await createManifestFixture();
    const modified: ReleaseManifest = {
      ...manifest,
      files: manifest.files.map((file, index) =>
        index === 0 ? { ...file, sha256: "0".repeat(64) } : file,
      ),
    };
    await writeFile(
      join(root, RELEASE_MANIFEST_NAME),
      `${JSON.stringify(modified, null, 2)}\n`,
      "utf8",
    );
    await expect(verifyReleaseDirectory(root)).resolves.toContain("SHA-256 mismatch: app.txt");
  });

  it("binds manifest semantic hash and protocolVersion to the packaged config", async () => {
    const semanticFixture = await createManifestFixture();
    const semanticManifest: ReleaseManifest = {
      ...semanticFixture.manifest,
      configHash: "0".repeat(64),
    };
    await writeFile(
      join(semanticFixture.root, RELEASE_MANIFEST_NAME),
      `${JSON.stringify(semanticManifest, null, 2)}\n`,
      "utf8",
    );
    await expect(verifyReleaseDirectory(semanticFixture.root)).resolves.toContain(
      "Config semantic SHA-256 mismatch: config/experiment.json",
    );

    const protocolFixture = await createManifestFixture();
    const protocolManifest: ReleaseManifest = {
      ...protocolFixture.manifest,
      protocolVersion: "different-protocol-v1",
    };
    await writeFile(
      join(protocolFixture.root, RELEASE_MANIFEST_NAME),
      `${JSON.stringify(protocolManifest, null, 2)}\n`,
      "utf8",
    );
    await expect(verifyReleaseDirectory(protocolFixture.root)).resolves.toContain(
      `Config protocolVersion mismatch: expected different-protocol-v1, got ${SCREEN_PROTOCOL_VERSION}`,
    );
  });

  it("binds manifest appVersion to the controlled package.json", async () => {
    const { root, manifest } = await createManifestFixture();
    await writeFile(
      join(root, RELEASE_MANIFEST_NAME),
      `${JSON.stringify({ ...manifest, appVersion: "8.8.8" }, null, 2)}\n`,
      "utf8",
    );
    await expect(verifyReleaseDirectory(root)).resolves.toContain(
      "Package appVersion mismatch: expected 8.8.8, got 9.8.7.",
    );
  });

  it("rejects a rehashed packaged config when its approved semantics changed", async () => {
    const { root, manifest } = await createManifestFixture();
    const changedSource = JSON.stringify({
      ...configSource(),
      studyTitle: "unapproved semantic change",
    });
    const changedHash = createHash("sha256").update(changedSource).digest("hex");
    await writeFile(join(root, "config", "experiment.json"), changedSource, "utf8");
    const modified: ReleaseManifest = {
      ...manifest,
      configFileHash: changedHash,
      files: manifest.files.map((file) =>
        file.path === "config/experiment.json"
          ? { ...file, bytes: Buffer.byteLength(changedSource), sha256: changedHash }
          : file,
      ),
    };
    await writeFile(
      join(root, RELEASE_MANIFEST_NAME),
      `${JSON.stringify(modified, null, 2)}\n`,
      "utf8",
    );

    const errors = await verifyReleaseDirectory(root);
    expect(errors).toContain("Config semantic SHA-256 mismatch: config/experiment.json");
    expect(errors).not.toContain("Config file SHA-256 mismatch: config/experiment.json");
  });

  it("detects unexpected and missing controlled files", async () => {
    const extraFixture = await createManifestFixture();
    await writeRelative(extraFixture.root, "unexpected.txt", "unexpected");
    await expect(verifyReleaseDirectory(extraFixture.root)).resolves.toContain(
      "Unexpected controlled file: unexpected.txt",
    );

    const missingFixture = await createManifestFixture();
    await rm(join(missingFixture.root, "nested", "config.txt"));
    const missingErrors = await verifyReleaseDirectory(missingFixture.root);
    expect(
      missingErrors.some((error) =>
        error.startsWith("Missing or unreadable file: nested/config.txt"),
      ),
    ).toBe(true);
  });

  it("rejects unreadable JSON and unsafe manifest paths", async () => {
    const malformed = await createManifestFixture();
    await writeFile(join(malformed.root, RELEASE_MANIFEST_NAME), "not-json\n", "utf8");
    expect((await verifyReleaseDirectory(malformed.root))[0]).toContain(
      "Deployment manifest could not be read",
    );

    const unsafe = await createManifestFixture();
    const parsed = JSON.parse(
      await readFile(join(unsafe.root, RELEASE_MANIFEST_NAME), "utf8"),
    ) as ReleaseManifest;
    const unsafeManifest: ReleaseManifest = {
      ...parsed,
      files: [{ ...parsed.files[0]!, path: "../escape.txt" }],
    };
    await writeFile(
      join(unsafe.root, RELEASE_MANIFEST_NAME),
      `${JSON.stringify(unsafeManifest, null, 2)}\n`,
      "utf8",
    );
    await expect(verifyReleaseDirectory(unsafe.root)).resolves.toEqual([
      "Deployment manifest has an invalid structure.",
    ]);
  });
});

describe("release creation", () => {
  it("reports the clean HEAD values required for independent release review", async () => {
    const root = await createReleaseSource();
    const summary = await inspectProductionSourceEvidence(root);
    const config = parseExperimentConfig(
      JSON.parse(
        await readFile(join(root, "config", "experiment.production.json"), "utf8"),
      ) as unknown,
    );
    expect(summary).toEqual({
      appVersion: "9.8.7",
      criticalConfigSha256: hashProductionCriticalConfig(config),
      pilotConfigFileHash: config.goEvidence?.screenPilot.pilotConfigFileHash,
      sourceCommit: await runGit(root, ["rev-parse", "HEAD"]),
      sourceTreeSha256: config.goEvidence?.releaseVerification.sourceTreeSha256,
    });
  });

  it.each([
    ["build artifacts", { buildArtifacts: false }, "may not reuse existing build artifacts"],
    [
      "dependency installation",
      { installDependencies: false },
      "may not omit lockfile-pinned dependency installation",
    ],
  ] as const)("never lets production tests omit %s", async (_label, override, message) => {
    const root = await createReleaseSource();
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/unsafe-shortcut",
        ...override,
        writeLine: () => undefined,
      }),
    ).rejects.toThrow(message);
    expect(await pathExists(join(root, "release", "unsafe-shortcut"))).toBe(false);
  });

  it("rejects a dirty Git worktree before producing output", async () => {
    const root = await createReleaseSource();
    await writeRelative(root, "untracked-after-commit.txt", "not sealed\n");
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/dirty",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("worktree must be clean");
    expect(await pathExists(join(root, "release", "dirty"))).toBe(false);
  });

  it("requires the exact tracked production config path, even for an ignored candidate", async () => {
    const root = await createReleaseSource();
    const approvedBytes = await readFile(
      join(root, "config", "experiment.production.json"),
      "utf8",
    );
    await writeRelative(root, "config/experiment.production.json.ignored-config", approvedBytes);
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json.ignored-config",
        outputPath: "release/alternate-config",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("fixed tracked config path config/experiment.production.json");
  });

  it("rejects an untracked fixed-path production config", async () => {
    const root = await createReleaseSource();
    await runGit(root, ["rm", "--cached", "--", "config/experiment.production.json"]);
    const ignoreSource = await readFile(join(root, ".gitignore"), "utf8");
    await writeRelative(
      root,
      ".gitignore",
      `${ignoreSource}config/experiment.production.json\n`,
    );
    await runGit(root, ["add", "--", ".gitignore"]);
    await runGit(root, ["commit", "--quiet", "-m", "Ignore untracked production config"]);

    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/untracked-config",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("Production config must be tracked by Git");
  });

  it("rejects production config bytes that differ from HEAD even when Git status hides them", async () => {
    const root = await createReleaseSource();
    await runGit(root, [
      "update-index",
      "--assume-unchanged",
      "--",
      "config/experiment.production.json",
    ]);
    const configPath = join(root, "config", "experiment.production.json");
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    parsed["studyTitle"] = "HEADと異なる隠れた設定";
    await writeFile(configPath, JSON.stringify(parsed), "utf8");

    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/head-mismatch",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("must exactly match the config tracked by the recorded source commit");
  });

  it("invalidates old release evidence after any other tracked source change", async () => {
    const root = await createReleaseSource();
    await writeRelative(root, "src/after-review.ts", "export const changedAfterReview = true;\n");
    await runGit(root, ["add", "--", "src/after-review.ts"]);
    await runGit(root, ["commit", "--quiet", "-m", "Change code after approval"]);

    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/stale-evidence",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("goEvidence.releaseVerification.sourceTreeSha256");
  });

  it("rejects a pilot config whose tracked bytes differ from the approved pilot hash", async () => {
    const root = await createReleaseSource();
    const pilotConfigPath = join(root, "config", "experiment.screen-pilot.json");
    await writeFile(
      pilotConfigPath,
      `${JSON.stringify({ fixture: "changed-screen-pilot", protocolVersion: SCREEN_PROTOCOL_VERSION })}\n`,
      "utf8",
    );
    await runGit(root, ["add", "--", "config/experiment.screen-pilot.json"]);
    await runGit(root, ["commit", "--quiet", "-m", "Change pilot config after approval"]);

    const sourceCommit = await runGit(root, ["rev-parse", "HEAD"]);
    const sourceTreeSha256 = await hashTrackedSourceTreeAtCommit(root, sourceCommit);
    const productionConfigPath = join(root, "config", "experiment.production.json");
    const productionConfig = JSON.parse(
      await readFile(productionConfigPath, "utf8"),
    ) as Record<string, unknown>;
    const goEvidence = productionConfig["goEvidence"] as Record<string, unknown>;
    const releaseVerification = goEvidence["releaseVerification"] as Record<string, unknown>;
    const screenPilot = goEvidence["screenPilot"] as Record<string, unknown>;
    releaseVerification["sourceTreeSha256"] = sourceTreeSha256;
    screenPilot["sourceTreeSha256"] = sourceTreeSha256;
    await writeFile(productionConfigPath, JSON.stringify(productionConfig), "utf8");
    await runGit(root, ["add", "--", "config/experiment.production.json"]);
    await runGit(root, ["commit", "--quiet", "-m", "Refresh tree evidence only"]);

    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/stale-pilot-config",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("goEvidence.screenPilot.pilotConfigFileHash");
  });

  it("compares approved appVersion with the package.json at HEAD", async () => {
    const root = await createReleaseSource();
    const packagePath = join(root, "package.json");
    const packageSource = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    packageSource["version"] = "9.8.8";
    await writeFile(packagePath, JSON.stringify(packageSource), "utf8");
    await runGit(root, ["add", "--", "package.json"]);
    await runGit(root, ["commit", "--quiet", "-m", "Change application version"]);

    const sourceCommit = await runGit(root, ["rev-parse", "HEAD"]);
    const sourceTreeSha256 = await hashTrackedSourceTreeAtCommit(root, sourceCommit);
    const configPath = join(root, "config", "experiment.production.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const releaseVerification = (
      (config["goEvidence"] as Record<string, unknown>)["releaseVerification"]
    ) as Record<string, unknown>;
    releaseVerification["sourceTreeSha256"] = sourceTreeSha256;
    const screenPilot = (
      (config["goEvidence"] as Record<string, unknown>)["screenPilot"]
    ) as Record<string, unknown>;
    screenPilot["sourceTreeSha256"] = sourceTreeSha256;
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await runGit(root, ["add", "--", "config/experiment.production.json"]);
    await runGit(root, ["commit", "--quiet", "-m", "Refresh source tree only"]);

    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/stale-version",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("goEvidence.releaseVerification.appVersion");
  });

  it("excludes only the exact production config path from the tracked source digest", async () => {
    const root = await createReleaseSource();
    const initialCommit = await runGit(root, ["rev-parse", "HEAD"]);
    const initialDigest = await hashTrackedSourceTreeAtCommit(root, initialCommit);

    const configPath = join(root, "config", "experiment.production.json");
    const configSource = await readFile(configPath, "utf8");
    await writeFile(configPath, `${configSource}\n`, "utf8");
    await runGit(root, ["add", "--", "config/experiment.production.json"]);
    await runGit(root, ["commit", "--quiet", "-m", "Change excluded config bytes"]);
    const configOnlyCommit = await runGit(root, ["rev-parse", "HEAD"]);
    await expect(hashTrackedSourceTreeAtCommit(root, configOnlyCommit)).resolves.toBe(initialDigest);

    await writeRelative(root, "config/experiment.production.json.bak", "tracked near-match\n");
    await runGit(root, ["add", "--", "config/experiment.production.json.bak"]);
    await runGit(root, ["commit", "--quiet", "-m", "Add similarly named tracked file"]);
    const nearMatchCommit = await runGit(root, ["rev-parse", "HEAD"]);
    await expect(hashTrackedSourceTreeAtCommit(root, nearMatchCommit)).resolves.not.toBe(
      initialDigest,
    );
  });

  it("requires live Google Form verification when createRelease is called directly", async () => {
    const root = await createReleaseSource();
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount += 1;
      throw new Error("live form unavailable");
    });
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/no-live-form",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("live form unavailable");
    expect(fetchCount).toBe(1);
    expect(await pathExists(join(root, "release", "no-live-form"))).toBe(false);
  });

  it.each([
    ["Mock device", { mode: "mock", serialPath: "" } satisfies ConfigOverrides, "device.mode"],
    ["Serial device", { mode: "serial", serialPath: "COM3" } satisfies ConfigOverrides, "device.mode"],
    [
      "arbitrary protocol",
      { protocolVersion: "arbitrary-screen-v2" } satisfies ConfigOverrides,
      "protocolVersion",
    ],
    [
      "production Mock permission",
      { allowMockInProduction: true } satisfies ConfigOverrides,
      "device.allowMockInProduction",
    ],
    ["missing approved form", { formUrl: "" } satisfies ConfigOverrides, "formUrl"],
    [
      "external runtime requests",
      { allowExternalRuntimeRequests: true } satisfies ConfigOverrides,
      "allowExternalRuntimeRequests",
    ],
  ])("rejects %s before producing output", async (_label, overrides, expectedFailure) => {
    const root = await createReleaseSource(overrides);
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/rejected",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow(expectedFailure);
    expect(await pathExists(join(root, "release", "rejected"))).toBe(false);
  });

  it("never treats a Mock rehearsal config as production without explicit opt-in", async () => {
    const root = await createReleaseSource();
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/site-mock-rehearsal.json",
        outputPath: "release/not-production",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("fixed tracked config path");
    expect(await pathExists(join(root, "release", "not-production"))).toBe(false);
  });

  it("never treats a production config as an opted-in Mock rehearsal", async () => {
    const root = await createReleaseSource();
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/not-mock",
        releaseKind: "mock-rehearsal",
        buildArtifacts: false,
        installDependencies: false,
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("Mock rehearsal preflight failed: device.mode");
    expect(await pathExists(join(root, "release", "not-mock"))).toBe(false);
  });

  it.each([
    [
      "LAN binding",
      { bindHost: "0.0.0.0", allowLan: true } satisfies ConfigOverrides,
      "bindHost, network.allowLan",
    ],
    ["a configured form", { formUrl: STUDY_FORM_URL } satisfies ConfigOverrides, "formUrl"],
    [
      "the production log directory",
      { loggingDirectory: "./data/sessions" } satisfies ConfigOverrides,
      "logging.directory",
    ],
    [
      "external runtime requests",
      { allowExternalRuntimeRequests: true } satisfies ConfigOverrides,
      "allowExternalRuntimeRequests",
    ],
    [
      "production Mock permission",
      { allowMockInProduction: true } satisfies ConfigOverrides,
      "device.allowMockInProduction",
    ],
    [
      "a non-demo ID pattern",
      { researchIdPattern: "^SH26-[0-9]{3}$" } satisfies ConfigOverrides,
      "researchIdPattern",
    ],
  ])("rejects Mock rehearsal packaging with %s", async (_label, overrides, expectedFailure) => {
    const root = await createReleaseSource(overrides);
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/site-mock-rehearsal.json",
        outputPath: "release/rejected-mock",
        releaseKind: "mock-rehearsal",
        buildArtifacts: false,
        installDependencies: false,
        writeLine: () => undefined,
      }),
    ).rejects.toThrow(expectedFailure);
    expect(await pathExists(join(root, "release", "rejected-mock"))).toBe(false);
  });

  it("creates a separately named sealed Mock rehearsal payload", async () => {
    const root = await createReleaseSource();
    const outputLines: string[] = [];
    const output = await createRelease({
      rootDirectory: root,
      configPath: "config/site-mock-rehearsal.json",
      releaseKind: "mock-rehearsal",
      buildArtifacts: false,
      installDependencies: false,
      writeLine: (line) => outputLines.push(line),
    });

    expect(basename(output)).toMatch(/^sechack-mock-rehearsal-9\.8\.7-/u);
    expect(await listFiles(output)).toEqual(
      [
        ".npmrc",
        "CHECK_MOCK_HEALTH.cmd",
        "config/experiment.mock-rehearsal.json",
        "data/mock-sessions/.gitkeep",
        "DEPLOYMENT_MANIFEST.json",
        "dist/assets/app.css",
        "dist/assets/app.js",
        "dist/index.html",
        "dist-server/healthcheck.js",
        "dist-server/rehearsal.js",
        "dist-server/verify-release.js",
        "package-lock.json",
        "package.json",
        "START_MOCK_DEMO.cmd",
        "VERIFY_MOCK_RELEASE.cmd",
      ].sort((left, right) => left.localeCompare(right)),
    );

    const releasedConfig = JSON.parse(
      await readFile(join(output, "config", "experiment.mock-rehearsal.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(releasedConfig).toEqual(mockRehearsalConfigSource());
    const runtimePackage = JSON.parse(
      await readFile(join(output, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimePackage.scripts).toEqual({
      healthcheck:
        "node dist-server/healthcheck.js --mock-rehearsal --config config/experiment.mock-rehearsal.json",
      "release:verify": "node dist-server/verify-release.js",
      start:
        "node dist-server/verify-release.js && node dist-server/rehearsal.js --mock-rehearsal",
    });
    expect(await verifyReleaseDirectory(output)).toEqual([]);

    const launcher = await readFile(join(output, "START_MOCK_DEMO.cmd"), "utf8");
    expect(launcher).toContain(
      "EXPERIMENT_CONFIG_PATH=config\\experiment.mock-rehearsal.json",
    );
    expect(launcher).toContain("DATA_DIRECTORY=data\\mock-sessions");
    expect(launcher).toContain("http://127.0.0.1:4173/operator");
    expect(launcher).toContain("dist-server\\healthcheck.js");
    expect(launcher).toContain("--mock-rehearsal --config");
    expect(launcher).not.toContain("Invoke-WebRequest");
    expect(launcher).toContain("Start-Process $operator");
    expect(launcher).toContain("Press Ctrl+C once");
    expect(launcher).toContain("node dist-server\\rehearsal.js --mock-rehearsal");
    expect(launcher).not.toContain("START_PRODUCTION");
    expect(launcher).not.toContain('start "SecHack Mock Rehearsal Server"');
    expect(launcher.indexOf("node dist-server\\verify-release.js")).toBeLessThan(
      launcher.indexOf("node dist-server\\rehearsal.js --mock-rehearsal"),
    );
    expect(launcher.indexOf("dist-server\\healthcheck.js")).toBeLessThan(
      launcher.indexOf("node dist-server\\rehearsal.js --mock-rehearsal"),
    );
    expect(outputLines).toContainEqual(expect.stringContaining("Mock rehearsal release created"));
    expect(outputLines).toContainEqual(
      expect.stringContaining("not a production research release"),
    );
  });

  it("creates only the approved offline payload and a self-consistent manifest", async () => {
    const root = await createReleaseSource();
    vi.stubGlobal("fetch", approvedFormFetch);
    const sourceCommit = await runGit(root, ["rev-parse", "HEAD"]);
    const sourceConfigBytes = await readFile(
      join(root, "config", "experiment.production.json"),
    );
    const outputLines: string[] = [];
    const output = await createRelease({
      rootDirectory: root,
      configPath: "config/experiment.production.json",
      outputPath: "release/approved",
      writeLine: (line) => outputLines.push(line),
    });
    expect(output).toBe(join(root, "release", "approved"));

    const actualFiles = await listFiles(output);
    expect(actualFiles).toEqual(
      [
        ".npmrc",
        "CHECK_HEALTH.cmd",
        "config/experiment.json",
        "data/.gitkeep",
        "DEPLOYMENT.md",
        "DEPLOYMENT_MANIFEST.json",
        "dist/assets/app.css",
        "dist/assets/app.js",
        "dist/index.html",
        "dist-server/healthcheck.js",
        "dist-server/index.js",
        "dist-server/preflight.js",
        "dist-server/verify-release.js",
        "docs/DATA_LIFECYCLE.md",
        "docs/DEVICE_PROTOCOL.md",
        "docs/DEPLOYMENT.md",
        "docs/EXPERIMENT_SPEC.md",
        "docs/FORM_AUDIT.md",
        "docs/FORM_RELEASE_GATE.md",
        "docs/FORM_OWNER_FIX_GUIDE.md",
        "docs/GO_EVIDENCE.md",
        "docs/MOCK_REHEARSAL.md",
        "docs/PROTOCOL_CHANGELOG.md",
        "docs/PUBLIC_DEMO.md",
        "docs/RELEASE_CHECKLIST.md",
        "docs/RUNBOOK.md",
        "docs/TEST_REPORT.md",
        "docs/UI_COPY.md",
        "package-lock.json",
        "package.json",
        "START_PRODUCTION.cmd",
        "VERIFY_RELEASE.cmd",
      ].sort((left, right) => left.localeCompare(right)),
    );

    const releasedConfig = JSON.parse(
      await readFile(join(output, "config", "experiment.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(releasedConfig).toEqual(JSON.parse(sourceConfigBytes.toString("utf8")) as unknown);
    await expect(readFile(join(output, "config", "experiment.json"))).resolves.toEqual(
      sourceConfigBytes,
    );
    const runtimePackage = JSON.parse(
      await readFile(join(output, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimePackage.scripts).toEqual({
      preflight: "node dist-server/preflight.js",
      healthcheck: "node dist-server/healthcheck.js",
      "release:verify": "node dist-server/verify-release.js",
      start:
        "node dist-server/verify-release.js && node dist-server/preflight.js && node dist-server/index.js",
    });

    const manifest = JSON.parse(
      await readFile(join(output, RELEASE_MANIFEST_NAME), "utf8"),
    ) as ReleaseManifest;
    expect(manifest.appVersion).toBe("9.8.7");
    expect(manifest.protocolVersion).toBe(SCREEN_PROTOCOL_VERSION);
    expect(manifest.configFileHash).toBe(
      createHash("sha256").update(sourceConfigBytes).digest("hex"),
    );
    expect(manifest.configHash).toBe(hashExperimentConfig(parseExperimentConfig(releasedConfig)));
    expect(manifest.sourceCommit).toBe(sourceCommit);
    expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(manifest.sourceTreeSha256).toBe(
      ((releasedConfig["goEvidence"] as Record<string, unknown>)[
        "releaseVerification"
      ] as Record<string, unknown>)["sourceTreeSha256"],
    );
    expect(manifest.sourceRepository).toBe(SYNTHETIC_SOURCE_REPOSITORY);
    expect(manifest.files.some((file) => file.path.startsWith("data/"))).toBe(false);
    expect(await verifyReleaseDirectory(output)).toEqual([]);
    const manifestSha256 = await sha256ReleaseManifest(output);
    expect(outputLines).toContain(`Source commit: ${sourceCommit}`);
    expect(outputLines).toContain(`App version: ${manifest.appVersion}`);
    expect(outputLines).toContain(`Source tree SHA-256: ${manifest.sourceTreeSha256}`);
    expect(outputLines).toContain(`Source repository: ${SYNTHETIC_SOURCE_REPOSITORY}`);
    expect(outputLines).toContain(`Deployment manifest SHA-256: ${manifestSha256}`);

    const launcher = await readFile(join(output, "START_PRODUCTION.cmd"), "utf8");
    expect(launcher).not.toContain("--allow-mock");
    expect(launcher).not.toContain("EXPERIMENT_CONFIG_PATH");
    expect(launcher).not.toContain("DATA_DIRECTORY");
    expect(launcher).toContain('if not exist "%ProgramFiles%\\nodejs\\node.exe"');
    expect(launcher).not.toMatch(/(?:^|\r?\n)node /u);
    expect(launcher.indexOf("verify-release.js")).toBeLessThan(launcher.indexOf("preflight.js"));
    expect(launcher.indexOf("preflight.js")).toBeLessThan(
      launcher.indexOf("dist-server\\index.js"),
    );
    const healthLauncher = await readFile(join(output, "CHECK_HEALTH.cmd"), "utf8");
    expect(healthLauncher).toContain('set "NODE_OPTIONS="');
    expect(healthLauncher).toContain('set "NODE_PATH="');
    expect(healthLauncher).toContain('"%ProgramFiles%\\nodejs\\node.exe"');
    expect(healthLauncher).not.toMatch(/(?:^|\r?\n)node /u);
    const verifyLauncher = await readFile(join(output, "VERIFY_RELEASE.cmd"), "utf8");
    expect(verifyLauncher).toContain('"%ProgramFiles%\\nodejs\\node.exe"');
    expect(verifyLauncher).not.toMatch(/(?:^|\r?\n)node /u);
  });

  it("rejects output outside or below a nested release path and never overwrites an existing release", async () => {
    const root = await createReleaseSource();
    vi.stubGlobal("fetch", approvedFormFetch);
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "outside-release",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("must be a direct child directory of release");

    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/nested/output",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("must be a direct child directory of release");
    expect(await pathExists(join(root, "release", "nested"))).toBe(false);

    const existingOutput = join(root, "release", "approved");
    await mkdir(existingOutput, { recursive: true });
    await writeFile(join(existingOutput, "sentinel.txt"), "preserve me", "utf8");
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/experiment.production.json",
        outputPath: "release/approved",
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("Release output already exists");
    await expect(readFile(join(existingOutput, "sentinel.txt"), "utf8")).resolves.toBe(
      "preserve me",
    );
    expect(
      (await readdir(join(root, "release"))).filter((name) => name.startsWith(".staging-")),
    ).toEqual([]);
  });
});
