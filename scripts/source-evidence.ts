import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectProductionSourceEvidence } from "./create-release.js";

export async function runSourceEvidence(
  writeLine: (line: string) => void = console.info,
): Promise<number> {
  try {
    const evidence = await inspectProductionSourceEvidence();
    writeLine(`appVersion=${evidence.appVersion}`);
    writeLine(`criticalConfigSha256=${evidence.criticalConfigSha256}`);
    writeLine(`pilotConfigFileHash=${evidence.pilotConfigFileHash}`);
    writeLine(`sourceCommit=${evidence.sourceCommit}`);
    writeLine(`sourceTreeSha256=${evidence.sourceTreeSha256}`);
    return 0;
  } catch (error) {
    writeLine(
      `Source evidence inspection failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  void runSourceEvidence().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
