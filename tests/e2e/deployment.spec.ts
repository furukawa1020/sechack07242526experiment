/// <reference lib="dom" />

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { startServer } from "../../src/server/index.js";

interface RunningBuiltServer {
  readonly url: string;
  close(): Promise<void>;
}

type JsonRecord = Record<string, unknown>;

const WORKSPACE = resolve(import.meta.dirname, "../..");

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
  const device = record(config["device"]);
  await writeFile(
    join(temporaryRoot, "config/experiment.json"),
    `${JSON.stringify({
      ...config,
      port,
      // Exercise the formal hardware-free adapter through the compiled server.
      // Test mode adds a permanent nonparticipant banner and suppresses forms.
      device: { ...device, mode: "screen", allowMockInProduction: false },
    }, null, 2)}\n`,
    "utf8",
  );

  const builtModuleValue: unknown = await import(
    `${pathToFileURL(resolve(WORKSPACE, "dist-server/index.js")).href}?deployment=${Date.now()}`
  );
  expect(Object.keys(builtModuleValue as object)).toEqual(["startProductionReleaseCli"]);
  expect(
    (builtModuleValue as { readonly startProductionReleaseCli?: unknown })
      .startProductionReleaseCli,
  ).toEqual(expect.any(Function));
  expect(builtModuleValue).not.toHaveProperty("startServer");

  // Exercise the compiled client and static-asset routing without exposing a
  // generic runtime entry from the production bundle.
  return startServer({
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

test("built nonparticipant client keeps direct routes, caching, and runtime requests deployment-safe", async ({
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

  const unavailableDisconnectHook = await request.post(
    `${baseUrl}/api/test/mock-device/disconnect`,
    { data: { command: "inflate" } },
  );
  expect(unavailableDisconnectHook.status()).toBe(404);
  expect(await unavailableDisconnectHook.json()).toMatchObject({ code: "API_NOT_FOUND" });
  const unavailableCommandHistory = await request.get(
    `${baseUrl}/api/test/mock-device/commands`,
  );
  expect(unavailableCommandHistory.status()).toBe(404);
  expect(await unavailableCommandHistory.json()).toMatchObject({ code: "API_NOT_FOUND" });

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
    const assetText = await assetResponse.text();
    expect(assetText).not.toMatch(
      /Googleフォーム|forms\.gle|docs\.google\.com\/forms|QRコード|confirm-form-complete|qrcode|formUrl|formAudit/iu,
    );
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
  await expect(operator.getByText("非参加者用の事前確認")).toBeVisible();
  await expect(operator.getByText(/本番参加者には使用しないでください/u)).toBeVisible();
  await expect(operator.locator(".screen-mode-pill")).toHaveText("画面版・PILOT/テスト");
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

  const initialOperatorConfirmation = await request.get(
    `${baseUrl}/api/operator/session-confirmation`,
  );
  expect(initialOperatorConfirmation.ok()).toBeTruthy();
  expect(await initialOperatorConfirmation.json()).toEqual({
    confirmed: false,
    checks: {
      todayProcedureConfirmed: false,
      participantConsentConfirmed: false,
      stopOperationConfirmed: false,
      physicalDeviceSafetyConfirmed: false,
    },
    technicalReadiness: "GO",
    participantMode: "disabled",
    complianceMode: "external",
    approvalEvidence: "managed-outside-system",
    approvalVerifiedByApplication: false,
  });

  const rejectedWithoutConsent = await request.post(`${baseUrl}/api/sessions`, {
    data: {
      researchId: "TEST-949",
      consentConfirmed: false,
      orderCode: "ABDC",
    },
  });
  expect(rejectedWithoutConsent.status()).toBe(400);
  expect(await rejectedWithoutConsent.json()).toMatchObject({ code: "INVALID_INPUT" });

  const operatorGate = operator.getByRole("region", {
    name: "外部管理事項と当日運用の確認",
  });
  await expect(operatorGate).toContainText("技術状態");
  await expect(operatorGate).toContainText("実施可能");
  await expect(operatorGate).toContainText("参加者モード");
  await expect(operatorGate).toContainText("無効");
  await expect(operatorGate).toContainText("承認証跡");
  await expect(operatorGate).toContainText("本システム外で管理");
  await expect(operatorGate).toContainText("本システムによる承認検証");
  await expect(operatorGate).toContainText("実施しない");
  await expect(operatorGate).not.toContainText(/承認済み|二名照合|SHA-256/u);

  const confirmOperatorSessionButton = operator.getByRole("button", {
    name: "当日の実験運用を開始する",
  });
  await expect(confirmOperatorSessionButton).toBeDisabled();
  await operator.getByRole("checkbox", {
    name: "本日の実施が、研究責任者から指示された手順に従っている",
  }).check();
  await operator.getByRole("checkbox", { name: "実験中止操作を確認した" }).check();
  await operator.getByRole("checkbox", {
    name: "実機を使用する場合、STOPおよび収縮動作を確認した",
  }).check();
  await expect(confirmOperatorSessionButton).toBeDisabled();
  await operator.getByRole("checkbox", {
    name: "参加者が研究説明・同意フォームを完了したことを確認した",
  }).check();
  await expect(confirmOperatorSessionButton).toBeEnabled();
  await confirmOperatorSessionButton.click();
  await expect(operatorGate.getByRole("status")).toContainText(
    "これは倫理承認の証跡ではありません。",
  );

  const confirmedOperatorSession = await request.get(
    `${baseUrl}/api/operator/session-confirmation`,
  );
  expect(confirmedOperatorSession.ok()).toBeTruthy();
  expect(await confirmedOperatorSession.json()).toMatchObject({
    confirmed: true,
    checks: {
      todayProcedureConfirmed: true,
      participantConsentConfirmed: true,
      stopOperationConfirmed: true,
      physicalDeviceSafetyConfirmed: true,
    },
    complianceMode: "external",
    approvalEvidence: "managed-outside-system",
    approvalVerifiedByApplication: false,
  });

  await operator.getByLabel("研究用ID").fill("TEST-950");
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
  await expect(display.getByRole("heading", { name: "同じ固定模擬データを、4つの方法で提示します" })).toBeVisible();
  await operator.getByRole("button", { name: "提示を開始" }).click();

  for (let position = 1; position <= 4; position += 1) {
    await expect(
      display.getByRole("heading", { name: `第${String(position)}提示は終了しました` }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(display.getByText("研究スタッフの案内をお待ちください。")).toBeVisible();
    const checkpointText = await display.getByTestId("participant-app").innerText();
    expect(checkpointText).not.toMatch(
      /Googleフォーム|forms\.gle|QRコード|アンケート|高ストレス|72\s*\/\s*100/iu,
    );
    const checkpointButton = operator.getByRole("button", {
      name: "待機表示を確認して次へ",
    });
    await expect(checkpointButton).toBeEnabled();
    await checkpointButton.click();
  }

  await expect(display.getByRole("heading", { name: "4つの提示は終了しました" })).toBeVisible({
    timeout: 15_000,
  });
  await expectNoDocumentOverflow(display);
  await expectNoDocumentOverflow(operator);

  const displayToken = decodeURIComponent(displayPath.slice("/display/".length));
  const publicResponse = await request.get(`${baseUrl}/api/display/${encodeURIComponent(displayToken)}`);
  expect(publicResponse.ok()).toBeTruthy();
  expect(record(record(await publicResponse.json()).snapshot)).not.toHaveProperty("formUrl");
  await expect(
    display.getByText("研究参加用ではありません・外部回答送信なし"),
  ).toBeVisible();

  expect(await display.locator("body").innerText()).not.toMatch(/Googleフォーム|forms\.gle|QRコード|アンケート/iu);
  await expect(display.locator("a[href^='http']")).toHaveCount(0);
  await expect(display.getByRole("img")).toHaveCount(0);

  expect(display.url()).toBe(`${baseUrl}${displayPath}`);
  expect(context.pages()).toHaveLength(2);
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);

  await operator.getByRole("checkbox", { name: /リハーサルの確認を完了済み/u }).check();
  await operator.getByRole("button", { name: "確認を完了してリハーサル終了" }).click();
  await expect(
    display.getByRole("heading", { name: "非参加者用の事前確認を終了しました" }),
  ).toBeVisible();

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
