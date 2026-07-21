/// <reference lib="dom" />

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface RunningBuiltServer {
  readonly url: string;
  close(): Promise<void>;
}

interface BuiltServerModule {
  readonly startServer: (options: {
    readonly rootDirectory: string;
    readonly configPath: string;
    readonly mode: "test";
    readonly serveBuiltAssets: true;
  }) => Promise<RunningBuiltServer>;
}

type JsonRecord = Record<string, unknown>;

const WORKSPACE = resolve(import.meta.dirname, "../..");
const FORM_URL = "https://forms.gle/BeShY7cY5zMjunto9";

let temporaryRoot: string | null = null;
let deployment: RunningBuiltServer | null = null;

function record(value: unknown): JsonRecord {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as JsonRecord;
}

async function runNodeScript(script: string, args: readonly string[] = []): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [script, ...args],
      { cwd: WORKSPACE, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveRun();
          return;
        }
        rejectRun(new Error(
          `Production build command failed: ${error.message}\n${stdout}\n${stderr}`,
          { cause: error },
        ));
      },
    );
  });
}

async function reserveAvailablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = probe.address();
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
  if (address === null || typeof address === "string") throw new Error("Could not reserve a deployment port.");
  return address.port;
}

async function buildAndStartProductionServer(): Promise<RunningBuiltServer> {
  await runNodeScript(resolve(WORKSPACE, "scripts/build-vite.mjs"), ["client"]);
  await runNodeScript(resolve(WORKSPACE, "scripts/build-server.mjs"));

  const port = await reserveAvailablePort();
  temporaryRoot = await mkdtemp(join(tmpdir(), "sechack-built-deployment-"));
  await cp(resolve(WORKSPACE, "dist"), join(temporaryRoot, "dist"), { recursive: true });
  await mkdir(join(temporaryRoot, "config"), { recursive: true });

  const sourceConfig: unknown = JSON.parse(
    await readFile(resolve(WORKSPACE, "config/experiment.e2e.json"), "utf8"),
  );
  const config = record(sourceConfig);
  const logging = record(config["logging"]);
  const device = record(config["device"]);
  await writeFile(
    join(temporaryRoot, "config/experiment.json"),
    `${JSON.stringify({
      ...config,
      port,
      formUrl: FORM_URL,
      logging: { ...logging, directory: "./data/sessions" },
      // This temporary deployment is an automated UI audit, never a production approval.
      device: { ...device, allowMockInProduction: false },
    }, null, 2)}\n`,
    "utf8",
  );

  const builtModuleValue: unknown = await import(
    `${pathToFileURL(resolve(WORKSPACE, "dist-server/index.js")).href}?deployment=${Date.now()}`
  );
  if (
    builtModuleValue === null
    || typeof builtModuleValue !== "object"
    || typeof (builtModuleValue as { readonly startServer?: unknown }).startServer !== "function"
  ) {
    throw new Error("The built server does not export startServer().");
  }
  const builtModule = builtModuleValue as BuiltServerModule;
  return builtModule.startServer({
    rootDirectory: temporaryRoot,
    configPath: "config/experiment.json",
    mode: "test",
    serveBuiltAssets: true,
  });
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
}

