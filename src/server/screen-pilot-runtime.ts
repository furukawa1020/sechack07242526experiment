import { lstat, mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { SCREEN_PROTOCOL_VERSION, type ExperimentConfig } from "../shared/schemas.js";
import { createProductionApplication } from "./production-app.js";
import { ScreenPufferDevice } from "./devices/screen-puffer-device.js";
import { ExperimentLogger } from "./logging/experiment-log.js";
import { acquireExperimentServerLock } from "./runtime-lock.js";
import type {
  ScreenPilotSourceEvidence,
  VerifiedScreenPilotLaunch,
} from "./screen-pilot-provenance.js";
import { SessionController } from "./sessions/session-controller.js";
import { WebSocketHub } from "./websocket/websocket-hub.js";

export interface RunningScreenPilotRuntime {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly operatorToken: null;
  readonly shutdownDeadlineMs: number;
  readonly sourceEvidence: ScreenPilotSourceEvidence;
  close(): Promise<void>;
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (
      !isAbsolute(pathFromParent)
      && pathFromParent !== ".."
      && !pathFromParent.startsWith(`..${sep}`)
    );
}

async function closeApplicationWithDeadline(
  application: Awaited<ReturnType<typeof createProductionApplication>>,
): Promise<void> {
  await Promise.race([
    application.close(),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function assertPilotConfig(config: ExperimentConfig): void {
  const failures: string[] = [];
  if (config.protocolVersion !== SCREEN_PROTOCOL_VERSION) failures.push("protocolVersion");
  if (config.bindHost !== "127.0.0.1" || config.port !== 4_174) failures.push("loopback endpoint");
  if (config.researchIdPattern !== "^PILOT-[0-9]{3}$") failures.push("researchIdPattern");
  if (config.orders.join(",") !== "ABDC,BCAD,CDBA,DACB") failures.push("orders");
  if (
    config.fixedState.score !== 72
    || config.fixedState.label !== "高ストレス"
    || config.fixedState.pufferLevel !== 0.6
  ) failures.push("fixedState");
  if (
    config.timingMs.handling !== 8_000
    || config.timingMs.processing !== 3_000
    || config.timingMs.result !== 15_000
    || config.timingMs.reset !== 7_000
    || config.timingMs.inflateRamp !== 6_000
    || config.timingMs.deflateRamp !== 6_000
  ) failures.push("timingMs");
  if (
    config.device.mode !== "screen"
    || config.device.serialPath !== ""
    || config.device.allowMockInProduction
  ) failures.push("ScreenPufferDevice");
  if (config.formUrl !== "" || config.formAudit !== undefined || config.goEvidence !== undefined) {
    failures.push("external/production evidence");
  }
  if (
    config.logging.directory !== "./data/screen-pilot-sessions"
    || !config.logging.includeAbortedInOrderBalancing
  ) failures.push("isolated logging");
  if (config.network.allowLan || config.network.allowExternalRuntimeRequests) failures.push("network");
  if (failures.length > 0) {
    throw new Error(`Screen-pilot fixed config gate failed: ${failures.join(", ")}.`);
  }
}

export async function startScreenPilotRuntime(
  verified: VerifiedScreenPilotLaunch,
  appVersion: string,
): Promise<RunningScreenPilotRuntime> {
  if (process.env.EXPERIMENT_CONFIG_PATH !== undefined || process.env.DATA_DIRECTORY !== undefined) {
    throw new Error("Screen-pilot prohibits config and log-directory environment overrides.");
  }
  const rootDirectory = resolve(verified.rootDirectory);
  const { config } = verified.loadedConfig;
  assertPilotConfig(config);
  const dataDirectory = resolve(rootDirectory, "data");
  const logDirectory = resolve(rootDirectory, config.logging.directory);
  if (!isInside(dataDirectory, logDirectory)) {
    throw new Error("Screen-pilot logging directory escaped data/.");
  }
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const [dataStat, logStat, realData, realLog] = await Promise.all([
    lstat(dataDirectory),
    lstat(logDirectory),
    realpath(dataDirectory),
    realpath(logDirectory),
  ]);
  if (
    dataStat.isSymbolicLink()
    || logStat.isSymbolicLink()
    || !isInside(realData, realLog)
  ) throw new Error("Screen-pilot logging directory must not use links or junctions.");

  const runtimeLock = await acquireExperimentServerLock(dataDirectory, verified.loadedConfig.configHash);
  try {
    const device = new ScreenPufferDevice({ timingMode: "real-time" });
    const logger = new ExperimentLogger({ directory: logDirectory });
    await logger.listSessionSummaries();
    const controller = new SessionController({
      config,
      configHash: verified.loadedConfig.configHash,
      appVersion,
      rehearsal: true,
      device,
      logger,
      screenPilotSourceEvidence: verified.evidence,
    });
    const application = await createProductionApplication({
      controller,
      config,
      configHash: verified.loadedConfig.configHash,
      appVersion,
      clientAssets: verified.clientAssets,
    });
    const httpServer = createServer(application.app);
    const webSocketHub = new WebSocketHub(httpServer, controller, { allowLan: false });
    try {
      const status = await controller.connectDevice();
      if (!status.connected || status.state !== "idle" || status.level !== 0 || status.fault !== null) {
        throw new Error("The pilot ScreenPufferDevice did not reach a verified idle state.");
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
      const cleanupErrors: Error[] = [];
      webSocketHub.close();
      controller.dispose();
      httpServer.closeAllConnections();
      try {
        await device.disconnect();
      } catch (disconnectError) {
        cleanupErrors.push(asError(disconnectError, "Pilot device cleanup failed."));
      }
      try {
        await closeApplicationWithDeadline(application);
      } catch (applicationError) {
        cleanupErrors.push(asError(applicationError, "Pilot application cleanup failed."));
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [asError(error, "Screen-pilot startup failed."), ...cleanupErrors],
          "Screen-pilot startup and cleanup did not complete cleanly.",
          { cause: error },
        );
      }
      throw error;
    }

    let closePromise: Promise<void> | undefined;
    const close = async (): Promise<void> => {
      const errors: Error[] = [];
      const httpClosed = new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
      webSocketHub.close();
      httpServer.closeAllConnections();
      try { await controller.shutdown(); } catch (error) {
        errors.push(error instanceof Error ? error : new Error("Pilot shutdown failed."));
      } finally { controller.dispose(); }
      try { await device.disconnect(); } catch (error) {
        errors.push(asError(error, "Pilot device disconnect failed."));
      }
      try {
        await closeApplicationWithDeadline(application);
      } catch (error) {
        errors.push(asError(error, "Pilot application close failed."));
      }
      try {
        await Promise.race([
          httpClosed,
          new Promise<void>((done) => setTimeout(done, 2_000)),
        ]);
      } catch (error) {
        errors.push(asError(error, "Pilot HTTP close failed."));
      }
      try { await runtimeLock.release(); } catch (error) {
        errors.push(asError(error, "Pilot lock release failed."));
      }
      if (errors.length > 0) throw new AggregateError(errors, "Screen-pilot shutdown failed.");
    };
    return {
      host: config.bindHost,
      port: config.port,
      url: `http://${config.bindHost}:${String(config.port)}`,
      operatorToken: null,
      shutdownDeadlineMs: Math.max(
        20_000,
        config.timingMs.deflateRamp * 2 + config.device.ackTimeout * 6 + 10_000,
      ),
      sourceEvidence: verified.evidence,
      close(): Promise<void> {
        closePromise ??= close();
        return closePromise;
      },
    };
  } catch (startupError) {
    try {
      await runtimeLock.release();
    } catch (releaseError) {
      throw new AggregateError(
        [
          asError(startupError, "Screen-pilot startup failed."),
          asError(releaseError, "Pilot runtime lock release failed."),
        ],
        "Screen-pilot startup failed and its runtime lock could not be released.",
        { cause: releaseError },
      );
    }
    throw startupError;
  }
}
