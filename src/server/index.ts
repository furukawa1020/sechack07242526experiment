import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyReleaseDirectoryDetailed } from "../../scripts/release-manifest.js";
import {
  loadExperimentConfig,
  type LoadedExperimentConfig,
} from "../shared/config-loader.js";
import { createApplication } from "./app.js";
import {
  MockPufferDevice,
  ScreenPufferDevice,
  SerialPufferDevice,
  type PufferDevice,
} from "./devices/index.js";
import { ExperimentLogger } from "./logging/index.js";
import { acquireExperimentServerLock } from "./runtime-lock.js";
import { SessionController } from "./sessions/session-controller.js";
import { WebSocketHub } from "./websocket/websocket-hub.js";

export interface RunningExperimentServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly operatorToken: string | null;
  readonly shutdownDeadlineMs: number;
  close(): Promise<void>;
}

export interface StartServerOptions {
  readonly rootDirectory?: string;
  readonly configPath?: string;
  readonly mode?: ServerMode;
  /** Test-only: audit built static assets inside the isolated nonparticipant runtime. */
  readonly serveBuiltAssets?: boolean;
}

interface InternalStartServerOptions extends StartServerOptions {
  readonly productionReleaseCapability?: symbol;
  readonly verifiedProductionConfig?: LoadedExperimentConfig;
  readonly verifiedAppVersion?: string;
}

export type ServerMode = "development" | "production" | "rehearsal" | "test";

export interface ServerCliOptions {
  readonly start?: () => Promise<RunningExperimentServer>;
  readonly listeningLabel?: string;
  readonly stoppedMessage?: string;
}

export interface ProductionReleaseCliOptions {
  /** Test-only override for the compiled entry location. */
  readonly entryPath?: string;
  /** Test-only environment snapshot. The real CLI always uses process.env. */
  readonly environment?: {
    readonly EXPERIMENT_CONFIG_PATH?: string;
    readonly DATA_DIRECTORY?: string;
  };
  /** Test seam; the real CLI always verifies the packaged deployment manifest. */
  readonly verifyRelease?: typeof verifyReleaseDirectoryDetailed;
  /** Test seam; the real CLI always loads the fixed packaged config once. */
  readonly loadConfig?: typeof loadExperimentConfig;
  /** Test seam; the real CLI starts only from the verified config snapshot. */
  readonly start?: (options: VerifiedProductionStartOptions) => Promise<RunningExperimentServer>;
}

export interface VerifiedProductionStartOptions {
  readonly rootDirectory: string;
  readonly loadedConfig: LoadedExperimentConfig;
  readonly appVersion: string;
}

const REHEARSAL_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const REHEARSAL_RESEARCH_ID_PATTERN = "^DEMO-[0-9]{3}$";
const DEVELOPMENT_RESEARCH_ID_PATTERN = "^DEV-[0-9]{3}$";
const DEVELOPMENT_LOG_DIRECTORY = "./data/dev-sessions";
const TEST_RESEARCH_ID_PATTERNS = new Set([
  REHEARSAL_RESEARCH_ID_PATTERN,
  "^TEST-[0-9]{3}$",
]);
const TEST_FORM_URL = "https://docs.google.com/forms/d/e/TEST_FORM_ID/viewform";
const TEST_LOG_DIRECTORIES = new Set([
  "./data/test",
  "./data/e2e-sessions",
  "./data/mock-sessions",
]);
const PRODUCTION_CONFIG_PATH = "config/experiment.json";
const PRODUCTION_SERVER_DIRECTORY = "dist-server";
const PRODUCTION_SERVER_ENTRY = "index.js";
const VERIFIED_PRODUCTION_RELEASE = Symbol("verified-production-release");

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..")
  );
}

