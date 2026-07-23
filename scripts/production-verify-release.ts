import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyFormalReleaseDirectoryDetailed } from "./production-release-verifier.js";

export async function runProductionReleaseVerification(
  directory = process.cwd(),
  writeLine: (line: string) => void = console.info,
): Promise<number> {
  const resolvedDirectory = resolve(directory);
  const verification = await verifyFormalReleaseDirectoryDetailed(resolvedDirectory);
  if (verification.manifestSha256 !== null) {
    writeLine(`Deployment manifest SHA-256: ${verification.manifestSha256}`);
  }
  if (verification.sourceCommit !== null) writeLine(`Source commit: ${verification.sourceCommit}`);
  if (verification.manifest !== null) {
    writeLine(`App version: ${verification.manifest.appVersion}`);
    writeLine(`Source tree SHA-256: ${verification.manifest.sourceTreeSha256}`);
  }
  if (verification.sourceRepository !== undefined) {
    writeLine(`Source repository: ${verification.sourceRepository}`);
  }
  if (verification.errors.length === 0) {
    writeLine(`結果: PASS (${resolvedDirectory})`);
    return 0;
  }
  writeLine(`結果: FAIL (${String(verification.errors.length)}件)`);
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
  process.exitCode = await runProductionReleaseVerification(args[0]);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  void main();
}
