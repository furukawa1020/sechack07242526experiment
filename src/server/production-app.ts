import { existsSync } from "node:fs";
import { resolve } from "node:path";

import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { ZodError } from "zod";

import type { ExperimentConfig } from "../shared/schemas.js";
import { HttpError } from "./api/http-error.js";
import { createProductionApiRouter } from "./api/production-router.js";
import { PufferDeviceError } from "./devices/types.js";
import { securityMiddleware } from "./security/http-security.js";
import type { SessionController } from "./sessions/session-controller.js";

export interface ProductionApplicationOptions {
  readonly controller: SessionController;
  readonly config: ExperimentConfig;
  readonly configHash: string;
  readonly appVersion: string;
  readonly rootDirectory: string;
  readonly operatorToken?: string;
}

export interface ProductionApplicationRuntime {
  readonly app: Express;
  close(): Promise<void>;
}

function isJsonSyntaxError(error: unknown): error is SyntaxError & { status: number } {
  return error instanceof SyntaxError && "status" in error && error.status === 400;
}

const productionErrorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
): void => {
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
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const body: { error: string; code?: string } = {
    error: "サーバ内部で処理を完了できませんでした。",
  };
  if (knownCode !== undefined) body.code = knownCode;
  response.status(500).json(body);
};

/** Creates the formal static application without any development or test branch. */
export async function createProductionApplication(
  options: ProductionApplicationOptions,
): Promise<ProductionApplicationRuntime> {
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
  app.use("/api", createProductionApiRouter(options.controller, options.config));
  app.use("/api", ((_request, response) => {
    response.status(404).json({ error: "APIが見つかりません。", code: "API_NOT_FOUND" });
  }) satisfies RequestHandler);

  const clientDirectory = resolve(options.rootDirectory, "dist");
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

  app.use((_request, response) => {
    response.status(404).json({ error: "ページが見つかりません。", code: "NOT_FOUND" });
  });
  app.use(productionErrorHandler);

  return {
    app,
    async close(): Promise<void> {
      // Formal production serves only immutable built assets and owns no Vite lifecycle.
    },
  };
}
