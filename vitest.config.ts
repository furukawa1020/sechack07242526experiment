import { defineConfig } from "vitest/config";

const coverageRunId = process.env.COVERAGE_RUN_ID;
if (coverageRunId !== undefined && !/^[a-z0-9-]+$/u.test(coverageRunId)) {
  throw new Error("COVERAGE_RUN_ID may contain only lowercase letters, digits, and hyphens.");
}
const coverageReportsDirectory = coverageRunId === undefined
  ? "artifacts/coverage"
  : `artifacts/coverage-${coverageRunId}`;

export default defineConfig({
  test: {
    environment: "node",
    // Windows CI and concurrent Codex sessions can make the intentional
    // child-process and lock-contention tests exceed Vitest's 5 s default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: coverageReportsDirectory,
      include: [
        "src/shared/**/*.ts",
        "src/server/devices/**/*.ts",
        "src/server/logging/**/*.ts",
        "src/server/sessions/**/*.ts",
      ],
      exclude: ["**/*.d.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
        "src/shared/conditions.ts": { 100: true },
        "src/shared/experiment-machine.ts": {
          lines: 90,
          functions: 90,
          statements: 90,
          branches: 90,
        },
        "src/server/devices/**/*.ts": {
          lines: 90,
          functions: 90,
          statements: 90,
          branches: 90,
        },
        "src/server/logging/log-event-allowlist.ts": { 100: true },
      }
    }
  }
});
