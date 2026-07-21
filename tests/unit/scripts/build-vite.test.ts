import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const WORKSPACE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BUILD_SCRIPT = resolve(WORKSPACE_DIRECTORY, "scripts", "build-vite.mjs");

async function assertOutputPathInChildProcess(
  outputPath: string,
  expectedOutputName: string,
): Promise<void> {
  const moduleUrl = pathToFileURL(BUILD_SCRIPT).href;
  const source = [
    `import { assertSafeViteOutputDirectory } from ${JSON.stringify(moduleUrl)};`,
    `assertSafeViteOutputDirectory(${JSON.stringify(outputPath)}, ${JSON.stringify(expectedOutputName)});`,
  ].join("\n");
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: tmpdir(),
  });
}

describe("Vite build output safety", () => {
  it.each(["dist", "dist-public-demo"])(
    "accepts only the absolute repository %s directory",
    async (outputName) => {
      const expectedOutput = resolve(WORKSPACE_DIRECTORY, outputName);
      await expect(
        assertOutputPathInChildProcess(expectedOutput, outputName),
      ).resolves.toBeUndefined();

      for (const unsafeOutput of [
        outputName,
        WORKSPACE_DIRECTORY,
        resolve(expectedOutput, "nested"),
        resolve(WORKSPACE_DIRECTORY, "..", outputName),
      ]) {
        await expect(
          assertOutputPathInChildProcess(unsafeOutput, outputName),
        ).rejects.toThrow();
      }
    },
  );

  it("rejects unknown output names even when the path is inside the repository", async () => {
    await expect(
      assertOutputPathInChildProcess(
        resolve(WORKSPACE_DIRECTORY, "unexpected-output"),
        "unexpected-output",
      ),
    ).rejects.toThrow();
  });
});
