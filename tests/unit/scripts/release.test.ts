import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createRelease, parseCreateReleaseArguments } from "../../../scripts/create-release.js";
import {
  createReleaseManifest,
  RELEASE_MANIFEST_NAME,
  sha256ReleaseManifest,
  verifyReleaseDirectory,
  verifyReleaseDirectoryDetailed,
  writeReleaseManifest,
  type ReleaseManifest,
} from "../../../scripts/release-manifest.js";
import { runReleaseVerification } from "../../../scripts/verify-release.js";

interface ConfigOverrides {
  readonly mode?: "mock" | "serial";
  readonly serialPath?: string;
  readonly allowMockInProduction?: boolean;
  readonly formUrl?: string;
  readonly allowExternalRuntimeRequests?: boolean;
}

const execFileAsync = promisify(execFile);
const SYNTHETIC_SOURCE_COMMIT = "1".repeat(40);
const SYNTHETIC_SOURCE_REPOSITORY = "https://github.com/example/sechack-release-fixture.git";
const STUDY_FORM_URL = "https://forms.gle/BeShY7cY5zMjunto9";

function configSource(overrides: ConfigOverrides = {}): Record<string, unknown> {
  const mode = overrides.mode ?? "serial";
  const formUrl = overrides.formUrl ?? STUDY_FORM_URL;
  return {
    schemaVersion: 1,
    protocolVersion: "release-test-v1",
    studyTitle: "リリース合成設定",
    bindHost: "127.0.0.1",
    port: 4173,
    researchIdPattern: "^TEST-[0-9]{3}$",
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
      status: "GO",
      protocolVersion: "release-test-v1",
      formUrl,
      auditedOn: new Date().toISOString().slice(0, 10),
      contentSha256: "c".repeat(64),
      twoPersonVerified: true,
    },
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: {
      allowLan: false,
      allowExternalRuntimeRequests: overrides.allowExternalRuntimeRequests ?? false,
    },
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
  await writeRelative(root, "data/sessions/runtime.jsonl", "ignored runtime data");
  const manifest = await createReleaseManifest(root, {
    appVersion: "9.8.7",
    protocolVersion: "release-test-v1",
    configHash: "a".repeat(64),
    configFileHash: "b".repeat(64),
    sourceCommit: SYNTHETIC_SOURCE_COMMIT,
    sourceRepository: SYNTHETIC_SOURCE_REPOSITORY,
  });
  await writeReleaseManifest(root, manifest);
  return { root, manifest };
}

async function createReleaseSource(overrides: ConfigOverrides = {}): Promise<string> {
  const root = await newTemporaryRoot("sechack-release-");
  await writeRelative(root, ".gitignore", "release/\n");
  await writeRelative(root, "config/site-production.json", JSON.stringify(configSource(overrides)));
  await writeRelative(root, "config/experiment.e2e.json", "must not be released");
  await writeRelative(root, "data/sessions/synthetic.jsonl", "must not be released");
  await writeRelative(root, "tests/private-fixture.txt", "must not be released");
  await writeRelative(root, "artifacts/test-results/trace.zip", "must not be released");
  await writeRelative(root, ".env", "SECRET=must-not-be-released");

  await writeRelative(root, "dist/index.html", "<!doctype html><title>release test</title>");
  await writeRelative(root, "dist/assets/app.js", "console.info('synthetic client');");
  await writeRelative(root, "dist/assets/app.css", "body { color: black; }");
  await writeRelative(root, "dist/assets/app.js.map", "must not be released");
  for (const name of ["index", "preflight", "healthcheck", "verify-release"] as const) {
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
      dependencies: {
        "intentionally-not-installed.invalid": "1.0.0",
      },
    }),
  );
  // Intentionally not a usable lockfile: release creation can only succeed when
  // installDependencies:false really avoids npm and all external resolution.
  await writeRelative(root, "package-lock.json", "synthetic offline lockfile\n");
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.name", "Release Fixture"]);
  await runGit(root, ["config", "user.email", "release-fixture@example.invalid"]);
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "--quiet", "-m", "Create release fixture"]);
  await runGit(root, ["remote", "add", "origin", SYNTHETIC_SOURCE_REPOSITORY]);
  return root;
}

