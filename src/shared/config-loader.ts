import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  parseExperimentConfig,
  type ExperimentConfig,
} from "./schemas.js";

export interface LoadExperimentConfigOptions {
  /** Repository root. Defaults to process.cwd(). */
  readonly rootDirectory?: string;
  /** Allowed config directory. Defaults to <rootDirectory>/config. */
  readonly allowedDirectory?: string;
  readonly production?: boolean;
}

export interface LoadedExperimentConfig {
  readonly config: ExperimentConfig;
  readonly configHash: string;
  readonly path: string;
}

function resolveSafeConfigPath(
  requestedPath: string,
  options: LoadExperimentConfigOptions,
): string {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const allowedDirectory = resolve(options.allowedDirectory ?? resolve(rootDirectory, "config"));
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(rootDirectory, requestedPath);
  const pathFromAllowedDirectory = relative(allowedDirectory, candidate);
  if (
    pathFromAllowedDirectory === ""
    || (
      !pathFromAllowedDirectory.startsWith("..")
      && !isAbsolute(pathFromAllowedDirectory)
    )
  ) {
    return candidate;
  }
  throw new Error("The experiment config path must remain inside the allowed config directory.");
}

export function hashExperimentConfig(config: ExperimentConfig): string {
  return createHash("sha256").update(JSON.stringify(config), "utf8").digest("hex");
}

export async function loadExperimentConfig(
  requestedPath = "config/experiment.json",
  options: LoadExperimentConfigOptions = {},
): Promise<LoadedExperimentConfig> {
  const resolvedConfigPath = resolveSafeConfigPath(requestedPath, options);
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const allowedDirectory = resolve(options.allowedDirectory ?? resolve(rootDirectory, "config"));
  const configStat = await lstat(resolvedConfigPath);
  if (configStat.isSymbolicLink()) {
    throw new Error("The experiment config must not be a symbolic link or junction.");
  }
  const [realAllowedDirectory, configPath] = await Promise.all([
    realpath(allowedDirectory),
    realpath(resolvedConfigPath),
  ]);
  const realRelativePath = relative(realAllowedDirectory, configPath);
  if (
    realRelativePath === ".."
    || realRelativePath.startsWith("../")
    || realRelativePath.startsWith("..\\")
    || isAbsolute(realRelativePath)
  ) {
    throw new Error("The experiment config resolved outside the allowed config directory.");
  }
  const source = await readFile(configPath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `Experiment config is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }

  const config = parseExperimentConfig(parsedJson);
  if (options.production === true && config.device.mode === "mock") {
    throw new Error("Mock device mode is unconditionally disabled in production.");
  }

  return Object.freeze({
    config,
    configHash: hashExperimentConfig(config),
    path: configPath,
  });
}
