import { builtinModules } from "node:module";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const FORMAL_SERVER_BUNDLES = Object.freeze([
  "index.js",
  "preflight.js",
  "healthcheck.js",
  "verify-release.js",
]);

export const PRODUCTION_RUNTIME_DEPENDENCIES = Object.freeze([]);

export const FORBIDDEN_PRODUCTION_BUNDLE_PATTERNS = Object.freeze([
  ["short questionnaire host", /forms\.gle/iu],
  ["questionnaire document path", /docs\.google\.com\/(?:forms|forms\\u002f)/iu],
  ["dummy questionnaire id", /TEST_FORM_ID/iu],
  ["legacy questionnaire audit field", /formAudit/iu],
  ["legacy questionnaire audit document", /FORM_(?:AUDIT|RELEASE_GATE)/iu],
  ["questionnaire audit module", /(?:audit-public-form|verify-release-form)/iu],
  ["questionnaire completion endpoint", /confirm-form-complete/iu],
  ["questionnaire QR implementation", /qrcode|QRコード/iu],
  ["questionnaire product copy", /Googleフォーム/iu],
  ["development adapter", /MockPufferDevice/iu],
  ["future physical adapter", /SerialPufferDevice/iu],
  ["development permission flag", /--allow-mock/iu],
  ["rehearsal CLI flag", /--mock-rehearsal/iu],
  ["pilot CLI flag", /--screen-pilot/iu],
  ["rehearsal config", /experiment\.mock-rehearsal/iu],
  ["rehearsal log path", /data[\\/]mock-sessions/iu],
  ["test static-serving seam", /serveBuiltAssets/iu],
  ["test disconnect seam", /injectUnexpectedMockDisconnect|readMockDeviceCommands/iu],
  ["test API route", /\/test\/mock-device/iu],
  ["auxiliary bundle reference", /rehearsal-(?:healthcheck|verify-release)/iu],
]);

const CLIENT_ARTIFACT_EXTENSIONS = new Set([".html", ".js", ".css"]);
const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const ALLOWED_NON_REQUEST_URLS = new Set([
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/XML/1998/namespace",
  // React embeds this diagnostic reference in its browser bundle. It is not a
  // resource URL and no code in the application requests it.
  "https://react.dev/errors/",
]);

function toPortablePath(path) {
  return path.split(sep).join("/");
}

function packageNameFromSpecifier(specifier) {
  if (
    specifier.startsWith(".")
    || specifier.startsWith("/")
    || specifier.includes(":")
    || BUILTIN_MODULES.has(specifier)
  ) {
    return undefined;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

export function collectExternalPackageImports(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:(?!;)[\s\S])*?\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const packageName = packageNameFromSpecifier(specifier);
      if (packageName !== undefined && packageName.length > 0) specifiers.add(packageName);
    }
  }
  return Object.freeze([...specifiers].sort((left, right) => left.localeCompare(right)));
}

async function listClientArtifacts(rootDirectory, currentDirectory = rootDirectory) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = resolve(currentDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Production client build contains a symbolic link: ${toPortablePath(relative(rootDirectory, absolutePath))}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await listClientArtifacts(rootDirectory, absolutePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Production client build contains an unsupported entry: ${toPortablePath(relative(rootDirectory, absolutePath))}`,
      );
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (CLIENT_ARTIFACT_EXTENSIONS.has(extension)) files.push(absolutePath);
  }
  return files;
}

function scanForbiddenText(label, source, findings) {
  for (const [description, pattern] of FORBIDDEN_PRODUCTION_BUNDLE_PATTERNS) {
    if (pattern.test(source)) findings.push(`${label}: ${description}`);
  }
}

function scanClientExternalUrls(label, source, findings) {
  const absoluteUrlPattern = /\b(?:https?|wss?):\/\/[^\s"'`<>\\)]+/giu;
  for (const match of source.matchAll(absoluteUrlPattern)) {
    const value = match[0];
    if (value !== undefined && !ALLOWED_NON_REQUEST_URLS.has(value)) {
      findings.push(`${label}: external URL ${value}`);
    }
  }
  const protocolRelativePattern = /["'`(=]\s*(\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#][^\s"'`<>\\)]*)?)/giu;
  if (protocolRelativePattern.test(source)) {
    findings.push(`${label}: protocol-relative external URL`);
  }
}

function parseJsonObject(source, label) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value;
}

function objectKeys(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort((left, right) => left.localeCompare(right))
    : [];
}

