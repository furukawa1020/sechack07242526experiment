import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createScreenPilotLaunchCapability,
  verifyScreenPilotSource,
  type ScreenPilotSourceEvidence,
} from "../src/server/screen-pilot-provenance.js";

const SCREEN_PILOT_BUILD_ENVIRONMENT = Object.freeze({
  sourceCommit: "SECHACK_SCREEN_PILOT_SOURCE_COMMIT",
  sourceTreeSha256: "SECHACK_SCREEN_PILOT_SOURCE_TREE_SHA256",
  configFileHash: "SECHACK_SCREEN_PILOT_CONFIG_FILE_HASH",
  buildChallengeSha256: "SECHACK_SCREEN_PILOT_BUILD_CHALLENGE_SHA256",
});
const PROHIBITED_ENVIRONMENT_KEYS = Object.freeze([
  "NODE_OPTIONS",
  "NODE_PATH",
  "ESBUILD_BINARY_PATH",
  "EXPERIMENT_CONFIG_PATH",
  "DATA_DIRECTORY",
  "NPM_CONFIG_NODE_OPTIONS",
  "npm_config_node_options",
  "NPM_CONFIG_SCRIPT_SHELL",
  "npm_config_script_shell",
  "TSX_TSCONFIG_PATH",
  ...Object.values(SCREEN_PILOT_BUILD_ENVIRONMENT),
] as const);
const SHUTDOWN_MESSAGE_TYPE = "screen-pilot.shutdown";
const WINDOWS_SYSTEM_COMMAND_PROCESSOR = String.raw`\\.\GLOBALROOT\SystemRoot\System32\cmd.exe`;
const WINDOWS_PATH_SEPARATOR = ";";
const SAFE_PASSTHROUGH_ENVIRONMENT_KEYS = Object.freeze([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
] as const);

export interface FreshBuildInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

interface WindowsBuildToolchain {
  readonly commandProcessor: string;
  readonly gitDirectory: string;
  readonly nodeExecutable: string;
  readonly nodeDirectory: string;
  readonly npmCli: string;
  readonly systemDirectory: string;
  readonly windowsDirectory: string;
}

