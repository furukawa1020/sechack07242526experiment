import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadFormalProductionClientAssets,
  verifyFormalReleaseDirectoryDetailed,
} from "../../scripts/production-release-verifier.js";
import {
  FORMAL_PRODUCTION_CONFIG_PATH,
  hashFormalProductionCriticalConfig,
  loadFormalProductionConfig,
} from "../shared/formal-production-config.js";
import {
  startProductionRuntime,
  type RunningProductionRuntime,
} from "./production-runtime.js";

const PRODUCTION_SERVER_DIRECTORY = "dist-server";
const PRODUCTION_SERVER_ENTRY = "index.js";

/** The only callable export from the sealed formal server bundle. */
export async function startProductionReleaseCli(): Promise<RunningProductionRuntime> {
  if (
    process.env.EXPERIMENT_CONFIG_PATH !== undefined
    || process.env.DATA_DIRECTORY !== undefined
  ) {
    throw new Error("Production CLI prohibits config and data directory environment overrides.");
  }

  const entryPath = resolve(fileURLToPath(import.meta.url));
  const serverDirectory = dirname(entryPath);
  if (
    basename(entryPath) !== PRODUCTION_SERVER_ENTRY
    || basename(serverDirectory) !== PRODUCTION_SERVER_DIRECTORY
  ) {
    throw new Error("Production CLI must run as dist-server/index.js inside a packaged release.");
  }
  const releaseDirectory = resolve(serverDirectory, "..");
  const verification = await verifyFormalReleaseDirectoryDetailed(releaseDirectory);
  if (verification.errors.length > 0) {
    throw new Error(`Production release verification failed: ${verification.errors.join("; ")}`);
  }
  if (verification.manifest === null) {
    throw new Error("Production release verification returned no manifest binding.");
  }
  if (verification.manifestSha256 === null) {
    throw new Error("Production release verification returned no manifest SHA-256 binding.");
  }

  const loadedConfig = await loadFormalProductionConfig(FORMAL_PRODUCTION_CONFIG_PATH, {
    rootDirectory: releaseDirectory,
  });
  const bindingMismatches = [
    loadedConfig.configFileHash === verification.manifest.configFileHash
      ? null
      : "configFileHash",
    loadedConfig.configHash === verification.manifest.configHash ? null : "configHash",
    loadedConfig.config.protocolVersion === verification.manifest.protocolVersion
      ? null
      : "protocolVersion",
    hashFormalProductionCriticalConfig(loadedConfig.config)
      === verification.manifest.criticalConfigSha256
      ? null
      : "criticalConfigSha256",
  ].filter((name): name is string => name !== null);
  if (bindingMismatches.length > 0) {
    throw new Error(
      `Production config does not match the verified release manifest: ${bindingMismatches.join(", ")}.`,
    );
  }
  const clientAssets = await loadFormalProductionClientAssets(
    releaseDirectory,
    verification.manifestSha256,
  );

  return startProductionRuntime({
    rootDirectory: releaseDirectory,
    loadedConfig,
    appVersion: verification.manifest.appVersion,
    clientAssets,
  });
}

function runProductionCli(): void {
  let running: RunningProductionRuntime | undefined;
  void startProductionReleaseCli()
    .then((server) => {
      running = server;
      console.info(`SecHack experiment server listening at ${server.url}`);
      if (server.operatorToken !== null) {
        console.info(`LAN Operator token: ${server.operatorToken}`);
        const token = encodeURIComponent(server.operatorToken);
        console.info(`Operator URL: ${server.url}/operator?operatorToken=${token}`);
        console.info(`Device test URL: ${server.url}/device-test?operatorToken=${token}`);
      }
      let shutdownStarted = false;
      const shutdown = (exitCode: 0 | 1): void => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        console.info("Stopping the experiment server; waiting for STOP/DEFLATE confirmation...");
        const forceExit = setTimeout(() => {
          console.error("Safe shutdown did not complete before the configured safety deadline.");
          process.exit(1);
        }, running?.shutdownDeadlineMs ?? 190_000);
        void running?.close().then(
          () => {
            clearTimeout(forceExit);
            console.info("Experiment server stopped after STOP/DEFLATE shutdown.");
            process.exit(exitCode);
          },
          (error: unknown) => {
            clearTimeout(forceExit);
            console.error(error instanceof Error ? error.message : "Server shutdown failed.");
            process.exit(1);
          },
        );
      };
      process.on("SIGINT", () => shutdown(0));
      process.on("SIGTERM", () => shutdown(0));
      process.on("SIGBREAK", () => shutdown(0));
      process.once("uncaughtException", (error: Error) => {
        console.error(`Uncaught server error: ${error.message}`);
        shutdown(1);
      });
      process.once("unhandledRejection", (reason: unknown) => {
        console.error(
          `Unhandled server rejection: ${reason instanceof Error ? reason.message : "unknown error"}`,
        );
        shutdown(1);
      });
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Failed to start the experiment server.");
      process.exitCode = 1;
    });
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  runProductionCli();
}
