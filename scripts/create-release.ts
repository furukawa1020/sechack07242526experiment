import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { collectPreflightReport, type PreflightReport } from "./preflight.js";
import { fetchPublicFormAudit } from "./audit-public-form.js";
import {
  createReleaseManifest,
  isCredentialFreeSourceRepository,
  verifyReleaseDirectoryDetailed,
  writeReleaseManifest,
} from "./release-manifest.js";
import {
  assessReleaseFormVerification,
  renderReleaseFormVerification,
  verifyReleaseForm,
} from "./verify-release-form.js";
import { loadExperimentConfig } from "../src/shared/config-loader.js";
import {
  SCREEN_PRODUCTION_FIXED_STATE,
  SCREEN_PRODUCTION_RESEARCH_ID_PATTERN,
} from "../src/shared/production-policy.js";
import { SCREEN_PROTOCOL_VERSION } from "../src/shared/schemas.js";
import { acquireBuildLock } from "./build-lock.mjs";

const DEFAULT_CONFIG_PATH = "config/experiment.production.json";
const DEFAULT_MOCK_REHEARSAL_CONFIG_PATH = "config/experiment.mock-rehearsal.json";
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export type ReleaseKind = "production" | "mock-rehearsal";

interface SourceProvenance {
  readonly sourceCommit: string;
  readonly sourceRepository?: string;
}

interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface CreateReleaseArguments {
  readonly configPath?: string;
  readonly help: boolean;
  readonly mockRehearsal: boolean;
  readonly outputPath?: string;
}

export interface CreateReleaseOptions {
  readonly rootDirectory?: string;
  readonly configPath?: string;
  readonly outputPath?: string;
  readonly releaseKind?: ReleaseKind;
  /** Tests may reuse synthetic build fixtures; the CLI always rebuilds before sealing. */
  readonly buildArtifacts?: boolean;
  /** Tests may disable dependency installation; the CLI always installs production dependencies. */
  readonly installDependencies?: boolean;
  readonly writeLine?: (line: string) => void;
}

export interface RunCreateReleaseDependencies {
  readonly verifyReleaseForm?: typeof verifyReleaseForm;
  readonly createRelease?: typeof createRelease;
}

function usage(): readonly string[] {
  return Object.freeze([
    "Usage: npm run release:create -- [--mock-rehearsal] [--config <config path>] [--output <release path>]",
    "",
    "Without --mock-rehearsal, the config must pass every production preflight gate.",
    "Production default: config/experiment.production.json.",
    "--mock-rehearsal creates a separately named, loopback-only sealed Mock review package.",
    "Existing output is never overwritten.",
  ]);
}