afterEach(async () => {
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
      configPath: "config/site.json",
      outputPath: "release/site",
    });
    expect(
      parseCreateReleaseArguments(["--config=config/site.json", "--output", "release/site"]),
    ).toEqual({
      help: false,
      configPath: "config/site.json",
      outputPath: "release/site",
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
    expect(() => parseCreateReleaseArguments(["--allow-mock"])).toThrow("Unknown option");
  });
});

describe("deployment manifest verification", () => {
  it("creates a sorted manifest and verifies an unchanged release", async () => {
    const { root, manifest } = await createManifestFixture();
    expect(manifest.files.map((file) => file.path)).toEqual(["app.txt", "nested/config.txt"]);
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

    const output: string[] = [];
    await expect(
      runReleaseVerification({
        directory: root,
        writeLine: (line) => output.push(line),
      }),
    ).resolves.toBe(0);
    expect(output).toEqual([expect.stringContaining("結果: PASS")]);
  });

  it("detects controlled file modification even when its byte length is unchanged", async () => {
    const { root } = await createManifestFixture();
    await writeRelative(root, "app.txt", "omega");
    const errors = await verifyReleaseDirectory(root);
    expect(errors).toContain("SHA-256 mismatch: app.txt");
    expect(errors.some((error) => error.startsWith("Size mismatch"))).toBe(false);
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
  it.each([
    ["Mock device", { mode: "mock", serialPath: "" } satisfies ConfigOverrides, "device.mode"],
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
        configPath: "config/site-production.json",
        outputPath: "release/rejected",
        installDependencies: false,
        writeLine: () => undefined,
      }),
    ).rejects.toThrow(expectedFailure);
    expect(await pathExists(join(root, "release", "rejected"))).toBe(false);
  });

  it("creates only the approved offline payload and a self-consistent manifest", async () => {
    const root = await createReleaseSource();
    const output = await createRelease({
      rootDirectory: root,
      configPath: "config/site-production.json",
      outputPath: "release/approved",
      installDependencies: false,
      writeLine: () => undefined,
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
        "docs/DEVICE_PROTOCOL.md",
        "docs/EXPERIMENT_SPEC.md",
        "docs/FORM_AUDIT.md",
        "docs/PROTOCOL_CHANGELOG.md",
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
    expect(releasedConfig).toEqual(configSource());
    const runtimePackage = JSON.parse(
      await readFile(join(output, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimePackage.scripts).toEqual({
      preflight: "node dist-server/preflight.js",
      healthcheck: "node dist-server/healthcheck.js",
      "release:verify": "node dist-server/verify-release.js",
      start: "node dist-server/index.js",
    });

    const manifest = JSON.parse(
      await readFile(join(output, RELEASE_MANIFEST_NAME), "utf8"),
    ) as ReleaseManifest;
    expect(manifest.appVersion).toBe("9.8.7");
    expect(manifest.protocolVersion).toBe("release-test-v1");
    expect(manifest.files.some((file) => file.path.startsWith("data/"))).toBe(false);
    expect(await verifyReleaseDirectory(output)).toEqual([]);

    const launcher = await readFile(join(output, "START_PRODUCTION.cmd"), "utf8");
    expect(launcher).not.toContain("--allow-mock");
    expect(launcher.indexOf("verify-release.js")).toBeLessThan(launcher.indexOf("preflight.js"));
    expect(launcher.indexOf("preflight.js")).toBeLessThan(
      launcher.indexOf("dist-server\\index.js"),
    );
  });

  it("rejects output outside release and never overwrites an existing release", async () => {
    const root = await createReleaseSource();
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/site-production.json",
        outputPath: "outside-release",
        installDependencies: false,
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("must be a child directory of release");

    const existingOutput = join(root, "release", "approved");
    await mkdir(existingOutput, { recursive: true });
    await writeFile(join(existingOutput, "sentinel.txt"), "preserve me", "utf8");
    await expect(
      createRelease({
        rootDirectory: root,
        configPath: "config/site-production.json",
        outputPath: "release/approved",
        installDependencies: false,
        writeLine: () => undefined,
      }),
    ).rejects.toThrow();
    await expect(readFile(join(existingOutput, "sentinel.txt"), "utf8")).resolves.toBe(
      "preserve me",
    );
    expect(
      (await readdir(join(root, "release"))).filter((name) => name.startsWith(".staging-")),
    ).toEqual([]);
  });
});
