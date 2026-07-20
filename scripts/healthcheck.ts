import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadExperimentConfig } from "../src/shared/config-loader.js";

const DEFAULT_CONFIG_PATH = "config/experiment.json";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface HealthcheckArguments {
  readonly configPath?: string;
  readonly help: boolean;
  readonly timeoutMs: number;
}

export interface HealthcheckResult {
  readonly url: string;
  readonly appVersion: string;
  readonly protocolVersion: string;
  readonly configHash: string;
  readonly deviceMode: "mock" | "serial";
}

export interface RunHealthcheckOptions {
  readonly args?: readonly string[];
  readonly rootDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetchImplementation?: typeof fetch;
  readonly writeLine?: (line: string) => void;
}

function usage(): readonly string[] {
  return Object.freeze([
    "Usage: npm run healthcheck -- [--config <config path>] [--timeout <milliseconds>]",
    "",
    "Options:",
    "  --config <path>   config/ 内の設定ファイルを指定します。",
    "  --timeout <ms>    応答待ち時間（100〜60000ms、既定5000ms）。",
    "  --help            このヘルプを表示します。",
  ]);
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseHealthcheckArguments(args: readonly string[]): HealthcheckArguments {
  let configPath: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--config") {
      if (configPath !== undefined) throw new Error("--config may only be specified once.");
      configPath = optionValue(args, index, "--config");
      index += 1;
      continue;
    }
    if (argument?.startsWith("--config=")) {
      if (configPath !== undefined) throw new Error("--config may only be specified once.");
      configPath = argument.slice("--config=".length);
      if (configPath.length === 0) throw new Error("--config requires a value.");
      continue;
    }
    if (argument === "--timeout") {
      timeoutMs = Number(optionValue(args, index, "--timeout"));
      index += 1;
      continue;
    }
    if (argument?.startsWith("--timeout=")) {
      timeoutMs = Number(argument.slice("--timeout=".length));
      continue;
    }
    throw new Error(`Unknown option: ${argument ?? "(missing)"}`);
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("--timeout must be an integer between 100 and 60000.");
  }
  return Object.freeze({
    help,
    timeoutMs,
    ...(configPath === undefined ? {} : { configPath }),
  });
}

export function healthcheckHost(bindHost: string): string {
  if (bindHost === "0.0.0.0") return "127.0.0.1";
  if (bindHost === "::") return "[::1]";
  if (isIP(bindHost) === 6) return `[${bindHost}]`;
  return bindHost;
}

function isHealthPayload(
  payload: unknown,
): payload is {
  status: "ok";
  appVersion: string;
  protocolVersion: string;
  configHash: string;
  deviceMode: "mock" | "serial";
} {
  if (payload === null || typeof payload !== "object") return false;
  const candidate = payload as Record<string, unknown>;
  return candidate.status === "ok"
    && typeof candidate.appVersion === "string"
    && typeof candidate.protocolVersion === "string"
    && typeof candidate.configHash === "string"
    && (candidate.deviceMode === "mock" || candidate.deviceMode === "serial");
}

export async function checkHealth(options: {
  readonly configPath: string;
  readonly rootDirectory: string;
  readonly timeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
}): Promise<HealthcheckResult> {
  const loaded = await loadExperimentConfig(options.configPath, {
    rootDirectory: options.rootDirectory,
    production: false,
  });
  const url = `http://${healthcheckHost(loaded.config.bindHost)}:${loaded.config.port}/healthz`;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`GET /healthz returned HTTP ${response.status}.`);
  }
  const payload: unknown = await response.json();
  if (!isHealthPayload(payload)) {
    throw new Error("GET /healthz returned an invalid response.");
  }
  if (payload.protocolVersion !== loaded.config.protocolVersion) {
    throw new Error("The running protocolVersion does not match the deployment config.");
  }
  if (payload.configHash !== loaded.configHash) {
    throw new Error("The running config hash does not match the deployment config.");
  }
  if (payload.deviceMode !== loaded.config.device.mode) {
    throw new Error("The running device mode does not match the deployment config.");
  }
  return Object.freeze({
    url,
    appVersion: payload.appVersion,
    protocolVersion: payload.protocolVersion,
    configHash: payload.configHash,
    deviceMode: payload.deviceMode,
  });
}

export async function runHealthcheck(options: RunHealthcheckOptions = {}): Promise<number> {
  const writeLine = options.writeLine ?? console.info;
  try {
    const parsed = parseHealthcheckArguments(options.args ?? process.argv.slice(2));
    if (parsed.help) {
      for (const line of usage()) writeLine(line);
      return 0;
    }
    const environment = options.environment ?? process.env;
    const result = await checkHealth({
      configPath: parsed.configPath ?? environment.EXPERIMENT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
      rootDirectory: resolve(options.rootDirectory ?? process.cwd()),
      timeoutMs: parsed.timeoutMs,
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
    });
    writeLine(
      `結果: PASS (${result.url}, appVersion=${result.appVersion}, protocolVersion=${result.protocolVersion}, configHash=${result.configHash}, deviceMode=${result.deviceMode})`,
    );
    return 0;
  } catch (error) {
    writeLine(`結果: FAIL (${error instanceof Error ? error.message : "healthcheck failed"})`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runHealthcheck();
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  void main();
}
