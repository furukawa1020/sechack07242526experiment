import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const WORKSPACE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BUILD_SCRIPT = resolve(WORKSPACE_DIRECTORY, "scripts", "build-server.mjs");
const CLIENT_BUILD_SCRIPT = resolve(WORKSPACE_DIRECTORY, "scripts", "build-vite.mjs");
const SCAN_SCRIPT = resolve(WORKSPACE_DIRECTORY, "scripts", "scan-production-bundles.mjs");
const SERVER_OUTPUT_DIRECTORY = resolve(WORKSPACE_DIRECTORY, "dist-server");

async function assertOutputPathInChildProcess(outputPath: string): Promise<void> {
  const moduleUrl = pathToFileURL(BUILD_SCRIPT).href;
  const source = [
    `import { assertSafeServerOutputDirectory } from ${JSON.stringify(moduleUrl)};`,
    `assertSafeServerOutputDirectory(${JSON.stringify(outputPath)});`,
  ].join("\n");

  await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: tmpdir(),
  });
}

describe("server build", () => {
  it("cleans stale output and produces the same complete output from another working directory", async () => {
    await execFileAsync(process.execPath, [CLIENT_BUILD_SCRIPT, "client"], {
      cwd: tmpdir(),
      env: { ...process.env, NODE_ENV: "production" },
    });
    await mkdir(SERVER_OUTPUT_DIRECTORY, { recursive: true });
    const staleOutput = resolve(SERVER_OUTPUT_DIRECTORY, "stale.js");
    await writeFile(staleOutput, "stale", "utf8");

    await execFileAsync(process.execPath, [BUILD_SCRIPT], { cwd: tmpdir() });

    await expect(access(staleOutput)).rejects.toMatchObject({ code: "ENOENT" });
    const outputFiles = await readdir(SERVER_OUTPUT_DIRECTORY);
    expect(outputFiles.sort()).toEqual([
      "healthcheck.js",
      "healthcheck.js.map",
      "index.js",
      "index.js.map",
      "preflight.js",
      "preflight.js.map",
      "rehearsal-healthcheck.js",
      "rehearsal-healthcheck.js.map",
      "rehearsal-verify-release.js",
      "rehearsal-verify-release.js.map",
      "rehearsal.js",
      "rehearsal.js.map",
      "screen-pilot.js",
      "screen-pilot.js.map",
      "verify-release.js",
      "verify-release.js.map",
    ]);

    await expect(
      execFileAsync(process.execPath, [SCAN_SCRIPT, WORKSPACE_DIRECTORY], { cwd: tmpdir() }),
    ).resolves.toMatchObject({ stdout: expect.stringContaining("Production artifact scan: PASS") });

    const productionEntry: unknown = await import(
      `${pathToFileURL(resolve(SERVER_OUTPUT_DIRECTORY, "index.js")).href}?seal=${Date.now()}`
    );
    expect(Object.keys(productionEntry as object)).toEqual(["startProductionReleaseCli"]);
    expect(
      (productionEntry as { readonly startProductionReleaseCli?: unknown })
        .startProductionReleaseCli,
    ).toEqual(expect.any(Function));
    expect(productionEntry).not.toHaveProperty("startServer");

    const rehearsalSource = await readFile(
      resolve(SERVER_OUTPUT_DIRECTORY, "rehearsal.js"),
      "utf8",
    );
    const rehearsalHealthSource = await readFile(
      resolve(SERVER_OUTPUT_DIRECTORY, "rehearsal-healthcheck.js"),
      "utf8",
    );
    expect(rehearsalSource).toContain("--mock-rehearsal");
    expect(rehearsalHealthSource).toContain("--mock-rehearsal");
  });

  it("accepts only the absolute repository dist-server directory", async () => {
    await expect(assertOutputPathInChildProcess(SERVER_OUTPUT_DIRECTORY)).resolves.toBeUndefined();

    for (const unsafeOutput of [
      "dist-server",
      WORKSPACE_DIRECTORY,
      resolve(WORKSPACE_DIRECTORY, "dist-server", "nested"),
      resolve(WORKSPACE_DIRECTORY, "..", "dist-server"),
    ]) {
      await expect(assertOutputPathInChildProcess(unsafeOutput)).rejects.toThrow();
    }
  });
});
