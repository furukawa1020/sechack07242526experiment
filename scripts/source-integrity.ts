import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectProductionSourceIntegrity } from "./create-release.js";

export async function runSourceIntegrity(
  writeLine: (line: string) => void = console.info,
): Promise<number> {
  try {
    const integrity = await inspectProductionSourceIntegrity();
    writeLine("purpose=optional-technical-integrity-diagnostic");
    writeLine("releaseOrStartGate=false");
    writeLine(`appVersion=${integrity.appVersion}`);
    writeLine(`criticalConfigSha256=${integrity.criticalConfigSha256}`);
    writeLine(`sourceCommit=${integrity.sourceCommit}`);
    writeLine(`sourceTreeSha256=${integrity.sourceTreeSha256}`);
    return 0;
  } catch (error) {
    writeLine(
      `Source integrity inspection failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  void runSourceIntegrity().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
