import { existsSync } from "node:fs";
import { resolve } from "node:path";

import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { ZodError } from "zod";

import type { ServerExperimentConfig } from "./contracts.js";
import { HttpError } from "./api/http-error.js";
import { createApiRouter, type ApiTestHooks } from "./api/router.js";
import { securityMiddleware } from "./security/http-security.js";
import type { SessionController } from "./sessions/session-controller.js";
import { PufferDeviceError } from "./devices/index.js";

export type ApplicationMode = "development" | "production" | "rehearsal" | "screen-pilot" | "test";

export interface ApiAppOptions {
  readonly controller: SessionController;
  readonly config: ServerExperimentConfig;
  readonly configHash: string;
  readonly appVersion: string;
  readonly mode: ApplicationMode;
  readonly operatorToken?: string;
  /** Present only in an explicitly started test server; never mounted in production or rehearsal. */
  readonly testHooks?: ApiTestHooks;
}

export interface ApplicationOptions extends ApiAppOptions {
  readonly rootDirectory?: string;
  /** Test-only: serve the compiled client while retaining explicit test-mode API boundaries. */
  readonly serveBuiltAssets?: boolean;
}

export interface ApplicationRuntime {
  readonly app: Express;
  close(): Promise<void>;
}

function isJsonSyntaxError(error: unknown): error is SyntaxError & { status: number } {
  return error instanceof SyntaxError && "status" in error && error.status === 400;
}

const apiErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next): void => {
  void _next;
  if (error instanceof ZodError) {
    response.status(400).json({ error: "入力内容が正しくありません。", code: "INVALID_INPUT" });
    return;
  }
  if (error instanceof HttpError) {
    const body: { error: string; code?: string } = { error: error.message };
    if (error.code !== undefined) body.code = error.code;
    response.status(error.status).json(body);
    return;
  }
  if (isJsonSyntaxError(error)) {
    response.status(400).json({ error: "JSONの形式が正しくありません。", code: "INVALID_JSON" });
    return;
  }
  if (error instanceof PufferDeviceError) {
    response.status(503).json({ error: "装置との通信を完了できませんでした。", code: error.code });
    return;
  }

  const knownCode =
    error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const body: { error: string; code?: string } = { error: "サーバ内部で処理を完了できませんでした。" };
  if (knownCode !== undefined) body.code = knownCode;
  response.status(500).json(body);
};

/** Creates the API surface without starting a listener; useful for integration tests. */
export function createApiApp(options: ApiAppOptions): Express {
  if (options.testHooks !== undefined && options.mode !== "test") {
    throw new Error("API test hooks are available only in explicit test mode.");
  }
  const app = express();
  app.disable("x-powered-by");
  app.use(
    securityMiddleware({
      allowLan: options.config.network.allowLan,
      bindHost: options.config.bindHost,
      ...(options.operatorToken === undefined ? {} : { operatorToken: options.operatorToken }),
    }),
  );
  app.use(express.json({ limit: "16kb", strict: true }));
  app.get("/healthz", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      status: "ok",
      appVersion: options.appVersion,
      protocolVersion: options.config.protocolVersion,
      configHash: options.configHash,
      deviceMode: options.config.device.mode,
    });
  });
  app.use("/api", createApiRouter(options.controller, options.config, options.testHooks));
  app.use("/api", ((_request, response) => {
    response.status(404).json({ error: "APIが見つかりません。", code: "API_NOT_FOUND" });
  }) satisfies RequestHandler);
  app.use(apiErrorHandler);
  return app;
}

export async function createApplication(options: ApplicationOptions): Promise<ApplicationRuntime> {
  if (options.serveBuiltAssets === true && options.mode !== "test") {
    throw new Error("serveBuiltAssets is available only in explicit test mode.");
  }
  const app = createApiApp(options);
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  let close = async (): Promise<void> => undefined;

  if (
    (options.mode === "development" || options.mode === "test")
    && options.serveBuiltAssets !== true
  ) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: rootDirectory,
      appType: "spa",
      // React Refresh injects an inline module which the experiment CSP must reject.
      // Development/test serving therefore keeps HMR disabled and uses full reloads.
      server: { middlewareMode: true, hmr: false },
    });
    app.use(vite.middlewares);
    close = async () => vite.close();
  } else if (
    options.mode === "production"
    || options.mode === "rehearsal"
    || options.mode === "screen-pilot"
    || (options.mode === "test" && options.serveBuiltAssets === true)
  ) {
    const clientDirectory = resolve(rootDirectory, "dist");
    const indexPath = resolve(clientDirectory, "index.html");
    if (!existsSync(indexPath)) {
      throw new Error(`Built client was not found at ${indexPath}. Run npm run build first.`);
    }
    app.use(
      express.static(clientDirectory, {
        index: false,
        setHeaders(response, filePath) {
          response.setHeader(
            "Cache-Control",
            filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
          );
        },
      }),
    );
    app.get(["/", "/operator", "/device-test", "/display/:token"], (_request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.sendFile(indexPath);
    });
  }

  app.use((_request, response) => {
    response.status(404).json({ error: "ページが見つかりません。", code: "NOT_FOUND" });
  });
  app.use(apiErrorHandler);

  return { app, close };
}
