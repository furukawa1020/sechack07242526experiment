import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createScreenPilotLaunchCapability,
  verifyScreenPilotSource,
} from "../src/server/screen-pilot-provenance.js";

function waitForExit(child: ChildProcess, label: string): Promise<number> {
  return new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", (error) => rejectExit(new Error(`${label} could not start.`, { cause: error })));
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        rejectExit(new Error(`${label} ended from signal ${signal}.`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

async function runFreshBuild(rootDirectory: string): Promise<void> {
  const child = process.platform === "win32"
    ? spawn("npm.cmd run build", [], {
        cwd: rootDirectory,
        shell: true,
        stdio: "inherit",
        windowsHide: true,
      })
    : spawn("npm", ["run", "build"], {
        cwd: rootDirectory,
        shell: false,
        stdio: "inherit",
      });
  if (await waitForExit(child, "Fresh screen-pilot build") !== 0) {
    throw new Error("Fresh screen-pilot build failed.");
  }
}

export async function runScreenPilotLauncher(root = process.cwd()): Promise<number> {
  try {
    if (process.env.npm_lifecycle_event !== "screen-pilot") {
      throw new Error("Screen-pilot launcher may run only through npm run screen-pilot.");
    }
    if (process.argv.slice(2).length > 0) {
      throw new Error("Screen-pilot launcher accepts no command-line overrides.");
    }
    const beforeBuild = await verifyScreenPilotSource(resolve(root));
    await runFreshBuild(beforeBuild.rootDirectory);
    const capability = await createScreenPilotLaunchCapability(
      beforeBuild.rootDirectory,
      beforeBuild.evidence,
    );
    const entryPath = resolve(beforeBuild.rootDirectory, "dist-server", "screen-pilot.js");
    const child = spawn(process.execPath, [entryPath, "--screen-pilot"], {
      cwd: beforeBuild.rootDirectory,
      env: { ...process.env, NODE_ENV: "production" },
      shell: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    const exitPromise = waitForExit(child, "Verified screen-pilot runtime");
    child.send({ type: "screen-pilot.capability", capability }, (error) => {
      if (error) {
        if (!child.killed) child.kill();
        return;
      }
      if (child.connected) child.disconnect();
    });
    return await exitPromise;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Screen-pilot launcher failed.");
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  process.exitCode = await runScreenPilotLauncher();
}
