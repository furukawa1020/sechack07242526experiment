import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runServerCli, startServer } from "./index.js";

const DEFAULT_REHEARSAL_CONFIG_PATH = "config/experiment.mock-rehearsal.json";

function isRehearsalCliEntry(entryPath: string | undefined): boolean {
  if (entryPath === undefined || pathToFileURL(resolve(entryPath)).href !== import.meta.url) {
    return false;
  }
  const entryName = basename(fileURLToPath(import.meta.url));
  return entryName === "rehearsal.ts" || entryName === "rehearsal.js";
}

if (isRehearsalCliEntry(process.argv[1])) {
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
