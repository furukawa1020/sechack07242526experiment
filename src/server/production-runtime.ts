import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { relative, resolve, sep } from "node:path";

import type { ExperimentConfig } from "../shared/schemas.js";
import { ScreenPufferDevice } from "./devices/screen-puffer-device.js";
import { ExperimentLogger } from "./logging/experiment-log.js";
import {
  createProductionApplication,
  type ProductionApplicationRuntime,
} from "./production-app.js";
import { acquireExperimentServerLock } from "./runtime-lock.js";
import { SessionController } from "./sessions/session-controller.js";
import { WebSocketHub } from "./websocket/websocket-hub.js";

export interface ProductionLoadedConfigSnapshot {
  readonly config: ExperimentConfig;
  readonly configHash: string;
}

export interface StartProductionRuntimeOptions {
  readonly rootDirectory: string;
  readonly loadedConfig: ProductionLoadedConfigSnapshot;
  readonly appVersion: string;
}

export interface RunningProductionRuntime {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly operatorToken: string | null;
  readonly shutdownDeadlineMs: number;
  close(): Promise<void>;
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..")
  );
}

async function closeApplicationWithDeadline(
  application: ProductionApplicationRuntime,
): Promise<void> {
  await Promise.race([
    application.close(),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
}

/**
 * Starts a formal runtime from an already verified, immutable config snapshot.
 * Verification and GO-evidence loading remain the responsibility of the sealed
 * production entry; this boundary cannot select Mock or Serial adapters.
 */
export async function startProductionRuntime(
  options: StartProductionRuntimeOptions,
): Promise<RunningProductionRuntime> {
  const rootDirectory = resolve(options.rootDirectory);
  const { config } = options.loadedConfig;
  if (config.device.mode !== "screen") {
    throw new Error("Formal production runtime requires the ScreenPufferDevice adapter.");
  }

  const dataDirectory = resolve(rootDirectory, "data");
  const configuredLogDirectory = resolve(rootDirectory, config.logging.directory);
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
    dataStat.isSymbolicLink()
    || logStat.isSymbolicLink()
    || !isInside(realDataDirectory, realLogDirectory)
  ) {
    throw new Error(
      "The logging directory must not use a symbolic link or junction outside data/.",
    );
  }

  const runtimeLock = await acquireExperimentServerLock(
    dataDirectory,
    options.loadedConfig.configHash,
  );
  try {
    if (runtimeLock.recoveredStaleLock) {
      console.warn(
        "Recovered a stale experiment server lock. The previous process may have exited abnormally; "
          + "review the device state and interrupted-session logs before continuing.",
      );
    }

    const operatorToken = config.network.allowLan
      ? randomBytes(32).toString("base64url")
      : null;
    const device = new ScreenPufferDevice({ timingMode: "real-time" });
    const logger = new ExperimentLogger({ directory: configuredLogDirectory });
    const existingSummaries = await logger.listSessionSummaries();
    const interruptedRuns = existingSummaries.filter(
      (summary) => summary.result === null && summary.presentationsStarted > 0,
    ).length;
    if (interruptedRuns > 0) {
      console.warn(
        `${interruptedRuns} interrupted session(s) were found in local logs; `
          + "they remain non-complete and count as used for order balancing.",
      );
    }
    const controller = new SessionController({
      config,
      configHash: options.loadedConfig.configHash,
      appVersion: options.appVersion,
      rehearsal: false,
      device,
      logger,
    });
    const application = await createProductionApplication({
      controller,
      config,
      configHash: options.loadedConfig.configHash,
      appVersion: options.appVersion,
      rootDirectory,
      ...(operatorToken === null ? {} : { operatorToken }),
    });
    const httpServer = createServer(application.app);
    const webSocketHub = new WebSocketHub(httpServer, controller, {
      ...(operatorToken === null ? {} : { operatorToken }),
      allowLan: config.network.allowLan,
    });

    try {
      const status = await controller.connectDevice();
      if (
        !status.connected
        || status.state !== "idle"
        || status.level !== 0
        || status.fault !== null
      ) {
        throw new Error("The screen puffer device did not reach a verified idle state.");
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
      try {
        await device.disconnect();
      } catch {
        // Preserve the startup failure. ScreenPufferDevice owns no physical actuator.
      }
      await closeApplicationWithDeadline(application);
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
        shutdownErrors.push(
          error instanceof Error ? error : new Error("Session shutdown failed."),
        );
      } finally {
        controller.dispose();
      }
      try {
        await device.disconnect();
      } catch (error) {
        shutdownErrors.push(
          error instanceof Error ? error : new Error("Device disconnect failed."),
        );
      }
      try {
        await closeApplicationWithDeadline(application);
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
        shutdownErrors.push(
          error instanceof Error ? error : new Error("HTTP close failed."),
        );
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
          releaseError instanceof Error
            ? releaseError
            : new Error("Runtime lock release failed."),
        ],
        "Experiment server startup failed and its runtime lock could not be released.",
        { cause: releaseError },
      );
    }
    throw startupError;
  }
}