function createDevice(
  config: Awaited<ReturnType<typeof loadExperimentConfig>>["config"],
  mode: ServerMode,
): PufferDevice {
  if (config.device.mode === "mock") {
    return new MockPufferDevice({
      timingMode: mode === "test" ? "fast" : "real-time",
      ackTimeoutMs: config.device.ackTimeout,
    });
  }
  if (config.device.mode === "screen") {
    return new ScreenPufferDevice({
      timingMode: mode === "test" ? "fast" : "real-time",
    });
  }
  return new SerialPufferDevice({
    path: config.device.serialPath,
    baudRate: config.device.baudRate,
    ackTimeoutMs: config.device.ackTimeout,
    defaultDeflateRampMs: config.timingMs.deflateRamp,
  });
}

export function inferServerMode(
  modulePath = fileURLToPath(import.meta.url),
): Extract<ServerMode, "development" | "production"> {
  // A compiled CLI entry is always production, even if a inherited shell
  // variable says NODE_ENV=test. Tests select test mode explicitly through
  // startServer({ mode: "test" }).
  if (modulePath.includes(`${sep}dist-server${sep}`)) return "production";
  // Source entrypoints are development-only even when a parent shell sets
  // NODE_ENV=production. Formal production is selected only by the verified,
  // packaged dist-server/index.js entry below.
  return "development";
}

function assertDevelopmentConfig(
  config: Awaited<ReturnType<typeof loadExperimentConfig>>["config"],
): void {
  if (config.device.mode !== "mock") {
    throw new Error(
      "Development mode requires the Mock device adapter. "
        + "Formal screen sessions must start through the production audit gate.",
    );
  }
  if (config.network.allowLan || !REHEARSAL_LOOPBACK_HOSTS.has(config.bindHost)) {
    throw new Error("Development mode must bind to a loopback host and prohibits LAN access.");
  }
  if (config.network.allowExternalRuntimeRequests) {
    throw new Error("Development mode prohibits external runtime requests.");
  }
  if (config.formUrl !== "") {
    throw new Error("Development mode prohibits a Google Form destination.");
  }
  if (config.formAudit?.status === "GO") {
    throw new Error("Development mode prohibits GO form-audit evidence.");
  }
  if (config.researchIdPattern !== DEVELOPMENT_RESEARCH_ID_PATTERN) {
    throw new Error("Development mode requires the DEV-001 research ID format.");
  }
  if (config.logging.directory !== DEVELOPMENT_LOG_DIRECTORY) {
    throw new Error("Development mode requires the isolated data/dev-sessions log directory.");
  }
}

function assertRehearsalConfig(
  config: Awaited<ReturnType<typeof loadExperimentConfig>>["config"],
): void {
  if (config.device.mode !== "mock") {
    throw new Error("Rehearsal mode requires the Mock device adapter.");
  }
  if (config.network.allowLan) {
    throw new Error("Rehearsal mode prohibits LAN access.");
  }
  if (!REHEARSAL_LOOPBACK_HOSTS.has(config.bindHost)) {
    throw new Error("Rehearsal mode must bind to a loopback host.");
  }
  if (config.network.allowExternalRuntimeRequests) {
    throw new Error("Rehearsal mode prohibits external runtime requests.");
  }
  if (config.formUrl !== "") {
    throw new Error("Rehearsal mode prohibits a Google Form destination.");
  }
  if (config.researchIdPattern !== REHEARSAL_RESEARCH_ID_PATTERN) {
    throw new Error("Rehearsal mode requires the DEMO-001 research ID format.");
  }
  if (config.logging.directory !== "./data/mock-sessions") {
    throw new Error("Rehearsal mode requires the isolated data/mock-sessions log directory.");
  }
}

