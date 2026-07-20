import { defineConfig, devices } from "@playwright/test";

const PUBLIC_DEMO_ORIGIN = "http://127.0.0.1:4180";

export default defineConfig({
  testDir: "./tests/public-demo",
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
  webServer: {
    command: "npm run build:public-demo && npx --no-install vite preview --config vite.public-demo.config.ts --host 127.0.0.1 --port 4180 --strictPort",
    url: `${PUBLIC_DEMO_ORIGIN}/`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
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
  ],
});
