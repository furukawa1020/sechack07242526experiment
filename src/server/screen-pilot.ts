import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  consumeScreenPilotLaunchCapability,
  parseScreenPilotEmbeddedBuildEvidence,
  type ScreenPilotLaunchCapability,
} from "./screen-pilot-provenance.js";
import {
  startScreenPilotRuntime,
  type RunningScreenPilotRuntime,
} from "./screen-pilot-runtime.js";

const SCREEN_PILOT_CLI_FLAG = "--screen-pilot";
const CAPABILITY_MESSAGE_TYPE = "screen-pilot.capability";
const SHUTDOWN_MESSAGE_TYPE = "screen-pilot.shutdown";
const CAPABILITY_WAIT_MS = 5_000;

declare const __SECHACK_SCREEN_PILOT_BUILD_EVIDENCE__: string;

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
  const embeddedBuildEvidence = parseScreenPilotEmbeddedBuildEvidence(
    __SECHACK_SCREEN_PILOT_BUILD_EVIDENCE__,
  );
  const verified = await consumeScreenPilotLaunchCapability(
    capability,
    entryPath,
    embeddedBuildEvidence,
  );
  return startScreenPilotRuntime(
    verified,
    embeddedBuildEvidence.appVersion,
  );
}

function runScreenPilotCli(): void {
  if (process.argv.length !== 3 || process.argv[2] !== SCREEN_PILOT_CLI_FLAG) {
    console.error("Screen-pilot startup is available only through npm run screen-pilot.");
    process.exitCode = 1;
    return;
  }
  let running: RunningScreenPilotRuntime | undefined;
  let pendingExitCode: 0 | 1 | null = null;
  let shutdownStarted = false;
  const shutdown = (exitCode: 0 | 1): void => {
    pendingExitCode = pendingExitCode === 1 ? 1 : exitCode;
    if (shutdownStarted || running === undefined) return;
    shutdownStarted = true;
    const forceExit = setTimeout(() => process.exit(1), running.shutdownDeadlineMs);
    void running.close().then(
      () => {
        clearTimeout(forceExit);
        process.exit(pendingExitCode ?? exitCode);
      },
      () => {
        clearTimeout(forceExit);
        process.exit(1);
      },
    );
  };
  const onParentMessage = (message: unknown): void => {
    if (
      message !== null
      && typeof message === "object"
      && (message as Readonly<Record<string, unknown>>)["type"] === SHUTDOWN_MESSAGE_TYPE
    ) {
      shutdown(0);
    }
  };
  process.on("message", onParentMessage);
  process.once("disconnect", () => shutdown(1));
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGBREAK", () => shutdown(0));
  process.once("uncaughtException", () => shutdown(1));
  process.once("unhandledRejection", () => shutdown(1));
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
      if (pendingExitCode !== null) shutdown(pendingExitCode);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Screen-pilot startup failed.");
      process.off("message", onParentMessage);
      if (process.connected && typeof process.disconnect === "function") process.disconnect();
      process.exitCode = 1;
    });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runScreenPilotCli();
}
