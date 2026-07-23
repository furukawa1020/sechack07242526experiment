import { normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatFormalProductionConfigError,
  loadFormalProductionConfig,
} from "../src/shared/formal-production-config.js";

export const PRODUCTION_HEALTH_CONFIG_PATH = "config/experiment.json";
export const PRODUCTION_HEALTH_DEFAULT_TIMEOUT_MS = 5_000;

export interface ProductionHealthcheckArguments {
  readonly configPath: typeof PRODUCTION_HEALTH_CONFIG_PATH;
  readonly timeoutMs: number;
}

export interface ProductionHealthcheckResult {
  readonly url: string;
  readonly appVersion: string;
  readonly protocolVersion: string;
  readonly configHash: string;
  readonly deviceMode: "screen";
}

export interface CheckProductionHealthOptions {
  readonly rootDirectory?: string;
  readonly timeoutMs?: number;
  readonly currentDate?: Date;
  readonly fetchImplementation?: typeof fetch;
}

export interface RunProductionHealthcheckOptions extends CheckProductionHealthOptions {
  readonly args?: readonly string[];
  readonly writeLine?: (line: string) => void;
}

function normalizedConfigArgument(value: string): string {
  return normalize(value).replaceAll("\\", "/");
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error("--timeout requires an integer value.");
  }
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("--timeout must be an integer between 100 and 60000.");
  }
  return timeoutMs;
}

export function parseProductionHealthcheckArguments(
  args: readonly string[],
): ProductionHealthcheckArguments {
  let configSeen = false;
  let timeoutSeen = false;
  let timeoutMs = PRODUCTION_HEALTH_DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config") {
      if (configSeen) throw new Error("--config may only be specified once.");
      const value = args[index + 1];
      if (
        value === undefined
        || value.length === 0
        || value.startsWith("--")
        || normalizedConfigArgument(value) !== PRODUCTION_HEALTH_CONFIG_PATH
      ) {
        throw new Error(
          `--config is fixed to ${PRODUCTION_HEALTH_CONFIG_PATH} for formal production.`,
        );
      }
      configSeen = true;
      index += 1;
      continue;
    }
    if (argument === "--timeout") {
      if (timeoutSeen) throw new Error("--timeout may only be specified once.");
      timeoutMs = parseTimeout(args[index + 1]);
      timeoutSeen = true;
      index += 1;
      continue;
    }
    throw new Error(
      `Unknown option: ${argument ?? "(missing)"}. Only --config and --timeout are allowed.`,
    );
  }

  return Object.freeze({
    configPath: PRODUCTION_HEALTH_CONFIG_PATH,
    timeoutMs,
  });
}

function isProductionHealthPayload(payload: unknown): payload is {
  readonly status: "ok";
  readonly appVersion: string;
  readonly protocolVersion: string;
  readonly configHash: string;
  readonly deviceMode: "screen";
} {
  if (payload === null || typeof payload !== "object") return false;
  const candidate = payload as Readonly<Record<string, unknown>>;
  return candidate.status === "ok"
    && typeof candidate.appVersion === "string"
    && candidate.appVersion.length > 0
    && !/[\0\r\n]/u.test(candidate.appVersion)
    && typeof candidate.protocolVersion === "string"
    && typeof candidate.configHash === "string"
    && /^[a-f0-9]{64}$/u.test(candidate.configHash)
    && candidate.deviceMode === "screen";
}

export async function checkProductionHealth(
  options: CheckProductionHealthOptions = {},
): Promise<ProductionHealthcheckResult> {
  const timeoutMs = options.timeoutMs ?? PRODUCTION_HEALTH_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("Production healthcheck timeout must be between 100 and 60000 ms.");
  }
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const loaded = await loadFormalProductionConfig(PRODUCTION_HEALTH_CONFIG_PATH, {
    rootDirectory,
    ...(options.currentDate === undefined ? {} : { currentDate: options.currentDate }),
  });
  const url = `http://127.0.0.1:${String(loaded.config.port)}/healthz`;
  const response = await (options.fetchImplementation ?? fetch)(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) {
    throw new Error(`GET /healthz returned HTTP ${String(response.status)}.`);
  }
  const payload: unknown = await response.json();
  if (!isProductionHealthPayload(payload)) {
    throw new Error("GET /healthz returned an invalid formal production response.");
  }
  if (payload.protocolVersion !== loaded.config.protocolVersion) {
    throw new Error("The running protocolVersion does not match the formal production config.");
  }
  if (payload.configHash !== loaded.configHash) {
    throw new Error("The running config hash does not match the formal production config.");
  }
  if (payload.deviceMode !== loaded.config.device.mode) {
    throw new Error("The running device mode is not the formal screen mode.");
  }
  return Object.freeze({
    url,
    appVersion: payload.appVersion,
    protocolVersion: payload.protocolVersion,
    configHash: payload.configHash,
    deviceMode: payload.deviceMode,
  });
}

export async function runProductionHealthcheck(
  options: RunProductionHealthcheckOptions = {},
): Promise<number> {
  const writeLine = options.writeLine ?? console.info;
  try {
    const parsed = parseProductionHealthcheckArguments(options.args ?? process.argv.slice(2));
    const result = await checkProductionHealth({
      ...(options.rootDirectory === undefined ? {} : { rootDirectory: options.rootDirectory }),
      timeoutMs: parsed.timeoutMs,
      ...(options.currentDate === undefined ? {} : { currentDate: options.currentDate }),
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
    });
    writeLine(
      `Result: PASS (${result.url}, appVersion=${result.appVersion}, protocolVersion=${result.protocolVersion}, configHash=${result.configHash}, deviceMode=${result.deviceMode})`,
    );
    return 0;
  } catch (error) {
    writeLine("Result: FAIL (formal production healthcheck did not pass)");
    for (const message of formatFormalProductionConfigError(error)) {
      writeLine(`  [FAIL] ${message}`);
    }
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runProductionHealthcheck();
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  void main();
}
