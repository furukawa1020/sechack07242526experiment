import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadExperimentConfig } from "../shared/config-loader.js";
import { createApplication } from "./app.js";
import { MockPufferDevice, SerialPufferDevice, type PufferDevice } from "./devices/index.js";
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
  /** Test-only: audit built static assets while retaining the fast Mock adapter. */
  readonly serveBuiltAssets?: boolean;
}

export type ServerMode = "development" | "production" | "rehearsal" | "test";

export interface ServerCliOptions {
  readonly start?: () => Promise<RunningExperimentServer>;
  readonly listeningLabel?: string;
  readonly stoppedMessage?: string;
}

const REHEARSAL_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const REHEARSAL_RESEARCH_ID_PATTERN = "^DEMO-[0-9]{3}$";

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
  return new SerialPufferDevice({
    path: config.device.serialPath,
    baudRate: config.device.baudRate,
    ackTimeoutMs: config.device.ackTimeout,
    defaultDeflateRampMs: config.timingMs.deflateRamp,
  });
}

export function inferServerMode(
  modulePath = fileURLToPath(import.meta.url),
  nodeEnvironment = process.env.NODE_ENV,
): Exclude<ServerMode, "rehearsal"> {
  // A compiled CLI entry is always production, even if a inherited shell
  // variable says NODE_ENV=test. Tests select test mode explicitly through
  // startServer({ mode: "test" }).
  if (modulePath.includes(`${sep}dist-server${sep}`)) return "production";
  if (nodeEnvironment === "test") return "test";
  if (nodeEnvironment === "production") return "production";
  return "development";
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

export async function startServer(
  options: StartServerOptions = {},
): Promise<RunningExperimentServer> {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const mode = options.mode ?? inferServerMode();
  if (options.serveBuiltAssets === true && mode !== "test") {
    throw new Error("serveBuiltAssets is available only in explicit test mode.");
  }
  const loaded = await loadExperimentConfig(
    options.configPath ?? process.env.EXPERIMENT_CONFIG_PATH ?? "config/experiment.json",
    {
      rootDirectory,
      production: mode === "production",
    },
  );
  const { config } = loaded;
  if (mode === "rehearsal") assertRehearsalConfig(config);
  const appVersion = process.env.npm_package_version ?? "1.0.0";
  const dataDirectory = resolve(rootDirectory, "data");
  const configuredLogDirectory = resolve(
    rootDirectory,
    process.env.DATA_DIRECTORY ?? config.logging.directory,
  );
  if (
    mode === "rehearsal" &&
    configuredLogDirectory !== resolve(rootDirectory, "data", "mock-sessions")
  ) {
    throw new Error("Rehearsal mode prohibits overriding its isolated mock log directory.");
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
      rehearsal: mode === "rehearsal",
      device,
      logger,
    });
    const testHooks = mode === "test" && device instanceof MockPufferDevice
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
      mode: options.serveBuiltAssets === true ? "production" : mode,
      rootDirectory,
      ...(operatorToken === null ? {} : { operatorToken }),
      ...(testHooks === undefined ? {} : { testHooks }),
    });
    const httpServer = createServer(application.app);
    const webSocketHub = new WebSocketHub(httpServer, controller, {
      ...(operatorToken === null ? {} : { operatorToken }),
      allowLan: config.network.allowLan,
    });

    try {
      if (mode === "rehearsal") {
        const status = await controller.connectDevice();
        if (
          !status.connected
          || status.state !== "idle"
          || status.level !== 0
          || status.fault !== null
        ) {
          throw new Error("The rehearsal Mock device did not reach a verified idle state.");
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
      if (mode === "rehearsal") {
        try {
          await device.disconnect();
        } catch {
          // Preserve the original startup failure. The Mock adapter owns no physical actuator.
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

/** Runs a CLI entry with the same STOP/DEFLATE shutdown path in every server mode. */
export function runServerCli(options: ServerCliOptions = {}): void {
  const start = options.start ?? (() => startServer());
  const listeningLabel = options.listeningLabel ?? "SecHack experiment server";
  const stoppedMessage = options.stoppedMessage
    ?? "Experiment server stopped; verify the physical device is deflated.";
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

if (isProductionCliEntry(process.argv[1])) runServerCli();
