import { resolve } from "node:path";

import { preview } from "vite";

const PUBLIC_DEMO_PORT = 4180;

/**
 * Keep the static preview server in Playwright's own process so Windows
 * teardown can await Vite's close() instead of terminating a cmd.exe tree.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await preview({
    configFile: resolve(import.meta.dirname, "../../vite.public-demo.config.ts"),
    logLevel: "error",
    preview: {
      host: "127.0.0.1",
      port: PUBLIC_DEMO_PORT,
      strictPort: true,
    },
  });

  return async (): Promise<void> => {
    await server.close();
  };
}
