import { execFile } from "node:child_process";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const WORKSPACE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BUILD_SCRIPT = resolve(WORKSPACE_DIRECTORY, "scripts", "build-server.mjs");
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
      "rehearsal.js",
      "rehearsal.js.map",
      "verify-release.js",
      "verify-release.js.map",
    ]);

    const productionEntry: unknown = await import(
      `${pathToFileURL(resolve(SERVER_OUTPUT_DIRECTORY, "index.js")).href}?seal=${Date.now()}`
    );
    expect(Object.keys(productionEntry as object)).toEqual(["startProductionReleaseCli"]);
    expect(
      (productionEntry as { readonly startProductionReleaseCli?: unknown })
        .startProductionReleaseCli,
    ).toEqual(expect.any(Function));
    expect(productionEntry).not.toHaveProperty("startServer");
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