async function runGit(
  rootDirectory: string,
  arguments_: readonly string[],
): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolveCommand, rejectCommand) => {
    const child = spawn("git", arguments_, {
      cwd: rootDirectory,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectCommand(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        tooLarge = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    // Drain stderr without retaining it: remote URLs or local paths must never be
    // copied into an error message.
    child.stderr.resume();
    child.once("error", () => rejectOnce(new Error("Git could not be started.")));
    child.once("close", (code) => {
      if (settled) return;
      if (tooLarge) {
        rejectOnce(new Error("Git returned more output than the release safety limit."));
        return;
      }
      settled = true;
      resolveCommand({
        exitCode: code ?? 1,
        stdout: Buffer.concat(chunks).toString("utf8").trim(),
      });
    });
  });
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function collectSourceProvenance(rootDirectory: string): Promise<SourceProvenance> {
  const topLevelResult = await runGit(rootDirectory, ["rev-parse", "--show-toplevel"]);
  if (topLevelResult.exitCode !== 0 || topLevelResult.stdout.length === 0) {
    throw new Error("Release source must be a Git worktree with at least one commit.");
  }
  const [actualRoot, gitRoot] = await Promise.all([
    realpath(rootDirectory),
    realpath(topLevelResult.stdout),
  ]);
  if (!samePath(actualRoot, gitRoot)) {
    throw new Error("Release source directory must be the Git worktree root.");
  }

  const commitResult = await runGit(rootDirectory, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (commitResult.exitCode !== 0 || !/^[a-f0-9]{40}$/u.test(commitResult.stdout)) {
    throw new Error("Release source must have a full 40-character Git commit ID.");
  }
  const statusResult = await runGit(rootDirectory, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (statusResult.exitCode !== 0) {
    throw new Error("Git worktree status could not be checked.");
  }
  if (statusResult.stdout.length > 0) {
    throw new Error(
      "Release source worktree must be clean; commit, stash, or remove all tracked and untracked changes.",
    );
  }

  const remoteResult = await runGit(rootDirectory, ["remote", "get-url", "origin"]);
  const sourceRepository =
    remoteResult.exitCode === 0 && isCredentialFreeSourceRepository(remoteResult.stdout)
      ? remoteResult.stdout
      : undefined;
  return Object.freeze({
    sourceCommit: commitResult.stdout,
    ...(sourceRepository === undefined ? {} : { sourceRepository }),
  });
}

function readOptionValue(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parseCreateReleaseArguments(args: readonly string[]): CreateReleaseArguments {
  let configPath: string | undefined;
  let outputPath: string | undefined;
  let help = false;
  let mockRehearsal = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--mock-rehearsal") {
      if (mockRehearsal) throw new Error("--mock-rehearsal may only be specified once.");
      mockRehearsal = true;
      continue;
    }
    if (argument === "--config") {
      if (configPath !== undefined) throw new Error("--config may only be specified once.");
      configPath = readOptionValue(args, index, "--config");
      index += 1;
      continue;
    }
    if (argument?.startsWith("--config=")) {
      if (configPath !== undefined) throw new Error("--config may only be specified once.");
      configPath = argument.slice("--config=".length);
      if (configPath.length === 0) throw new Error("--config requires a value.");
      continue;
    }
    if (argument === "--output") {
      if (outputPath !== undefined) throw new Error("--output may only be specified once.");
      outputPath = readOptionValue(args, index, "--output");
      index += 1;
      continue;
    }
    if (argument?.startsWith("--output=")) {
      if (outputPath !== undefined) throw new Error("--output may only be specified once.");
      outputPath = argument.slice("--output=".length);
      if (outputPath.length === 0) throw new Error("--output requires a value.");
      continue;
    }
    throw new Error(`Unknown option: ${argument ?? "(missing)"}`);
  }
  return Object.freeze({
    help,
    mockRehearsal,
    ...(configPath === undefined ? {} : { configPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
  });
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

async function copyDirectoryWithoutMaps(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.endsWith(".map")) continue;
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Build output contains a symbolic link: ${sourcePath}`);
    if (entry.isDirectory()) {
      await copyDirectoryWithoutMaps(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported build output entry: ${sourcePath}`);
    await copyFile(sourcePath, destinationPath);
  }
}

async function requireRegularFile(path: string): Promise<void> {
  const fileStat = await lstat(path);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Required build output is not a regular file: ${path}`);
  }
}

function compactTimestamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
}

async function runtimePackageJson(
  rootDirectory: string,
  releaseKind: ReleaseKind,
): Promise<string> {
  const parsed: unknown = JSON.parse(
    await readFile(resolve(rootDirectory, "package.json"), "utf8"),
  );
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.json has an invalid structure.");
  }
  const source = parsed as Record<string, unknown>;
  const scripts =
    releaseKind === "production"
      ? {
          preflight: "node dist-server/preflight.js",
          healthcheck: "node dist-server/healthcheck.js",
          "release:verify": "node dist-server/verify-release.js",
          start:
            "node dist-server/verify-release.js && node dist-server/preflight.js && node dist-server/index.js",
        }
      : {
          healthcheck:
            "node dist-server/healthcheck.js --mock-rehearsal --config config/experiment.mock-rehearsal.json",
          "release:verify": "node dist-server/verify-release.js",
          start:
            "node dist-server/verify-release.js && node dist-server/rehearsal.js --mock-rehearsal",
        };
  const output = {
    ...source,
    private: true,
    scripts,
  };
  return `${JSON.stringify(output, null, 2)}\n`;
}

const PRODUCTION_WINDOWS_LAUNCHERS = Object.freeze({
  "START_PRODUCTION.cmd": [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    'set "NODE_ENV=production"',
    'set "NODE_OPTIONS="',
    'set "NODE_PATH="',
    "node dist-server\\verify-release.js",
    "if errorlevel 1 exit /b 1",
    "node dist-server\\preflight.js --config config\\experiment.json",
    "if errorlevel 1 exit /b 1",
    "node dist-server\\index.js",
  ],
  "CHECK_HEALTH.cmd": [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    "node dist-server\\healthcheck.js --config config\\experiment.json",
  ],
  "VERIFY_RELEASE.cmd": [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    "node dist-server\\verify-release.js",
  ],
});

function browserHost(bindHost: string): string {
  return bindHost === "::1" ? "[::1]" : bindHost;
}

function mockRehearsalWindowsLaunchers(
  report: PreflightReport,
): Readonly<Record<string, readonly string[]>> {
  const operatorUrl = `http://${browserHost(report.bindHost)}:${String(report.port)}/operator`;
  return Object.freeze({
    "START_MOCK_DEMO.cmd": [
      "@echo off",
      "setlocal EnableExtensions",
      'cd /d "%~dp0"',
      'set "NODE_ENV="',
      'set "NODE_OPTIONS="',
      'set "NODE_PATH="',
      'set "EXPERIMENT_CONFIG_PATH=config\\experiment.mock-rehearsal.json"',
      'set "DATA_DIRECTORY=data\\mock-sessions"',
      "node dist-server\\verify-release.js",
      "if errorlevel 1 exit /b 1",
      'if not exist "data\\mock-sessions" mkdir "data\\mock-sessions"',
      `start "" /b powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "$operator='${operatorUrl}'; 1..60 | ForEach-Object { & node 'dist-server\\healthcheck.js' --mock-rehearsal --config 'config\\experiment.mock-rehearsal.json' *> $null; if ($LASTEXITCODE -eq 0) { Start-Process $operator; exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"`,
      "echo Mock rehearsal starts without a physical device. Keep this window open.",
      "echo Press Ctrl+C once here to run the safe STOP/DEFLATE shutdown path.",
      "node dist-server\\rehearsal.js --mock-rehearsal",
      "exit /b %errorlevel%",
    ],
    "CHECK_MOCK_HEALTH.cmd": [
      "@echo off",
      "setlocal",
      'cd /d "%~dp0"',
      "node dist-server\\healthcheck.js --mock-rehearsal --config config\\experiment.mock-rehearsal.json",
    ],
    "VERIFY_MOCK_RELEASE.cmd": [
      "@echo off",
      "setlocal",
      'cd /d "%~dp0"',
      "node dist-server\\verify-release.js",
    ],
  });
}

function assertMockRehearsalReleaseConfig(report: PreflightReport, rootDirectory: string): void {
  const failures: string[] = [];
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (report.mode !== "development-mock") failures.push("release.mode");
  if (report.deviceMode !== "mock") failures.push("device.mode");
  if (report.serialPath !== "") failures.push("device.serialPath");
  if (report.allowMockInProduction) failures.push("device.allowMockInProduction");
  if (!loopbackHosts.has(report.bindHost)) failures.push("bindHost");
  if (report.allowLan) failures.push("network.allowLan");
  if (report.allowExternalRuntimeRequests) {
    failures.push("network.allowExternalRuntimeRequests");
  }
  if (report.formUrl !== "") failures.push("formUrl");
  if (report.researchIdPattern !== "^DEMO-[0-9]{3}$") {
    failures.push("researchIdPattern");
  }
  if (!samePath(report.logPath, resolve(rootDirectory, "data", "mock-sessions"))) {
    failures.push("logging.directory");
  }
  if (failures.length > 0) {
    throw new Error(`Mock rehearsal release gate failed: ${failures.join(", ")}`);
  }
}

function assertProductionReleaseMetadata(report: PreflightReport): void {
  const failures: string[] = [];
  if (report.mode !== "production") failures.push("release.mode");
  if (report.protocolVersion !== SCREEN_PROTOCOL_VERSION) failures.push("protocolVersion");
  if (report.deviceMode !== "screen") failures.push("device.mode");
  if (report.serialPath !== "") failures.push("device.serialPath");
  if (report.allowMockInProduction) failures.push("device.allowMockInProduction");
  if (report.fixedScore !== SCREEN_PRODUCTION_FIXED_STATE.score) failures.push("fixedState.score");
  if (report.fixedLabel !== SCREEN_PRODUCTION_FIXED_STATE.label) failures.push("fixedState.label");
  if (report.pufferLevel !== SCREEN_PRODUCTION_FIXED_STATE.pufferLevel) {
    failures.push("fixedState.pufferLevel");
  }
  if (report.researchIdPattern !== SCREEN_PRODUCTION_RESEARCH_ID_PATTERN) {
    failures.push("researchIdPattern");
  }
  if (failures.length > 0) {
    throw new Error(`Production screen release metadata gate failed: ${failures.join(", ")}`);
  }
}

async function installProductionDependencies(directory: string): Promise<void> {
  await new Promise<void>((resolveInstall, rejectInstall) => {
    const npmArguments = ["ci", "--omit=dev", "--no-audit", "--no-fund"];
    const child =
      process.platform === "win32"
        ? spawn("npm.cmd ci --omit=dev --no-audit --no-fund", [], {
            cwd: directory,
            env: {
              ...process.env,
              NODE_ENV: "production",
              npm_config_audit: "false",
              npm_config_fund: "false",
              npm_config_update_notifier: "false",
            },
            shell: true,
            stdio: "inherit",
          })
        : spawn("npm", npmArguments, {
            cwd: directory,
            env: {
              ...process.env,
              NODE_ENV: "production",
              npm_config_audit: "false",
              npm_config_fund: "false",
              npm_config_update_notifier: "false",
            },
            shell: false,
            stdio: "inherit",
          });
    child.once("error", rejectInstall);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveInstall();
        return;
      }
      rejectInstall(
        new Error(
          `Production dependency installation failed (${signal === null ? `exit ${String(code)}` : `signal ${signal}`}).`,
        ),
      );
    });
  });
}