function assertTestConfig(
  config: Awaited<ReturnType<typeof loadExperimentConfig>>["config"],
): void {
  if (config.network.allowLan || !REHEARSAL_LOOPBACK_HOSTS.has(config.bindHost)) {
    throw new Error("Test mode must bind to a loopback host and prohibits LAN access.");
  }
  if (config.network.allowExternalRuntimeRequests) {
    throw new Error("Test mode prohibits external runtime requests.");
  }
  if (config.device.mode === "serial") {
    throw new Error("Test mode prohibits the Serial device adapter.");
  }
  if (config.formUrl !== "" && config.formUrl !== TEST_FORM_URL) {
    throw new Error("Test mode prohibits a real Google Form destination.");
  }
  if (config.formAudit?.status === "GO") {
    throw new Error("Test mode prohibits GO form-audit evidence.");
  }
  if (!TEST_RESEARCH_ID_PATTERNS.has(config.researchIdPattern)) {
    throw new Error("Test mode requires the TEST-001 or DEMO-001 research ID format.");
  }
  if (!TEST_LOG_DIRECTORIES.has(config.logging.directory)) {
    throw new Error("Test mode requires an isolated test log directory.");
  }
}

async function startServerInternal(
  options: InternalStartServerOptions = {},
): Promise<RunningExperimentServer> {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const mode = options.mode ?? inferServerMode();
  if (
    mode === "production"
    && (
      options.productionReleaseCapability !== VERIFIED_PRODUCTION_RELEASE
      || options.verifiedProductionConfig === undefined
      || options.verifiedAppVersion === undefined
    )
  ) {
    throw new Error(
      "Production mode can start only from a verified sealed release CLI.",
    );
  }
  if (options.serveBuiltAssets === true && mode !== "test") {
    throw new Error("serveBuiltAssets is available only in explicit test mode.");
  }
  if (
    mode !== "production"
    && (options.verifiedProductionConfig !== undefined || options.verifiedAppVersion !== undefined)
  ) {
    throw new Error("Verified production release values cannot be used outside production mode.");
  }
  const loaded = options.verifiedProductionConfig ?? await loadExperimentConfig(
      options.configPath ?? process.env.EXPERIMENT_CONFIG_PATH ?? "config/experiment.json",
      { rootDirectory },
    );
  const { config } = loaded;
  if (mode === "development") assertDevelopmentConfig(config);
  if (mode === "rehearsal") assertRehearsalConfig(config);
  if (mode === "test") assertTestConfig(config);
  const appVersion = mode === "production"
    ? options.verifiedAppVersion as string
    : process.env.npm_package_version ?? "1.0.0";
  const dataDirectory = resolve(rootDirectory, "data");
  const configuredLogDirectory = resolve(
    rootDirectory,
    mode === "production"
      ? config.logging.directory
      : process.env.DATA_DIRECTORY ?? config.logging.directory,
  );
  if (
    mode === "rehearsal" &&
    configuredLogDirectory !== resolve(rootDirectory, "data", "mock-sessions")
  ) {
    throw new Error("Rehearsal mode prohibits overriding its isolated mock log directory.");
  }
  if (
    mode === "development"
    && !isInside(resolve(rootDirectory, DEVELOPMENT_LOG_DIRECTORY), configuredLogDirectory)
  ) {
    throw new Error("Development mode prohibits overriding its isolated development log directory.");
  }
  if (
    mode === "test"
    && ![...TEST_LOG_DIRECTORIES].some(
      (directory) => isInside(resolve(rootDirectory, directory), configuredLogDirectory),
    )
  ) {
    throw new Error("Test mode prohibits overriding its isolated test log directory.");
  }
  if (!isInside(dataDirectory, configuredLogDirectory)) {
    throw new Error(
      "The configured logging directory must remain inside the repository data directory.",
    );
  }
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(configuredLogDirectory, { recursive: true, mode: 0o700 });
  const [dataStat, logStat, realDataDirectory, realLogDirectory] = await Promise.all([
    lstat(dataDirectory),
    lstat(configuredLogDirectory),
    realpath(dataDirectory),
    realpath(configuredLogDirectory),
  ]);
  if (
    dataStat.isSymbolicLink() ||
    logStat.isSymbolicLink() ||
    !isInside(realDataDirectory, realLogDirectory)
  ) {
    throw new Error(
      "The logging directory must not use a symbolic link or junction outside data/.",
    );
  }

  const runtimeLock = await acquireExperimentServerLock(dataDirectory, loaded.configHash);
  try {
    if (runtimeLock.recoveredStaleLock) {
      console.warn(
        "Recovered a stale experiment server lock. The previous process may have exited abnormally; " +
          "review the device state and interrupted-session logs before continuing.",
      );
    }

    const operatorToken = config.network.allowLan ? randomBytes(32).toString("base64url") : null;
    const device = createDevice(config, mode);
    const logger = new ExperimentLogger({ directory: configuredLogDirectory });
    const existingSummaries = await logger.listSessionSummaries();
    const interruptedRuns = existingSummaries.filter(
      (summary) => summary.result === null && summary.presentationsStarted > 0,
    ).length;
    if (interruptedRuns > 0) {
      console.warn(
        `${interruptedRuns} interrupted session(s) were found in local logs; ` +
          "they remain non-complete and count as used for order balancing.",
      );
    }
    const controller = new SessionController({
      config,
      configHash: loaded.configHash,
      appVersion,
      rehearsal: mode !== "production",
      device,
      logger,
    });
    const testHooks = mode === "test"
      && options.serveBuiltAssets !== true
      && device instanceof MockPufferDevice
      ? {
          injectUnexpectedMockDisconnect(command: "status" | "inflate" | "deflate"): void {
            device.inject({ kind: "disconnect", command });
          },
          readMockDeviceCommands(): readonly string[] {
            return device.commandHistory.map(({ command }) => command);
          },
        }
      : undefined;
    const application = await createApplication({
      controller,
      config,
      configHash: loaded.configHash,
      appVersion,
      mode,
      rootDirectory,
      ...(operatorToken === null ? {} : { operatorToken }),
      ...(testHooks === undefined ? {} : { testHooks }),
      ...(options.serveBuiltAssets === true ? { serveBuiltAssets: true } : {}),
    });
    const httpServer = createServer(application.app);
    const webSocketHub = new WebSocketHub(httpServer, controller, {
      ...(operatorToken === null ? {} : { operatorToken }),
      allowLan: config.network.allowLan,
    });
    const autoConnectDevice = mode === "rehearsal" || config.device.mode === "screen";

    try {
      if (autoConnectDevice) {
        const status = await controller.connectDevice();
        if (
          !status.connected
          || status.state !== "idle"
          || status.level !== 0
          || status.fault !== null
        ) {
          throw new Error(
            mode === "rehearsal"
              ? "The rehearsal Mock device did not reach a verified idle state."
              : "The screen puffer device did not reach a verified idle state.",
          );
        }
      }
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error): void => rejectListen(error);
        httpServer.once("error", onError);
        httpServer.listen(config.port, config.bindHost, () => {
          httpServer.off("error", onError);
          resolveListen();
        });
      });
    } catch (error) {
      webSocketHub.close();
      controller.dispose();
      httpServer.closeAllConnections();
      if (autoConnectDevice) {
        try {
          await device.disconnect();
        } catch {
          // Preserve the original startup failure. Neither adapter owns a physical actuator.
        }
      }
      await Promise.race([
        application.close(),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
      ]);
      throw error;
    }

    let closePromise: Promise<void> | undefined;
    const closeServer = async (): Promise<void> => {
      const shutdownErrors: Error[] = [];
      const httpClosed = new Promise<void>((resolveClose) => {
        httpServer.close(() => resolveClose());
      });
      webSocketHub.close();
      httpServer.closeAllConnections();
      try {
        await controller.shutdown();
      } catch (error) {
        shutdownErrors.push(error instanceof Error ? error : new Error("Session shutdown failed."));
      } finally {
        controller.dispose();
      }
      // Always perform the adapter's independent STOP/DEFLATE/port-close path,
      // even if the session-level safety path failed.
      try {
        await device.disconnect();
      } catch (error) {
        shutdownErrors.push(
          error instanceof Error ? error : new Error("Device disconnect failed."),
        );
      }
      try {
        await Promise.race([
          application.close(),
          new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
        ]);
      } catch (error) {
        shutdownErrors.push(
          error instanceof Error ? error : new Error("Application close failed."),
        );
      }
      try {
        await Promise.race([
          httpClosed,
          new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
        ]);
      } catch (error) {
        shutdownErrors.push(error instanceof Error ? error : new Error("HTTP close failed."));
      }
      try {
        await runtimeLock.release();
      } catch (error) {
        shutdownErrors.push(
          error instanceof Error ? error : new Error("Runtime lock release failed."),
        );
      }
      if (shutdownErrors.length > 0) {
        throw new AggregateError(
          shutdownErrors,
          "Experiment server shutdown did not complete cleanly.",
        );
      }
    };
    return {
      host: config.bindHost,
      port: config.port,
      url: `http://${config.bindHost}:${config.port}`,
      operatorToken,
      shutdownDeadlineMs: Math.max(
        20_000,
        config.timingMs.deflateRamp * 2 + config.device.ackTimeout * 6 + 10_000,
      ),
      close(): Promise<void> {
        closePromise ??= closeServer();
        return closePromise;
      },
    };
  } catch (startupError) {
    try {
      await runtimeLock.release();
    } catch (releaseError) {
      throw new AggregateError(
        [
          startupError instanceof Error
            ? startupError
            : new Error("Experiment server startup failed."),
          releaseError instanceof Error ? releaseError : new Error("Runtime lock release failed."),
        ],
        "Experiment server startup failed and its runtime lock could not be released.",
        { cause: releaseError },
      );
    }
    throw startupError;
  }
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<RunningExperimentServer> {
  return startServerInternal(options);
}