async function operatorSnapshot(
  request: APIRequestContext,
  baseUrl: string,
  sessionId: string,
): Promise<JsonRecord> {
  const response = await request.get(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`);
  expect(response.ok()).toBeTruthy();
  return record(record(await response.json()).snapshot);
}

test.beforeAll(async () => {
  deployment = await buildAndStartProductionServer();
});

test.afterAll(async () => {
  try {
    await deployment?.close();
  } finally {
    if (temporaryRoot !== null) await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("built production server keeps direct routes, QR, caching, and runtime requests deployment-safe", async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  if (deployment === null) throw new Error("Production deployment did not start.");
  const baseUrl = deployment.url;
  const base = new URL(baseUrl);

  const indexResponse = await request.get(`${baseUrl}/operator`);
  expect(indexResponse.status()).toBe(200);
  expect(indexResponse.headers()["cache-control"]).toBe("no-store");
  expect(indexResponse.headers()["content-type"]).toContain("text/html");
  const builtHtml = await indexResponse.text();
  expect(builtHtml).not.toContain("/src/client/main.tsx");
  expect(builtHtml).not.toMatch(/https?:\/\//u);

  const assetPaths = [...new Set(
    [...builtHtml.matchAll(/\b(?:src|href)="(\/assets\/[^"]+)"/gu)]
      .map((match) => match[1])
      .filter((path): path is string => path !== undefined),
  )];
  expect(assetPaths.length).toBeGreaterThanOrEqual(2);
  for (const assetPath of assetPaths) {
    expect(assetPath).toMatch(/^\/assets\/[^/]+-[A-Za-z0-9_-]+\.(?:css|js)$/u);
    const assetResponse = await request.get(`${baseUrl}${assetPath}`);
    expect(assetResponse.status()).toBe(200);
    expect(assetResponse.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  }
  const firstAssetPath = assetPaths[0];
  if (firstAssetPath === undefined) throw new Error("The production index did not contain a built asset.");
  const staleAssetPath = firstAssetPath.replace(/-[A-Za-z0-9_-]+(?=\.(?:css|js)$)/u, "-stale-build");
  expect(staleAssetPath).not.toBe(firstAssetPath);
  const staleAsset = await request.get(`${baseUrl}${staleAssetPath}`);
  expect(staleAsset.status()).toBe(404);
  expect(staleAsset.headers()["content-type"]).toContain("application/json");

  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  context.on("request", (webRequest) => {
    const url = new URL(webRequest.url());
    if (
      ["http:", "https:", "ws:", "wss:"].includes(url.protocol)
      && (url.hostname !== base.hostname || url.port !== base.port)
    ) {
      externalRequests.push(webRequest.url());
    }
  });
  context.on("page", (openedPage) => {
    openedPage.on("pageerror", (error) => pageErrors.push(error.message));
  });

  const operator = await context.newPage();
  const operatorResponse = await operator.goto(`${baseUrl}/operator`);
  expect(operatorResponse?.status()).toBe(200);
  expect(operatorResponse?.headers()["cache-control"]).toBe("no-store");
  await expect(operator.getByTestId("operator-app")).toBeVisible();
  await expectNoDocumentOverflow(operator);
  const operatorReload = await operator.reload();
  expect(operatorReload?.status()).toBe(200);
  expect(operatorReload?.headers()["cache-control"]).toBe("no-store");
  await expect(operator.getByTestId("operator-app")).toBeVisible();
  await expectNoDocumentOverflow(operator);

  const browserStorage = await operator.evaluate(async () => ({
    serviceWorkers: "serviceWorker" in navigator
      ? (await navigator.serviceWorker.getRegistrations()).length
      : 0,
    cacheKeys: "caches" in window ? await window.caches.keys() : [],
  }));
  expect(browserStorage).toEqual({ serviceWorkers: 0, cacheKeys: [] });

  const deviceTestResponse = await operator.goto(`${baseUrl}/device-test`);
  expect(deviceTestResponse?.status()).toBe(200);
  expect(deviceTestResponse?.headers()["cache-control"]).toBe("no-store");
  await expect(operator.getByTestId("device-test-app")).toBeVisible();
  await expectNoDocumentOverflow(operator);
  const deviceReload = await operator.reload();
  expect(deviceReload?.status()).toBe(200);
  expect(deviceReload?.headers()["cache-control"]).toBe("no-store");
  await expect(operator.getByTestId("device-test-app")).toBeVisible();
  await expectNoDocumentOverflow(operator);

  const connected = await request.post(`${baseUrl}/api/device/connect`);
  expect(connected.ok()).toBeTruthy();
  await operator.goto(`${baseUrl}/operator`);
  await operator.getByLabel("研究用ID").fill("SH26-950");
  await operator.getByRole("checkbox", { name: /リハーサル開始条件を確認済み/u }).check();
  await operator.getByRole("button", { name: "リハーサルを準備" }).click();
  await expect(operator.getByRole("heading", { name: "進行状況" })).toBeVisible();
  const sessionId = await operator.evaluate(() => window.sessionStorage.getItem("sechack.active-session-id"));
  expect(sessionId).not.toBeNull();
  const displayPath = await operator.locator("#display-url").inputValue();
  expect(displayPath).toMatch(/^\/display\/[A-Za-z0-9_-]{32,128}$/u);
  await expectNoDocumentOverflow(operator);

  const restoredOperator = await operator.reload();
  expect(restoredOperator?.status()).toBe(200);
  expect(restoredOperator?.headers()["cache-control"]).toBe("no-store");
  await expect(operator.getByRole("heading", { name: "進行状況" })).toBeVisible();
  await expectNoDocumentOverflow(operator);

  const display = await context.newPage();
  const displayResponse = await display.goto(`${baseUrl}${displayPath}`);
  expect(displayResponse?.status()).toBe(200);
  expect(displayResponse?.headers()["cache-control"]).toBe("no-store");
  await expect(display.getByTestId("participant-app")).toBeVisible();
  await expectNoDocumentOverflow(display);
  await expect.poll(async () => (
    await operatorSnapshot(request, baseUrl, String(sessionId))
  )["displayConnected"]).toBe(true);

  const displayReload = await display.reload();
  expect(displayReload?.status()).toBe(200);
  expect(displayReload?.headers()["cache-control"]).toBe("no-store");
  await expect(display.getByTestId("participant-app")).toBeVisible();
  await expectNoDocumentOverflow(display);
  await expect.poll(async () => (
    await operatorSnapshot(request, baseUrl, String(sessionId))
  )["displayConnected"]).toBe(true);

  await operator.getByRole("checkbox", { name: /全画面表示し、目視確認済み/u }).check();
  const prepareButton = operator.getByRole("button", { name: "共通導入を表示" });
  await expect(prepareButton).toBeEnabled();
  await prepareButton.click();
  await expect(display.getByRole("heading", { name: "同じ身体データを、4つの方法で提示します" })).toBeVisible();
  await operator.getByRole("button", { name: "提示を開始" }).click();

  await expect(display.getByRole("heading", { name: "4つの提示は終了しました" })).toBeVisible({
    timeout: 15_000,
  });
  await expectNoDocumentOverflow(display);
  await expectNoDocumentOverflow(operator);

  const displayToken = decodeURIComponent(displayPath.slice("/display/".length));
  const publicResponse = await request.get(`${baseUrl}/api/display/${encodeURIComponent(displayToken)}`);
  expect(publicResponse.ok()).toBeTruthy();
  expect(record(record(await publicResponse.json()).snapshot)["formUrl"]).toBe(FORM_URL);

  const formLink = display.getByRole("link", { name: "Googleフォームに戻って回答する" });
  await expect(formLink).toHaveAttribute("href", FORM_URL);
  await expect(formLink).toHaveAttribute("target", "_blank");
  await expect(formLink).toHaveAttribute("rel", /noreferrer/u);
  const qr = display.getByRole("img", { name: "Googleフォームを開くQRコード" });
  await expect(qr).toBeVisible();
  await expect(qr).toHaveAttribute("src", /^data:image\/png;base64,/u);
  const qrState = await qr.evaluate((image) => {
    const element = image as HTMLImageElement;
    return { complete: element.complete, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight };
  });
  expect(qrState.complete).toBe(true);
  expect(qrState.naturalWidth).toBeGreaterThan(0);
  expect(qrState.naturalHeight).toBeGreaterThan(0);
  const qrSource = await qr.getAttribute("src");
  const pngBytes = Buffer.from(qrSource?.split(",", 2)[1] ?? "", "base64");
  expect(pngBytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

  expect(display.url()).toBe(`${baseUrl}${displayPath}`);
  expect(context.pages()).toHaveLength(2);
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);

  await operator.getByRole("checkbox", { name: /リハーサルの確認を完了済み/u }).check();
  await operator.getByRole("button", { name: "確認を完了してリハーサル終了" }).click();
  await expect(display.getByRole("heading", { name: "ご協力ありがとうございました" })).toBeVisible();

  const invalidDisplay = await context.newPage();
  const invalidResponse = await invalidDisplay.goto(`${baseUrl}/display/invalid-token`);
  expect(invalidResponse?.status()).toBe(200);
  expect(invalidResponse?.headers()["cache-control"]).toBe("no-store");
  await expect(invalidDisplay.getByRole("heading", { name: "実験を一時停止しています" })).toBeVisible();
  await expectNoDocumentOverflow(invalidDisplay);

  const browserStaleStatus = await invalidDisplay.evaluate(async (path) => (
    await fetch(path, { cache: "no-store" })
  ).status, staleAssetPath);
  expect(browserStaleStatus).toBe(404);
  expect(externalRequests).toEqual([]);

  await context.close();
});
