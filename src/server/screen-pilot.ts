import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  consumeScreenPilotLaunchCapability,
  type ScreenPilotLaunchCapability,
} from "./screen-pilot-provenance.js";
import {
  startScreenPilotRuntime,
  type RunningScreenPilotRuntime,
} from "./screen-pilot-runtime.js";

const SCREEN_PILOT_CLI_FLAG = "--screen-pilot";
const CAPABILITY_MESSAGE_TYPE = "screen-pilot.capability";
const CAPABILITY_WAIT_MS = 5_000;

function receiveLaunchCapability(): Promise<ScreenPilotLaunchCapability> {
  if (typeof process.send !== "function") {
    throw new Error("Direct screen-pilot execution is prohibited; use npm run screen-pilot.");
  }
  return new Promise<ScreenPilotLaunchCapability>((resolveCapability, rejectCapability) => {
    const timeout = setTimeout(() => {
      rejectCapability(new Error("Screen-pilot launcher capability was not received."));
    }, CAPABILITY_WAIT_MS);
    process.once("message", (message: unknown) => {
      clearTimeout(timeout);
      if (
        message === null
        || typeof message !== "object"
        || (message as Readonly<Record<string, unknown>>)["type"] !== CAPABILITY_MESSAGE_TYPE
      ) {
        rejectCapability(new Error("Screen-pilot launcher sent an invalid capability envelope."));
        return;
      }
      resolveCapability(
        (message as Readonly<Record<string, unknown>>)["capability"] as ScreenPilotLaunchCapability,
      );
    });
  });
}

export async function startAuthorizedScreenPilot(
  entryPath = fileURLToPath(import.meta.url),
): Promise<RunningScreenPilotRuntime> {
  const capability = await receiveLaunchCapability();
  const verified = await consumeScreenPilotLaunchCapability(capability, entryPath);
  if (process.connected && typeof process.disconnect === "function") process.disconnect();
  return startScreenPilotRuntime(
    verified,
    process.env.npm_package_version ?? "1.1.0",
  );
}

function runScreenPilotCli(): void {
  if (process.argv.length !== 3 || process.argv[2] !== SCREEN_PILOT_CLI_FLAG) {
    console.error("Screen-pilot startup is available only through npm run screen-pilot.");
    process.exitCode = 1;
    return;
  }
  let running: RunningScreenPilotRuntime | undefined;
  void startAuthorizedScreenPilot()
    .then((server) => {
      running = server;
      console.info(
        "Nonparticipant screen-pilot started from a fresh verified build. "
          + "Do not enroll research participants.",
      );
      console.info(`Screen-pilot listening at ${server.url}`);
      console.info(`Screen-pilot source commit: ${server.sourceEvidence.sourceCommit}`);
      console.info(`Screen-pilot source tree SHA-256: ${server.sourceEvidence.sourceTreeSha256}`);
      console.info(`Screen-pilot config file SHA-256: ${server.sourceEvidence.configFileHash}`);
      let shutdownStarted = false;
      const shutdown = (exitCode: 0 | 1): void => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        const forceExit = setTimeout(() => process.exit(1), running?.shutdownDeadlineMs ?? 190_000);
        void running?.close().then(
          () => {
            clearTimeout(forceExit);
            process.exit(exitCode);
          },
          () => {
            clearTimeout(forceExit);
            process.exit(1);
          },
        );
      };
      process.on("SIGINT", () => shutdown(0));
      process.on("SIGTERM", () => shutdown(0));
      process.on("SIGBREAK", () => shutdown(0));
      process.once("uncaughtException", () => shutdown(1));
      process.once("unhandledRejection", () => shutdown(1));
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Screen-pilot startup failed.");
      process.exitCode = 1;
    });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runScreenPilotCli();
}
