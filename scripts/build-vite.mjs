import { lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");

const BUILD_TARGETS = Object.freeze({
  client: Object.freeze({
    configFile: resolve(WORKSPACE_DIRECTORY, "vite.config.ts"),
    outputName: "dist",
    rootDirectory: WORKSPACE_DIRECTORY,
  }),
  "public-demo": Object.freeze({
    configFile: resolve(WORKSPACE_DIRECTORY, "vite.public-demo.config.ts"),
    outputName: "dist-public-demo",
    rootDirectory: resolve(WORKSPACE_DIRECTORY, "public-demo"),
  }),
});

export function assertSafeViteOutputDirectory(outputDirectory, expectedOutputName) {
  if (!isAbsolute(outputDirectory)) {
    throw new Error("Vite build output must be an absolute path.");
  }
  if (!(expectedOutputName === "dist" || expectedOutputName === "dist-public-demo")) {
    throw new Error(`Unknown Vite build output: ${expectedOutputName}`);
  }

  const resolvedOutputDirectory = resolve(outputDirectory);
  const expectedOutputDirectory = resolve(WORKSPACE_DIRECTORY, expectedOutputName);
  const workspaceRelativeOutput = relative(WORKSPACE_DIRECTORY, resolvedOutputDirectory);
  if (
    resolvedOutputDirectory !== expectedOutputDirectory
    || dirname(resolvedOutputDirectory) !== WORKSPACE_DIRECTORY
    || workspaceRelativeOutput !== expectedOutputName
  ) {
    throw new Error(`Refusing to clean unexpected Vite build output: ${resolvedOutputDirectory}`);
  }
  return resolvedOutputDirectory;
}

async function cleanViteOutputDirectory(outputDirectory, expectedOutputName) {
  const safeOutputDirectory = assertSafeViteOutputDirectory(
    outputDirectory,
    expectedOutputName,
  );
  try {
    const outputStats = await lstat(safeOutputDirectory);
    if (outputStats.isSymbolicLink()) {
      throw new Error(`Refusing to recursively clean a linked Vite build output: ${safeOutputDirectory}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await rm(safeOutputDirectory, { recursive: true, force: true });
}

export async function buildViteTarget(targetName) {
  const target = BUILD_TARGETS[targetName];
  if (target === undefined) {
    throw new Error("Usage: node scripts/build-vite.mjs <client|public-demo>");
  }
  const outputDirectory = resolve(WORKSPACE_DIRECTORY, target.outputName);
  await cleanViteOutputDirectory(outputDirectory, target.outputName);
  await build({
    configFile: target.configFile,
    root: target.rootDirectory,
    build: {
      emptyOutDir: false,
      outDir: outputDirectory,
    },
  });
}

const invokedScript = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedScript === fileURLToPath(import.meta.url)) {
  await buildViteTarget(process.argv[2]);
}
