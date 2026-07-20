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
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { collectPreflightReport } from "./preflight.js";
import {
  createReleaseManifest,
  verifyReleaseDirectory,
  writeReleaseManifest,
} from "./release-manifest.js";

const DEFAULT_CONFIG_PATH = "config/experiment.json";

export interface CreateReleaseArguments {
  readonly configPath?: string;
  readonly help: boolean;
  readonly outputPath?: string;
}

export interface CreateReleaseOptions {
  readonly rootDirectory?: string;
  readonly configPath?: string;
  readonly outputPath?: string;
  /** Tests may disable dependency installation; the CLI always installs production dependencies. */
  readonly installDependencies?: boolean;
  readonly writeLine?: (line: string) => void;
}

function usage(): readonly string[] {
  return Object.freeze([
    "Usage: npm run release:create -- [--config <config path>] [--output <release path>]",
    "",
    "The config must pass every production preflight gate. Existing output is never overwritten.",
  ]);
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
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
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

async function runtimePackageJson(rootDirectory: string): Promise<string> {
  const parsed: unknown = JSON.parse(
    await readFile(resolve(rootDirectory, "package.json"), "utf8"),
  );
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.json has an invalid structure.");
  }
  const source = parsed as Record<string, unknown>;
  const output = {
    ...source,
    private: true,
    scripts: {
      preflight: "node dist-server/preflight.js",
      healthcheck: "node dist-server/healthcheck.js",
      "release:verify": "node dist-server/verify-release.js",
      start: "node dist-server/index.js",
    },
  };
  return `${JSON.stringify(output, null, 2)}\n`;
}

const WINDOWS_LAUNCHERS = Object.freeze({
  "START_PRODUCTION.cmd": [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    'set "NODE_ENV=production"',
    'set "NODE_OPTIONS="',
    'set "NODE_PATH="',
    'set "EXPERIMENT_CONFIG_PATH=config\\experiment.json"',
    'set "DATA_DIRECTORY=data\\sessions"',
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

export async function createRelease(options: CreateReleaseOptions = {}): Promise<string> {
  const writeLine = options.writeLine ?? console.info;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const releaseRoot = resolve(rootDirectory, "release");
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const report = await collectPreflightReport({
    rootDirectory,
    configPath,
    allowMock: false,
  });
  const failures = report.checks.filter((check) => check.status === "fail");
  if (failures.length > 0) {
    throw new Error(
      `Production preflight failed: ${failures.map((check) => check.name).join(", ")}`,
    );
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
  const defaultName = `sechack-experiment-${appVersion}-${report.configHash.slice(0, 12)}-${compactTimestamp()}`;
  const outputDirectory = resolve(
    rootDirectory,
    options.outputPath ?? resolve("release", defaultName),
  );
  if (!isInside(releaseRoot, outputDirectory)) {
    throw new Error("Release output must be a child directory of release/.");
  }

  const requiredBuildFiles = [
    resolve(rootDirectory, "dist", "index.html"),
    resolve(rootDirectory, "dist-server", "index.js"),
    resolve(rootDirectory, "dist-server", "preflight.js"),
    resolve(rootDirectory, "dist-server", "healthcheck.js"),
    resolve(rootDirectory, "dist-server", "verify-release.js"),
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
  const stagingDirectory = resolve(releaseRoot, `.staging-${randomUUID()}`);
  await mkdir(stagingDirectory, { recursive: false });
  try {
    await copyDirectoryWithoutMaps(
      resolve(rootDirectory, "dist"),
      resolve(stagingDirectory, "dist"),
    );
    await mkdir(resolve(stagingDirectory, "dist-server"));
    for (const name of [
      "index.js",
      "preflight.js",
      "healthcheck.js",
      "verify-release.js",
    ] as const) {
      await copyFile(
        resolve(rootDirectory, "dist-server", name),
        resolve(stagingDirectory, "dist-server", name),
      );
    }
    await mkdir(resolve(stagingDirectory, "config"));
    await copyFile(report.configPath, resolve(stagingDirectory, "config", "experiment.json"));
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
    ] as const) {
      await copyFile(resolve(rootDirectory, "docs", name), resolve(stagingDirectory, "docs", name));
    }
    await copyFile(
      resolve(rootDirectory, "docs", "DEPLOYMENT.md"),
      resolve(stagingDirectory, "DEPLOYMENT.md"),
    );
    await writeFile(
      resolve(stagingDirectory, "package.json"),
      await runtimePackageJson(rootDirectory),
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
    await mkdir(resolve(stagingDirectory, "data"));
    await writeFile(resolve(stagingDirectory, "data", ".gitkeep"), "", { flag: "wx" });
    for (const [name, lines] of Object.entries(WINDOWS_LAUNCHERS)) {
      await writeFile(resolve(stagingDirectory, name), `${lines.join("\r\n")}\r\n`, "utf8");
    }

    if (options.installDependencies ?? true) {
      writeLine("Installing lockfile-pinned production dependencies into the release...");
      await installProductionDependencies(stagingDirectory);
    }

    const manifest = await createReleaseManifest(stagingDirectory, {
      appVersion,
      protocolVersion: report.protocolVersion,
      configHash: report.configHash,
      configFileHash: report.configFileHash,
    });
    await writeReleaseManifest(stagingDirectory, manifest);
    const verificationErrors = await verifyReleaseDirectory(stagingDirectory);
    if (verificationErrors.length > 0) {
      throw new Error(`Generated release failed verification: ${verificationErrors.join("; ")}`);
    }
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

  writeLine(`Release created: ${outputDirectory}`);
  writeLine(`Config SHA-256: ${report.configHash}`);
  writeLine("Next: run VERIFY_RELEASE.cmd, then START_PRODUCTION.cmd.");
  return outputDirectory;
}

export async function runCreateRelease(
  args: readonly string[] = process.argv.slice(2),
  writeLine: (line: string) => void = console.info,
): Promise<number> {
  try {
    const parsed = parseCreateReleaseArguments(args);
    if (parsed.help) {
      for (const line of usage()) writeLine(line);
      return 0;
    }
    await createRelease({
      ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
      ...(parsed.outputPath === undefined ? {} : { outputPath: parsed.outputPath }),
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