async function buildReleaseArtifacts(
  rootDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child =
      process.platform === "win32"
         ? spawn("npm.cmd run build", [], {
             cwd: rootDirectory,
             env: environment,
             shell: true,
             stdio: "inherit",
           })
         : spawn("npm", ["run", "build"], {
             cwd: rootDirectory,
             env: environment,
             shell: false,
             stdio: "inherit",
           });
    child.once("error", rejectBuild);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveBuild();
        return;
      }
      rejectBuild(
        new Error(
          `Release build failed (${signal === null ? `exit ${String(code)}` : `signal ${signal}`}).`,
        ),
      );
    });
  });
}

export async function createRelease(options: CreateReleaseOptions = {}): Promise<string> {
  const writeLine = options.writeLine ?? console.info;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const buildLock = await acquireBuildLock(rootDirectory, { kind: "release" });
  try {
  const releaseKind = options.releaseKind ?? "production";
  const sourceProvenance = await collectSourceProvenance(rootDirectory);
  const releaseRoot = resolve(rootDirectory, "release");
  const configPath =
    options.configPath ??
    (releaseKind === "mock-rehearsal" ? DEFAULT_MOCK_REHEARSAL_CONFIG_PATH : DEFAULT_CONFIG_PATH);
  // Freeze one exact byte snapshot before any gate runs. Every config digest and
  // the packaged config below are bound back to this same snapshot.
  const configSnapshot = await loadExperimentConfig(configPath, {
    rootDirectory,
    production: false,
  });
  const report = await collectPreflightReport({
    rootDirectory,
    configPath,
    allowMock: releaseKind === "mock-rehearsal",
  });
  if (
    !samePath(configSnapshot.path, report.configPath) ||
    configSnapshot.configHash !== report.configHash ||
    configSnapshot.configFileHash !== report.configFileHash
  ) {
    throw new Error("Experiment config changed while the release gates were running.");
  }
  const failures = report.checks.filter((check) => check.status === "fail");
  if (failures.length > 0) {
    const gateName =
      releaseKind === "production" ? "Production preflight" : "Mock rehearsal preflight";
    throw new Error(`${gateName} failed: ${failures.map((check) => check.name).join(", ")}`);
  }
  if (releaseKind === "mock-rehearsal") {
    assertMockRehearsalReleaseConfig(report, rootDirectory);
  } else {
    assertProductionReleaseMetadata(report);
    const publicFormReport = await fetchPublicFormAudit(
      configSnapshot.config.formUrl,
      globalThis.fetch,
    );
    const formVerification = assessReleaseFormVerification(
      configSnapshot.config,
      publicFormReport,
    );
    renderReleaseFormVerification(formVerification, writeLine);
    if (!formVerification.approved) {
      throw new Error("Production Google Form live verification failed.");
    }
  }

  if (options.buildArtifacts ?? true) {
    writeLine("Building release artifacts from the recorded clean source commit...");
    await buildReleaseArtifacts(rootDirectory, buildLock.childEnvironment());
    const postBuildProvenance = await collectSourceProvenance(rootDirectory);
    if (
      postBuildProvenance.sourceCommit !== sourceProvenance.sourceCommit ||
      postBuildProvenance.sourceRepository !== sourceProvenance.sourceRepository
    ) {
      throw new Error("Git source provenance changed while release artifacts were built.");
    }
  }

  const packageSource = JSON.parse(
    await readFile(resolve(rootDirectory, "package.json"), "utf8"),
  ) as unknown;
  if (
    packageSource === null ||
    typeof packageSource !== "object" ||
    typeof (packageSource as Record<string, unknown>).version !== "string"
  ) {
    throw new Error("package.json must contain a version.");
  }
  const appVersion = (packageSource as Record<string, unknown>).version as string;
  const releaseName =
    releaseKind === "production" ? "sechack-experiment" : "sechack-mock-rehearsal";
  const defaultName = `${releaseName}-${appVersion}-${report.configHash.slice(0, 12)}-${compactTimestamp()}`;
  const outputDirectory =
    options.outputPath === undefined
      ? resolve(releaseRoot, defaultName)
      : resolve(rootDirectory, options.outputPath);
  if (!isInside(releaseRoot, outputDirectory) || dirname(outputDirectory) !== releaseRoot) {
    throw new Error(
      `Release output must be a direct child directory of release/ (resolved: ${relative(releaseRoot, outputDirectory)}).`,
    );
  }

  const serverBuildNames =
    releaseKind === "production"
      ? (["index.js", "preflight.js", "healthcheck.js", "verify-release.js"] as const)
      : (["rehearsal.js", "healthcheck.js", "verify-release.js"] as const);
  const requiredBuildFiles = [
    resolve(rootDirectory, "dist", "index.html"),
    ...serverBuildNames.map((name) => resolve(rootDirectory, "dist-server", name)),
  ];
  for (const path of requiredBuildFiles) await requireRegularFile(path);

  await mkdir(releaseRoot, { recursive: true });
  const releaseRootStat = await lstat(releaseRoot);
  const [realRootDirectory, realReleaseRoot] = await Promise.all([
    realpath(rootDirectory),
    realpath(releaseRoot),
  ]);
  if (releaseRootStat.isSymbolicLink() || !isInside(realRootDirectory, realReleaseRoot)) {
    throw new Error("release/ must be a normal directory inside the repository root.");
  }
  try {
    await lstat(outputDirectory);
    throw new Error(`Release output already exists: ${outputDirectory}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const stagingDirectory = resolve(releaseRoot, `.staging-${randomUUID()}`);
  let manifestSha256: string;
  await mkdir(stagingDirectory, { recursive: false });
  try {
    await copyDirectoryWithoutMaps(
      resolve(rootDirectory, "dist"),
      resolve(stagingDirectory, "dist"),
    );
    await mkdir(resolve(stagingDirectory, "dist-server"));
    for (const name of serverBuildNames) {
      await copyFile(
        resolve(rootDirectory, "dist-server", name),
        resolve(stagingDirectory, "dist-server", name),
      );
    }
    await mkdir(resolve(stagingDirectory, "config"));
    const packagedConfigName =
      releaseKind === "production" ? "experiment.json" : "experiment.mock-rehearsal.json";
    const packagedConfigPath = `config/${packagedConfigName}`;
    await writeFile(
      resolve(stagingDirectory, "config", packagedConfigName),
      configSnapshot.sourceBytes,
      { flag: "wx" },
    );
    if (releaseKind === "production") {
      const packagedConfig = await loadExperimentConfig(
        packagedConfigPath,
        {
          rootDirectory: stagingDirectory,
          allowedDirectory: resolve(stagingDirectory, "config"),
          production: true,
        },
      );
      if (
        packagedConfig.configHash !== configSnapshot.configHash ||
        packagedConfig.configFileHash !== configSnapshot.configFileHash
      ) {
        throw new Error("Packaged production screen config does not match the validated byte snapshot.");
      }
      await mkdir(resolve(stagingDirectory, "docs"));
      for (const name of [
        "RUNBOOK.md",
        "DEVICE_PROTOCOL.md",
        "EXPERIMENT_SPEC.md",
        "UI_COPY.md",
        "PROTOCOL_CHANGELOG.md",
        "TEST_REPORT.md",
        "RELEASE_CHECKLIST.md",
        "FORM_AUDIT.md",
        "FORM_RELEASE_GATE.md",
        "FORM_OWNER_FIX_GUIDE.md",
        "DEPLOYMENT.md",
        "MOCK_REHEARSAL.md",
        "PUBLIC_DEMO.md",
      ] as const) {
        await copyFile(
          resolve(rootDirectory, "docs", name),
          resolve(stagingDirectory, "docs", name),
        );
      }
      await writeFile(
        resolve(stagingDirectory, "DEPLOYMENT.md"),
        "# デプロイ手順\n\n正式な手順は[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)を参照してください。\n",
        "utf8",
      );
    }
    await writeFile(
      resolve(stagingDirectory, "package.json"),
      await runtimePackageJson(rootDirectory, releaseKind),
      "utf8",
    );
    await copyFile(
      resolve(rootDirectory, "package-lock.json"),
      resolve(stagingDirectory, "package-lock.json"),
    );
    await writeFile(
      resolve(stagingDirectory, ".npmrc"),
      "audit=false\nfund=false\nupdate-notifier=false\n",
      "utf8",
    );
    const packagedDataDirectory =
      releaseKind === "production"
        ? resolve(stagingDirectory, "data")
        : resolve(stagingDirectory, "data", "mock-sessions");
    await mkdir(packagedDataDirectory, { recursive: true });
    await writeFile(resolve(packagedDataDirectory, ".gitkeep"), "", { flag: "wx" });
    const windowsLaunchers =
      releaseKind === "production"
        ? PRODUCTION_WINDOWS_LAUNCHERS
        : mockRehearsalWindowsLaunchers(report);
    for (const [name, lines] of Object.entries(windowsLaunchers)) {
      await writeFile(resolve(stagingDirectory, name), `${lines.join("\r\n")}\r\n`, "utf8");
    }

    if (options.installDependencies ?? true) {
      writeLine("Installing lockfile-pinned production dependencies into the release...");
      await installProductionDependencies(stagingDirectory);
    }

    const finalProvenance = await collectSourceProvenance(rootDirectory);
    if (
      finalProvenance.sourceCommit !== sourceProvenance.sourceCommit ||
      finalProvenance.sourceRepository !== sourceProvenance.sourceRepository
    ) {
      throw new Error("Git source provenance changed while the release was being generated.");
    }

    const manifest = await createReleaseManifest(stagingDirectory, {
      appVersion,
      protocolVersion: report.protocolVersion,
      configHash: configSnapshot.configHash,
      configFileHash: configSnapshot.configFileHash,
      sourceCommit: sourceProvenance.sourceCommit,
      ...(sourceProvenance.sourceRepository === undefined
        ? {}
        : { sourceRepository: sourceProvenance.sourceRepository }),
    });
    await writeReleaseManifest(stagingDirectory, manifest);
    const verification = await verifyReleaseDirectoryDetailed(stagingDirectory);
    if (verification.errors.length > 0) {
      throw new Error(`Generated release failed verification: ${verification.errors.join("; ")}`);
    }
    if (
      verification.manifestSha256 === null ||
      verification.sourceCommit !== sourceProvenance.sourceCommit
    ) {
      throw new Error("Generated release provenance could not be verified.");
    }
    manifestSha256 = verification.manifestSha256;
    await rename(stagingDirectory, outputDirectory);
  } catch (error) {
    if (
      isInside(releaseRoot, stagingDirectory) &&
      relative(releaseRoot, stagingDirectory).startsWith(".staging-")
    ) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
    throw error;
  }

  writeLine(
    `${releaseKind === "production" ? "Production" : "Mock rehearsal"} release created: ${outputDirectory}`,
  );
  writeLine(`Config SHA-256: ${report.configHash}`);
  writeLine(`Source commit: ${sourceProvenance.sourceCommit}`);
  if (sourceProvenance.sourceRepository !== undefined) {
    writeLine(`Source repository: ${sourceProvenance.sourceRepository}`);
  }
  writeLine(`Deployment manifest SHA-256: ${manifestSha256}`);
  writeLine(
    releaseKind === "production"
      ? "Next: run VERIFY_RELEASE.cmd, then START_PRODUCTION.cmd."
      : "Next: run VERIFY_MOCK_RELEASE.cmd, then START_MOCK_DEMO.cmd. This is not a production research release.",
  );
  return outputDirectory;
  } finally {
    await buildLock.release();
  }
}

export async function runCreateRelease(
  args: readonly string[] = process.argv.slice(2),
  writeLine: (line: string) => void = console.info,
  dependencies: RunCreateReleaseDependencies = {},
): Promise<number> {
  try {
    const parsed = parseCreateReleaseArguments(args);
    if (parsed.help) {
      for (const line of usage()) writeLine(line);
      return 0;
    }
    const configPath = parsed.configPath
      ?? (parsed.mockRehearsal ? DEFAULT_MOCK_REHEARSAL_CONFIG_PATH : DEFAULT_CONFIG_PATH);
    if (!parsed.mockRehearsal) {
      const formVerification = await (dependencies.verifyReleaseForm ?? verifyReleaseForm)({
        configPath,
      });
      renderReleaseFormVerification(formVerification, writeLine);
      if (!formVerification.approved) {
        throw new Error("Production Google Form live verification failed.");
      }
    }
    await (dependencies.createRelease ?? createRelease)({
      configPath,
      ...(parsed.outputPath === undefined ? {} : { outputPath: parsed.outputPath }),
      releaseKind: parsed.mockRehearsal ? "mock-rehearsal" : "production",
      writeLine,
    });
    return 0;
  } catch (error) {
    writeLine(
      `Release creation failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCreateRelease();
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  void main();
}
