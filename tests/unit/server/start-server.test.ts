import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { inferServerMode, startServer } from "../../../src/server/index.js";

describe("startServer production safeguards", () => {
  it("rejects the default MockDevice config whenever production mode is selected", async () => {
    await expect(startServer({
      rootDirectory: process.cwd(),
      configPath: "config/experiment.json",
      mode: "production",
    })).rejects.toThrow(/Mock device mode is unconditionally disabled in production/iu);
  });

  it("rejects production Mock mode even when a config attempts to opt in", async () => {
    await expect(startServer({
      rootDirectory: process.cwd(),
      configPath: "config/experiment.e2e.json",
      mode: "production",
    })).rejects.toThrow(/unconditionally disabled/iu);
  });

  it("treats a compiled entry as production even when NODE_ENV is test", () => {
    expect(inferServerMode(resolve("dist-server", "index.js"), "test")).toBe("production");
    expect(inferServerMode(resolve("src", "server", "index.ts"), "test")).toBe("test");
  });

  it("shares one safe shutdown operation across repeated close calls", async () => {
    const server = await startServer({
      rootDirectory: process.cwd(),
      configPath: "config/experiment.e2e.json",
      mode: "test",
    });
    const firstClose = server.close();
    expect(server.close()).toBe(firstClose);
    await firstClose;
  });
});