function sameWindowsPath(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function requireOrdinaryFile(path: string, label: string): string {
  let status: ReturnType<typeof lstatSync>;
  let canonicalPath: string;
  try {
    status = lstatSync(path);
    canonicalPath = realpathSync.native(path);
  } catch (error) {
    throw new Error(`${label} is not available at its trusted path.`, { cause: error });
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary file at its trusted path.`);
  }
  return canonicalPath;
}

function validateOptionalWindowsPath(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[],
  expectedPath: string,
  label: string,
): void {
  for (const key of keys) {
    const suppliedPath = (environment[key] ?? "").trim();
    if (suppliedPath.length === 0) continue;
    if (!isAbsolute(suppliedPath)) {
      throw new Error(`Screen-pilot requires an absolute trusted ${label} path.`);
    }
    const canonicalSuppliedPath = requireOrdinaryFile(suppliedPath, label);
    if (!sameWindowsPath(canonicalSuppliedPath, expectedPath)) {
      throw new Error(`Screen-pilot rejects an untrusted ${label} path.`);
    }
  }
}

/**
 * Resolves the Windows tools without consulting PATH. GLOBALROOT resolves the
 * kernel's SystemRoot link, so an inherited ComSpec/SystemRoot value cannot
 * redirect the launcher to an attacker-controlled cmd.exe. The npm CLI must be
 * an ordinary file in the installation directory of this exact Node process.
 */
function trustedWindowsBuildToolchain(
  environment: NodeJS.ProcessEnv,
  executablePath: string,
): WindowsBuildToolchain {
  if (!isAbsolute(executablePath) || basename(executablePath).toLowerCase() !== "node.exe") {
    throw new Error("Screen-pilot requires an absolute trusted Windows node.exe path.");
  }
  const nodeExecutable = requireOrdinaryFile(executablePath, "Windows Node executable");
  if (basename(nodeExecutable).toLowerCase() !== "node.exe") {
    throw new Error("Screen-pilot requires the canonical Windows Node executable.");
  }
  const commandProcessor = requireOrdinaryFile(
    WINDOWS_SYSTEM_COMMAND_PROCESSOR,
    "Windows System32 command processor",
  );
  if (basename(commandProcessor).toLowerCase() !== "cmd.exe") {
    throw new Error("Screen-pilot could not resolve the real Windows System32 cmd.exe.");
  }
  validateOptionalWindowsPath(
    environment,
    ["ComSpec", "COMSPEC"],
    commandProcessor,
    "Windows System32 command processor",
  );

  const nodeDirectory = dirname(nodeExecutable);
  const expectedNpmCli = resolve(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js");
  const npmCli = requireOrdinaryFile(expectedNpmCli, "npm CLI");
  if (!sameWindowsPath(npmCli, expectedNpmCli)) {
    throw new Error("Screen-pilot rejects a linked npm CLI outside the trusted Node installation.");
  }
  validateOptionalWindowsPath(environment, ["npm_execpath"], npmCli, "npm CLI");
  validateOptionalWindowsPath(
    environment,
    ["npm_node_execpath"],
    nodeExecutable,
    "npm Node executable",
  );

  // The verified runtime repeats the clean-tree/provenance checks. Keep Git
  // available without restoring the caller's PATH: the formal Windows
  // launcher pins Node under Program Files, and accepts only the ordinary Git
  // executable in that same protected installation root.
  const expectedGit = resolve(nodeDirectory, "..", "Git", "cmd", "git.exe");
  const gitExecutable = requireOrdinaryFile(expectedGit, "Git executable");
  if (!sameWindowsPath(gitExecutable, expectedGit)) {
    throw new Error("Screen-pilot rejects a linked Git outside the trusted installation root.");
  }

  const systemDirectory = dirname(commandProcessor);
  return Object.freeze({
    commandProcessor,
    gitDirectory: dirname(gitExecutable),
    nodeExecutable,
    nodeDirectory,
    npmCli,
    systemDirectory,
    windowsDirectory: dirname(systemDirectory),
  });
}

/**
 * On Windows, execute npm's JavaScript entry point with this exact Node binary.
 * cmd.exe remains npm's pinned lifecycle shell, but neither ComSpec nor PATH is
 * used to select the Node/npm program that performs the fresh build.
 */
export function freshBuildInvocation(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
): FreshBuildInvocation {
  if (platform !== "win32") {
    return Object.freeze({ command: "npm", args: Object.freeze(["run", "build"]) });
  }
  const toolchain = trustedWindowsBuildToolchain(environment, executablePath);
  return Object.freeze({
    command: toolchain.nodeExecutable,
    args: Object.freeze([toolchain.npmCli, "run", "build"]),
  });
}

function waitForExit(child: ChildProcess, label: string): Promise<number> {
  return new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", (error) => rejectExit(new Error(`${label} could not start.`, { cause: error })));
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        rejectExit(new Error(`${label} ended from signal ${signal}.`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

function assertSafeLauncherEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of PROHIBITED_ENVIRONMENT_KEYS) {
    if ((environment[key] ?? "").trim().length > 0) {
      throw new Error(`Screen-pilot launcher prohibits the ${key} environment override.`);
    }
  }
}

export function sanitizedChildEnvironment(
  platform = process.platform,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    NODE_OPTIONS: "",
    NODE_PATH: "",
  };
  for (const key of SAFE_PASSTHROUGH_ENVIRONMENT_KEYS) {
    const value = sourceEnvironment[key];
    if (value !== undefined && !value.includes("\0")) environment[key] = value;
  }
  if (platform === "win32") {
    const toolchain = trustedWindowsBuildToolchain(sourceEnvironment, executablePath);
    environment.ComSpec = toolchain.commandProcessor;
    environment.SystemRoot = toolchain.windowsDirectory;
    environment.WINDIR = toolchain.windowsDirectory;
    environment.Path = [
      toolchain.nodeDirectory,
      toolchain.gitDirectory,
      toolchain.systemDirectory,
      toolchain.windowsDirectory,
    ].join(WINDOWS_PATH_SEPARATOR);
    environment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    environment.NPM_CONFIG_NODE_OPTIONS = "";
    environment.NPM_CONFIG_SCRIPT_SHELL = toolchain.commandProcessor;
    environment.NPM_CONFIG_USERCONFIG = "NUL";
    environment.NPM_CONFIG_IGNORE_SCRIPTS = "true";
    environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
    environment.NPM_CONFIG_AUDIT = "false";
    environment.NPM_CONFIG_FUND = "false";
  } else {
    const path = sourceEnvironment.PATH;
    if (path !== undefined && !path.includes("\0")) environment.PATH = path;
  }
  return environment;
}

function screenPilotBuildEnvironment(
  evidence: ScreenPilotSourceEvidence,
  buildChallengeSha256: string,
): NodeJS.ProcessEnv {
  return {
    ...sanitizedChildEnvironment(),
    [SCREEN_PILOT_BUILD_ENVIRONMENT.sourceCommit]: evidence.sourceCommit,
    [SCREEN_PILOT_BUILD_ENVIRONMENT.sourceTreeSha256]: evidence.sourceTreeSha256,
    [SCREEN_PILOT_BUILD_ENVIRONMENT.configFileHash]: evidence.configFileHash,
    [SCREEN_PILOT_BUILD_ENVIRONMENT.buildChallengeSha256]: buildChallengeSha256,
  };
}

async function runFreshBuild(
  rootDirectory: string,
  evidence: ScreenPilotSourceEvidence,
  buildChallengeSha256: string,
): Promise<void> {
  const invocation = freshBuildInvocation();
  const child = spawn(
    invocation.command,
    invocation.args,
    {
      cwd: rootDirectory,
      env: screenPilotBuildEnvironment(evidence, buildChallengeSha256),
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (await waitForExit(child, "Fresh screen-pilot build") !== 0) {
    throw new Error("Fresh screen-pilot build failed.");
  }
}

function forwardLauncherShutdown(child: ChildProcess): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => {
      if (child.connected) {
        child.send({ type: SHUTDOWN_MESSAGE_TYPE }, (error) => {
          if (error && !child.killed) child.kill();
        });
      } else if (!child.killed) {
        child.kill();
      }
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export async function runScreenPilotLauncher(root = process.cwd()): Promise<number> {
  try {
    assertSafeLauncherEnvironment(process.env);
    if (process.env.npm_lifecycle_event !== "screen-pilot") {
      throw new Error("Screen-pilot launcher may run only through npm run screen-pilot.");
    }
    if (process.argv.slice(2).length > 0) {
      throw new Error("Screen-pilot launcher accepts no command-line overrides.");
    }
    const beforeBuild = await verifyScreenPilotSource(resolve(root));
    const buildSecret = randomBytes(32).toString("hex");
    const buildChallengeSha256 = createHash("sha256")
      .update(Buffer.from(buildSecret, "hex"))
      .digest("hex");
    await runFreshBuild(beforeBuild.rootDirectory, beforeBuild.evidence, buildChallengeSha256);
    const capability = await createScreenPilotLaunchCapability(
      beforeBuild.rootDirectory,
      beforeBuild.evidence,
      buildSecret,
    );
    const entryPath = resolve(beforeBuild.rootDirectory, "dist-server", "screen-pilot.js");
    const child = spawn(process.execPath, [entryPath, "--screen-pilot"], {
      cwd: beforeBuild.rootDirectory,
      env: sanitizedChildEnvironment(),
      shell: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    const exitPromise = waitForExit(child, "Verified screen-pilot runtime");
    const stopForwarding = forwardLauncherShutdown(child);
    child.send({ type: "screen-pilot.capability", capability }, (error) => {
      if (error) {
        if (!child.killed) child.kill();
      }
    });
    try {
      return await exitPromise;
    } finally {
      stopForwarding();
      if (child.connected) child.disconnect();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Screen-pilot launcher failed.");
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  process.exitCode = await runScreenPilotLauncher();
}