/**
 * Starts the compiled production CLI only from a complete, verified release.
 *
 * The release root and config path are derived from the compiled entry rather
 * than the working directory. Environment overrides are rejected instead of
 * being silently accepted, so a launcher cannot redirect either the formal
 * config or its configured log destination after manifest verification.
 */
export async function startProductionReleaseCli(
  options: ProductionReleaseCliOptions = {},
): Promise<RunningExperimentServer> {
  const environment = options.environment ?? process.env;
  const forbiddenOverrides = [
    environment.EXPERIMENT_CONFIG_PATH === undefined ? null : "EXPERIMENT_CONFIG_PATH",
    environment.DATA_DIRECTORY === undefined ? null : "DATA_DIRECTORY",
  ].filter((name): name is string => name !== null);
  if (forbiddenOverrides.length > 0) {
    throw new Error(
      `Production CLI prohibits environment overrides: ${forbiddenOverrides.join(", ")}.`,
    );
  }

  const entryPath = resolve(options.entryPath ?? fileURLToPath(import.meta.url));
  const serverDirectory = dirname(entryPath);
  if (
    basename(entryPath) !== PRODUCTION_SERVER_ENTRY
    || basename(serverDirectory) !== PRODUCTION_SERVER_DIRECTORY
  ) {
    throw new Error(
      "Production CLI must run as dist-server/index.js inside a packaged release.",
    );
  }
  const releaseDirectory = resolve(serverDirectory, "..");
  const verifyRelease = options.verifyRelease ?? verifyReleaseDirectoryDetailed;
  const verification = await verifyRelease(releaseDirectory);
  if (verification.errors.length > 0) {
    throw new Error(
      `Production release verification failed: ${verification.errors.join("; ")}`,
    );
  }
  if (verification.manifest === null) {
    throw new Error("Production release verification returned no manifest binding.");
  }

  const loadConfig = options.loadConfig ?? loadExperimentConfig;
  const loadedConfig = await loadConfig(PRODUCTION_CONFIG_PATH, {
    rootDirectory: releaseDirectory,
    production: true,
  });
  const bindingMismatches = [
    loadedConfig.configFileHash === verification.manifest.configFileHash
      ? null
      : "configFileHash",
    loadedConfig.configHash === verification.manifest.configHash ? null : "configHash",
    loadedConfig.config.protocolVersion === verification.manifest.protocolVersion
      ? null
      : "protocolVersion",
  ].filter((name): name is string => name !== null);
  if (bindingMismatches.length > 0) {
    throw new Error(
      `Production config does not match the verified release manifest: ${bindingMismatches.join(", ")}.`,
    );
  }
  if (
    options.start === undefined
    && (options.verifyRelease !== undefined || options.loadConfig !== undefined)
  ) {
    throw new Error(
      "Production verification and config-loader overrides are test-only and require a custom start seam.",
    );
  }

  const start = options.start ?? ((input: VerifiedProductionStartOptions) =>
    startServerInternal({
      rootDirectory: input.rootDirectory,
      configPath: PRODUCTION_CONFIG_PATH,
      mode: "production",
      productionReleaseCapability: VERIFIED_PRODUCTION_RELEASE,
      verifiedProductionConfig: input.loadedConfig,
      verifiedAppVersion: input.appVersion,
    }));
  return start({
    rootDirectory: releaseDirectory,
    loadedConfig,
    appVersion: verification.manifest.appVersion,
  });
}

