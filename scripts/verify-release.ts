import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyReleaseDirectoryDetailed } from "./release-manifest.js";

export interface RunReleaseVerificationOptions {
  readonly directory?: string;
  readonly writeLine?: (line: string) => void;
}

export async function runReleaseVerification(
  options: RunReleaseVerificationOptions = {},
): Promise<number> {
  const writeLine = options.writeLine ?? console.info;
  const directory = resolve(options.directory ?? process.cwd());
  const verification = await verifyReleaseDirectoryDetailed(directory);
  if (verification.manifestSha256 !== null) {
    writeLine(`Deployment manifest SHA-256: ${verification.manifestSha256}`);
  }
  if (verification.sourceCommit !== null) {
    writeLine(`Source commit: ${verification.sourceCommit}`);
  }
  if (verification.sourceRepository !== undefined) {
    writeLine(`Source repository: ${verification.sourceRepository}`);
  }
  if (verification.errors.length === 0) {
    writeLine(`結果: PASS (${directory})`);
    return 0;
  }
  writeLine(`結果: FAIL (${verification.errors.length}件)`);
  for (const error of verification.errors) writeLine(`  [FAIL] ${error}`);
  return 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0] === "--help" || args[0] === "-h") {
    console.info("Usage: node dist-server/verify-release.js [release directory]");
    process.exitCode = args.length > 1 ? 1 : 0;
    return;
  }
  process.exitCode = await runReleaseVerification({
    ...(args[0] === undefined ? {} : { directory: args[0] }),
  });
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  void main();
}
