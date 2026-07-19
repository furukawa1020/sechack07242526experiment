import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadExperimentConfig } from "../shared/config-loader.js";
import { createApplication } from "./app.js";
import {
  MockPufferDevice,
  SerialPufferDevice,
  type PufferDevice,
} from "./devices/index.js";
import { ExperimentLogger } from "./logging/index.js";
import { SessionController } from "./sessions/session-controller.js";
import { WebSocketHub } from "./websocket/websocket-hub.js";

export interface RunningExperimentServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly operatorToken: string | null;
  close(): Promise<void>;
}

export interface StartServerOptions {
  readonly rootDirectory?: string;
  readonly configPath?: string;
  readonly mode?: "development" | "production" | "test";
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..");
}

function createDevice(
  config: Awaited<ReturnType<typeof loadExperimentConfig>>["config"],
  mode: "development" | "production" | "test",
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

function inferMode(): "development" | "production" | "test" {
  if (process.env.NODE_ENV === "test") return "test";
  if (process.env.NODE_ENV === "production") return "production";
  return fileURLToPath(import.meta.url).includes(`${sep}dist-server${sep}`) ? "production" : "development";
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningExperimentServer> {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const mode = options.mode ?? inferMode();
  const loaded = await loadExperimentConfig(
    options.configPath ?? process.env.EXPERIMENT_CONFIG_PATH ?? "config/experiment.json",
    {
      rootDirectory,
      production: process.env.NODE_ENV === "production",
    },
  );
  const { config } = loaded;
  const dataDirectory = resolve(rootDirectory, "data");
  const configuredLogDirectory = resolve(
    rootDirectory,
    process.env.DATA_DIRECTORY ?? config.logging.directory,
  );
  if (!isInside(dataDirectory, configuredLogDirectory)) {
    throw new Error("The configured logging directory must remain inside the repository data directory.");
  }

  const operatorToken = config.network.allowLan ? randomBytes(32).toString("base64url") : null;
  const device = createDevice(config, mode);
  const logger = new ExperimentLogger({ directory: configuredLogDirectory });
  const controller = new SessionController({
    config,
    configHash: loaded.configHash,
    appVersion: process.env.npm_package_version ?? "1.0.0",
    device,
    logger,
  });
  const application = await createApplication({
    controller,
    config,
    mode,
    rootDirectory,
    ...(operatorToken === null ? {} : { operatorToken }),
  });
  const httpServer = createServer(application.app);
  const webSocketHub = new WebSocketHub(httpServer, controller, {
    ...(operatorToken === null ? {} : { operatorToken }),
    allowLan: config.network.allowLan,
  });

  try {
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
    await Promise.race([
      application.close(),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ]);
    throw error;
  }

  let closed = false;
  return {
    host: config.bindHost,
    port: config.port,
    url: `http://${config.bindHost}:${config.port}`,
    operatorToken,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const httpClosed = new Promise<void>((resolveClose) => {
        httpServer.close(() => resolveClose());
      });
      webSocketHub.close();
      httpServer.closeAllConnections();
      await controller.shutdown();
      controller.dispose();
      try {
        await device.disconnect();
      } catch {
        // The device is already safe-stopped or physically disconnected.
      }
      await Promise.race([
        application.close(),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
      ]);
      await Promise.race([
        httpClosed,
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
      ]);
    },
  };
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  let running: RunningExperimentServer | undefined;
  void startServer()
    .then((server) => {
      running = server;
      console.info(`SecHack experiment server listening at ${server.url}`);
      if (server.operatorToken !== null) {
        console.info(`LAN Operator token: ${server.operatorToken}`);
        const token = encodeURIComponent(server.operatorToken);
        console.info(`Operator URL: ${server.url}/operator?operatorToken=${token}`);
        console.info(`Device test URL: ${server.url}/device-test?operatorToken=${token}`);
        if (server.host === "0.0.0.0" || server.host === "::") {
          console.info("Replace the bind host in these URLs with this computer's LAN IP address.");
        }
      }
      const shutdown = (): void => {
        const forceExit = setTimeout(() => process.exit(1), 5_000);
        void running?.close().then(
          () => {
            clearTimeout(forceExit);
            process.exit(0);
          },
          (error: unknown) => {
            clearTimeout(forceExit);
            console.error(error instanceof Error ? error.message : "Server shutdown failed.");
            process.exit(1);
          },
        );
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Failed to start the experiment server.");
      process.exitCode = 1;
    });
}
