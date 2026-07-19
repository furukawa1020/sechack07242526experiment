import { startServer } from "../../src/server/index.js";

/**
 * Keep the test server in Playwright's own process. This gives teardown a
 * deterministic `close()` path on Windows instead of relying on cmd.exe to
 * terminate an npm/tsx child-process tree.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousConfigPath = process.env.EXPERIMENT_CONFIG_PATH;
  const previousDataDirectory = process.env.DATA_DIRECTORY;
  process.env.NODE_ENV = "test";
  process.env.EXPERIMENT_CONFIG_PATH = "config/experiment.e2e.json";
  process.env.DATA_DIRECTORY = `./data/e2e-sessions/run-${process.pid}-${Date.now()}`;

  const server = await startServer({
    mode: "test",
    configPath: "config/experiment.e2e.json",
  });

  return async (): Promise<void> => {
    await server.close();
    restoreEnvironment("NODE_ENV", previousNodeEnv);
    restoreEnvironment("EXPERIMENT_CONFIG_PATH", previousConfigPath);
    restoreEnvironment("DATA_DIRECTORY", previousDataDirectory);
  };
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