/** Runs a CLI entry with the same STOP/DEFLATE shutdown path in every server mode. */
export function runServerCli(options: ServerCliOptions = {}): void {
  const start = options.start ?? (() => startServer());
  const listeningLabel = options.listeningLabel ?? "SecHack experiment server";
  const stoppedMessage = options.stoppedMessage
    ?? "Experiment server stopped after STOP/DEFLATE shutdown.";
  let running: RunningExperimentServer | undefined;
  void start()
    .then((server) => {
      running = server;
      console.info(`${listeningLabel} listening at ${server.url}`);
      if (server.operatorToken !== null) {
        console.info(`LAN Operator token: ${server.operatorToken}`);
        const token = encodeURIComponent(server.operatorToken);
        console.info(`Operator URL: ${server.url}/operator?operatorToken=${token}`);
        console.info(`Device test URL: ${server.url}/device-test?operatorToken=${token}`);
        if (server.host === "0.0.0.0" || server.host === "::") {
          console.info("Replace the bind host in these URLs with this computer's LAN IP address.");
        }
      }
      let shutdownStarted = false;
      const shutdown = (exitCode: 0 | 1): void => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        console.info("Stopping the experiment server; waiting for STOP/DEFLATE confirmation...");
        const safetyTimeoutMs = running?.shutdownDeadlineMs ?? 190_000;
        const forceExit = setTimeout(() => {
          console.error("Safe shutdown did not complete before the configured safety deadline.");
          process.exit(1);
        }, safetyTimeoutMs);
        void running?.close().then(
          () => {
            clearTimeout(forceExit);
            console.info(stoppedMessage);
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
      console.error(
        error instanceof Error ? error.message : "Failed to start the experiment server.",
      );
      process.exitCode = 1;
    });
}

function isProductionCliEntry(entryPath: string | undefined): boolean {
  if (entryPath === undefined || pathToFileURL(resolve(entryPath)).href !== import.meta.url) {
    return false;
  }
  // Bundling index.ts into rehearsal.js rewrites import.meta.url to the rehearsal
  // output URL. Checking the basename prevents the production entry from also
  // starting inside that bundle.
  const entryName = basename(fileURLToPath(import.meta.url));
  return entryName === "index.ts" || entryName === "index.js";
}

if (isProductionCliEntry(process.argv[1])) {
  const entryName = basename(fileURLToPath(import.meta.url));
  runServerCli(
    entryName === PRODUCTION_SERVER_ENTRY
      ? { start: () => startProductionReleaseCli() }
      : {},
  );
}
