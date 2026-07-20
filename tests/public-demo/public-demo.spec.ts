/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

interface NetworkAudit {
  readonly externalRequests: string[];
  readonly activeRequests: string[];
  readonly webSockets: string[];
}

function monitorNetwork(page: Page): NetworkAudit {
  const audit: NetworkAudit = { externalRequests: [], activeRequests: [], webSockets: [] };
  page.on("request", (request) => {
    const requestUrl = request.url();
    if (request.resourceType() === "fetch" || request.resourceType() === "xhr") {
      audit.activeRequests.push(requestUrl);
    }
    const hostname = new URL(requestUrl).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      audit.externalRequests.push(requestUrl);
    }
  });
  page.on("websocket", (socket) => audit.webSockets.push(socket.url()));
  return audit;
}

async function expectNoViewportOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: scrollingElement.scrollWidth,
      documentHeight: scrollingElement.scrollHeight,
    };
  });
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
}

async function expectSafeVisibleState(page: Page): Promise<void> {
  const body = page.locator("body");
  await expect(page.locator(".public-demo-notice")).toContainText("公開Mockデモ");
  await expect(page.locator(".public-demo-notice")).toContainText("研究参加用ではありません");
  await expect(page.locator(".public-demo-notice")).toContainText("入力／保存／送信なし");
  await expect(page.locator(".public-demo-notice")).toContainText("実機なし");
  await expect(page.locator("a, form, input, textarea, select")).toHaveCount(0);
  await expect(page.locator("img[alt*='QR'], canvas")).toHaveCount(0);
  await expect(body).not.toContainText("Googleフォーム");
  await expect(body).not.toContainText(/(?:内部コード|条件コード)/u);
  await expect(page.getByText(/^[ABCD]$/u, { exact: true })).toHaveCount(0);
  await expectNoViewportOverflow(page);
}

test("固定模擬データの4提示を操作でき、入力・フォーム・内部コードを公開しない", async ({ page }) => {
  const network = monitorNetwork(page);
  await page.goto("/", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "同じ身体データを、4つの方法で提示します" })).toBeVisible();
  await expect(page.locator(".public-demo-kicker")).toHaveCount(0);
  await expectSafeVisibleState(page);

  const presentations = [
    { position: 1, processing: "クラウド", presentation: "label" },
    { position: 2, processing: "この端末内", presentation: "label" },
    { position: 3, processing: "クラウド", presentation: "puffer" },
    { position: 4, processing: "この端末内", presentation: "puffer" },
  ] as const;

  for (const presentation of presentations) {
    await page.getByRole("button", { name: "次へ" }).click();
    await expect(page.locator("[data-scene='result']")).toBeVisible();
    await expect(page.locator(".public-demo-presentation-header")).toContainText(`第${presentation.position}提示 / 4`);
    await expect(page.getByTestId("handling-panel").getByText(presentation.processing, { exact: true })).toBeVisible();
    if (presentation.presentation === "label") {
      await expect(page.locator(".public-demo-label-result")).toContainText("72 / 100");
      await expect(page.locator(".public-demo-label-result")).toContainText("高ストレス");
      await expect(page.getByTestId("public-demo-puffer")).toHaveCount(0);
    } else {
      await expect(page.locator(".public-demo-puffer-result")).toContainText("状態はフグ型デバイスに");
      await expect(page.locator(".public-demo-puffer-result")).toContainText("実機は接続・動作していません");
      await expect(page.getByTestId("public-demo-puffer")).toBeVisible();
    }
    await expectSafeVisibleState(page);
  }

  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByTestId("public-demo-summary")).toBeVisible();
  await expect(page.getByTestId("public-demo-summary").locator("li")).toHaveCount(4);
  await expect(page.getByTestId("public-demo-summary")).toContainText("研究への参加や回答の送信は行いません");
  await expectSafeVisibleState(page);

  const csp = await page.locator("meta[http-equiv='Content-Security-Policy']").getAttribute("content");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("form-action 'none'");
  expect(network.activeRequests).toEqual([]);
  expect(network.webSockets).toEqual([]);
  expect(network.externalRequests).toEqual([]);
});
