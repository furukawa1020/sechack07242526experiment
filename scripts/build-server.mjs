import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { acquireBuildLock } from "./build-lock.mjs";
import { assertProductionArtifacts } from "./scan-production-bundles.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const SERVER_OUTPUT_DIRECTORY = resolve(WORKSPACE_DIRECTORY, "dist-server");
const CLIENT_OUTPUT_DIRECTORY = resolve(WORKSPACE_DIRECTORY, "dist");
const NODE_REQUIRE_BANNER =
  'import { createRequire as __sechackCreateRequire } from "node:module"; const require = __sechackCreateRequire(import.meta.url);';
const SCREEN_PILOT_BUILD_ENVIRONMENT = Object.freeze({
  sourceCommit: "SECHACK_SCREEN_PILOT_SOURCE_COMMIT",
  sourceTreeSha256: "SECHACK_SCREEN_PILOT_SOURCE_TREE_SHA256",
  configFileHash: "SECHACK_SCREEN_PILOT_CONFIG_FILE_HASH",
});
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function screenPilotSourceEvidenceFromEnvironment(environment = process.env) {
  const sourceCommit = environment[SCREEN_PILOT_BUILD_ENVIRONMENT.sourceCommit];
  const sourceTreeSha256 = environment[SCREEN_PILOT_BUILD_ENVIRONMENT.sourceTreeSha256];
  const configFileHash = environment[SCREEN_PILOT_BUILD_ENVIRONMENT.configFileHash];
  const values = [sourceCommit, sourceTreeSha256, configFileHash];
  if (values.every((value) => value === undefined)) return null;
  if (
    !SOURCE_COMMIT_PATTERN.test(sourceCommit ?? "")
    || !SHA256_PATTERN.test(sourceTreeSha256 ?? "")
    || !SHA256_PATTERN.test(configFileHash ?? "")
  ) {
    throw new Error("Screen-pilot build provenance environment is incomplete or invalid.");
  }
  return Object.freeze({ sourceCommit, sourceTreeSha256, configFileHash });
}

async function listPilotClientArtifacts(currentDirectory = CLIENT_OUTPUT_DIRECTORY) {
  const directory = await lstat(currentDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Screen-pilot client output must contain ordinary directories only.");
  }
  const files = [];
  for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
    const absolutePath = resolve(currentDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Screen-pilot client output must not contain links or junctions.");
    }
    if (entry.isDirectory()) {
      files.push(...await listPilotClientArtifacts(absolutePath));
      continue;
    }
    if (!entry.isFile()) throw new Error("Screen-pilot client output contains an unsupported entry.");
    if (/\.(?:html|js|css)$/u.test(entry.name)) files.push(absolutePath);
  }
  return files;
}

async function createEmbeddedScreenPilotEvidence(sourceEvidence) {
  if (sourceEvidence === null) return "UNVERIFIED";
  const paths = [...await listPilotClientArtifacts()]
    .sort((left, right) => left.localeCompare(right, "en"));
  const clientAssets = [];
  for (const path of paths) {
    const body = await readFile(path);
    const manifestPath = relative(WORKSPACE_DIRECTORY, path).split(sep).join("/");
    clientAssets.push(Object.freeze({
      path: manifestPath,
      bytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    }));
  }
  if (clientAssets.filter((entry) => entry.path === "dist/index.html").length !== 1) {
    throw new Error("Screen-pilot build requires exactly one dist/index.html.");
  }
  return JSON.stringify({ schemaVersion: 1, sourceEvidence, clientAssets });
}

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
    const screenPilotSourceEvidence = screenPilotSourceEvidenceFromEnvironment();
    const embeddedScreenPilotEvidence = await createEmbeddedScreenPilotEvidence(
      screenPilotSourceEvidence,
    );

    await build({
      absWorkingDir: WORKSPACE_DIRECTORY,
      entryPoints: {
        index: "src/server/production-entry.ts",
        preflight: "scripts/production-preflight.ts",
        healthcheck: "scripts/production-healthcheck.ts",
        "verify-release": "scripts/production-verify-release.ts",
      },
      outdir: SERVER_OUTPUT_DIRECTORY,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: true,
      legalComments: "none",
      // Express still contains a few guarded CommonJS requires for Node
      // built-ins.  The sealed artifact is ESM and dependency-free, so expose
      // only Node's standard createRequire bridge inside the generated bundle.
      banner: {
        js: NODE_REQUIRE_BANNER,
      },
    });

    // Development-only and nonparticipant rehearsal seams are compiled under
    // distinct names. Formal release packaging never copies these files.
    await build({
      absWorkingDir: WORKSPACE_DIRECTORY,
      entryPoints: {
        rehearsal: "src/server/rehearsal.ts",
        "rehearsal-healthcheck": "scripts/healthcheck.ts",
        "rehearsal-verify-release": "scripts/verify-release.ts",
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

    // The screen pilot uses the production-only application surface. Bundle
    // every package byte and embed the clean source/client evidence established
    // by its launcher so ignored/stale dist files cannot be self-authorized.
    await build({
      absWorkingDir: WORKSPACE_DIRECTORY,
      entryPoints: { "screen-pilot": "src/server/screen-pilot.ts" },
      outdir: SERVER_OUTPUT_DIRECTORY,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: true,
      legalComments: "none",
      banner: { js: NODE_REQUIRE_BANNER },
      define: {
        __SECHACK_SCREEN_PILOT_BUILD_EVIDENCE__: JSON.stringify(embeddedScreenPilotEvidence),
      },
    });

    await assertProductionArtifacts({ rootDirectory: WORKSPACE_DIRECTORY });
  } finally {
    await buildLock.release();
  }
}

const invokedScript = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedScript === fileURLToPath(import.meta.url)) {
  await buildServer();
}
