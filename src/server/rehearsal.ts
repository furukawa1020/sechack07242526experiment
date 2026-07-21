import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runServerCli, startServer } from "./index.js";

const DEFAULT_REHEARSAL_CONFIG_PATH = "config/experiment.mock-rehearsal.json";
const REHEARSAL_CLI_FLAG = "--mock-rehearsal";

function isRehearsalCliEntry(entryPath: string | undefined): boolean {
  if (entryPath === undefined || pathToFileURL(resolve(entryPath)).href !== import.meta.url) {
    return false;
  }
  const entryName = basename(fileURLToPath(import.meta.url));
  return entryName === "rehearsal.ts" || entryName === "rehearsal.js";
}

if (isRehearsalCliEntry(process.argv[1])) {
  if (process.argv.length !== 3 || process.argv[2] !== REHEARSAL_CLI_FLAG) {
    console.error(`Rehearsal startup requires the explicit ${REHEARSAL_CLI_FLAG} flag.`);
    process.exitCode = 1;
  } else {
    console.info(
      "Starting hardware-free rehearsal mode on loopback with the real-time Mock device.",
    );
    runServerCli({
      start: () =>
        startServer({
          mode: "rehearsal",
          configPath: process.env.EXPERIMENT_CONFIG_PATH ?? DEFAULT_REHEARSAL_CONFIG_PATH,
        }),
      listeningLabel: "SecHack rehearsal server",
      stoppedMessage: "Rehearsal server stopped; no physical device was used.",
    });
  }
}