function equalStringSets(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function scanRuntimePackage(rootDirectory, importedPackages, findings) {
  const packageSource = await readFile(resolve(rootDirectory, "package.json"), "utf8");
  const packageJson = parseJsonObject(packageSource, "Production package.json");
  const declaredDependencies = objectKeys(packageJson.dependencies);
  if (!equalStringSets(declaredDependencies, importedPackages)) {
    findings.push(
      `package.json: dependencies (${declaredDependencies.join(", ")}) do not match formal bundle imports (${importedPackages.join(", ")})`,
    );
  }
  for (const field of ["devDependencies", "optionalDependencies"]) {
    if (objectKeys(packageJson[field]).length > 0) {
      findings.push(`package.json: ${field} must be absent from the production runtime package`);
    }
  }
  for (const name of ["package-lock.json", "node_modules"]) {
    if (await pathExists(resolve(rootDirectory, name))) {
      findings.push(`${name}: production runtime must be dependency-free and self-contained`);
    }
  }
}

export async function scanProductionArtifacts(options = {}) {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const serverDirectory = resolve(rootDirectory, "dist-server");
  const clientDirectory = resolve(rootDirectory, "dist");
  const findings = [];
  const importedPackages = new Set();

  for (const name of FORMAL_SERVER_BUNDLES) {
    const path = resolve(serverDirectory, name);
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Formal server artifact is not a regular file: ${path}`);
    }
    const source = await readFile(path, "utf8");
    scanForbiddenText(`dist-server/${name}`, source, findings);
    for (const packageName of collectExternalPackageImports(source)) {
      importedPackages.add(packageName);
    }
  }
  const sortedImports = [...importedPackages].sort((left, right) => left.localeCompare(right));
  if (!equalStringSets(sortedImports, PRODUCTION_RUNTIME_DEPENDENCIES)) {
    findings.push(
      `formal server bundles: external imports (${sortedImports.join(", ")}) do not match approved runtime dependencies (${PRODUCTION_RUNTIME_DEPENDENCIES.join(", ")})`,
    );
  }

  const clientArtifacts = await listClientArtifacts(clientDirectory);
  if (clientArtifacts.length === 0) {
    findings.push("dist: no production HTML/JS/CSS artifacts were found");
  }
  for (const path of clientArtifacts) {
    const label = `dist/${toPortablePath(relative(clientDirectory, path))}`;
    const source = await readFile(path, "utf8");
    scanForbiddenText(label, source, findings);
    scanClientExternalUrls(label, source, findings);
  }

  if (options.checkRuntimePackage === true) {
    await scanRuntimePackage(rootDirectory, sortedImports, findings);
  }
  return Object.freeze(findings);
}

export async function assertProductionArtifacts(options = {}) {
  const findings = await scanProductionArtifacts(options);
  if (findings.length > 0) {
    throw new Error(`Production artifact scan failed:\n${findings.map((item) => `- ${item}`).join("\n")}`);
  }
}

// Compatibility wrapper retained for unit callers that previously supplied
// dist-server directly. Client artifacts are now always scanned as well.
export async function scanProductionBundles(outputDirectory = resolve(process.cwd(), "dist-server")) {
  const resolvedOutput = resolve(outputDirectory);
  const rootDirectory = basename(resolvedOutput) === "dist-server"
    ? resolve(resolvedOutput, "..")
    : resolvedOutput;
  return scanProductionArtifacts({ rootDirectory });
}

function parseArguments(args) {
  let rootDirectory;
  let checkRuntimePackage = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--runtime-package") {
      checkRuntimePackage = true;
      continue;
    }
    if (argument === "--root") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--root requires a value.");
      rootDirectory = resolve(value);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--root=")) {
      rootDirectory = resolve(argument.slice("--root=".length));
      continue;
    }
    if (argument?.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    if (rootDirectory !== undefined) throw new Error("Production artifact root may only be specified once.");
    rootDirectory = resolve(argument);
  }
  return { rootDirectory: rootDirectory ?? process.cwd(), checkRuntimePackage };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const findings = await scanProductionArtifacts(options);
    if (findings.length > 0) {
      for (const finding of findings) console.error(`[FAIL] ${finding}`);
      process.exitCode = 1;
      return;
    }
    console.info(
      `Production artifact scan: PASS (${FORMAL_SERVER_BUNDLES.join(", ")}; client HTML/JS/CSS; self-contained server bundles${options.checkRuntimePackage ? "; dependency-free package" : ""})`,
    );
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  await main();
}
