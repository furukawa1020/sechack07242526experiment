import { lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { acquireBuildLock } from "./build-lock.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const SERVER_OUTPUT_DIRECTORY = resolve(WORKSPACE_DIRECTORY, "dist-server");

export function assertSafeServerOutputDirectory(outputDirectory) {
  if (!isAbsolute(outputDirectory)) {
    throw new Error("Server build output must be an absolute path.");
  }

  const resolvedOutputDirectory = resolve(outputDirectory);
  const expectedOutputDirectory = resolve(WORKSPACE_DIRECTORY, "dist-server");
  const workspaceRelativeOutput = relative(WORKSPACE_DIRECTORY, resolvedOutputDirectory);

  if (
    resolvedOutputDirectory !== expectedOutputDirectory
    || dirname(resolvedOutputDirectory) !== WORKSPACE_DIRECTORY
    || workspaceRelativeOutput !== "dist-server"
  ) {
    throw new Error(
      `Refusing to clean unexpected server build output: ${resolvedOutputDirectory}`,
    );
  }

  return resolvedOutputDirectory;
}

async function cleanServerOutputDirectory(outputDirectory) {
  const safeOutputDirectory = assertSafeServerOutputDirectory(outputDirectory);

  try {
    const outputStats = await lstat(safeOutputDirectory);
    if (outputStats.isSymbolicLink()) {
      throw new Error(
        `Refusing to recursively clean a linked server build output: ${safeOutputDirectory}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await rm(safeOutputDirectory, { recursive: true, force: true });
}

async function buildServer() {
  const buildLock = await acquireBuildLock(WORKSPACE_DIRECTORY);
  try {
    await cleanServerOutputDirectory(SERVER_OUTPUT_DIRECTORY);

    await build({
      absWorkingDir: WORKSPACE_DIRECTORY,
      entryPoints: {
        index: "src/server/production-entry.ts",
        rehearsal: "src/server/rehearsal.ts",
        "screen-pilot": "src/server/screen-pilot.ts",
        preflight: "scripts/preflight.ts",
        healthcheck: "scripts/healthcheck.ts",
        "verify-release": "scripts/verify-release.ts",
      },
      outdir: SERVER_OUTPUT_DIRECTORY,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      sourcemap: true,
      legalComments: "none",
    });
  } finally {
    await buildLock.release();
  }
}

const invokedScript = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedScript === fileURLToPath(import.meta.url)) {
  await buildServer();
}
