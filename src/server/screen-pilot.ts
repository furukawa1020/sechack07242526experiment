import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runServerCli, startVerifiedScreenPilot } from "./index.js";

const SCREEN_PILOT_CLI_FLAG = "--screen-pilot";

function isScreenPilotCliEntry(entryPath: string | undefined): boolean {
  if (entryPath === undefined || pathToFileURL(resolve(entryPath)).href !== import.meta.url) {
    return false;
  }
  const entryName = basename(fileURLToPath(import.meta.url));
  return entryName === "screen-pilot.ts" || entryName === "screen-pilot.js";
}

if (isScreenPilotCliEntry(process.argv[1])) {
  if (process.argv.length !== 3 || process.argv[2] !== SCREEN_PILOT_CLI_FLAG) {
    console.error(`Screen-pilot startup requires the explicit ${SCREEN_PILOT_CLI_FLAG} flag.`);
    process.exitCode = 1;
  } else {
    console.info(
      "Starting the nonparticipant screen-pilot on loopback with exact formal timings. "
        + "Do not enroll research participants and do not enter production research IDs.",
    );
    runServerCli({
      start: async () => {
        const server = await startVerifiedScreenPilot();
        console.info(`Screen-pilot source commit: ${server.sourceEvidence.sourceCommit}`);
        console.info(`Screen-pilot source tree SHA-256: ${server.sourceEvidence.sourceTreeSha256}`);
        console.info(`Screen-pilot config file SHA-256: ${server.sourceEvidence.configFileHash}`);
        return server;
      },
      listeningLabel: "SecHack nonparticipant screen-pilot server",
      stoppedMessage: "Screen-pilot server stopped after the safe screen STOP/DEFLATE path.",
    });
  }
}
