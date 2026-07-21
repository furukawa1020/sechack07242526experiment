import { defineConfig, devices } from "@playwright/test";

const PUBLIC_DEMO_PORT = Number.parseInt(process.env.PUBLIC_DEMO_PORT ?? "4180", 10);
if (!Number.isInteger(PUBLIC_DEMO_PORT) || PUBLIC_DEMO_PORT < 1 || PUBLIC_DEMO_PORT > 65_535) {
  throw new Error("PUBLIC_DEMO_PORT must be an integer between 1 and 65535.");
}
const PUBLIC_DEMO_ORIGIN = new URL(
  process.env.PUBLIC_DEMO_ORIGIN ?? `http://127.0.0.1:${String(PUBLIC_DEMO_PORT)}`,
).origin;

export default defineConfig({
  testDir: "./tests/public-demo",
  globalSetup: "./tests/public-demo/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "artifacts/test-results/public-demo",
  use: {
    baseURL: PUBLIC_DEMO_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium-1366x768",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } },
    },
    {
      name: "chromium-1920x1080",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } },
    },
    {
      name: "chromium-390x844",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "chromium-320x568",
      use: { ...devices["Desktop Chrome"], viewport: { width: 320, height: 568 } },
    },
    {
      name: "chromium-844x390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 844, height: 390 } },
    },
  ],
});
