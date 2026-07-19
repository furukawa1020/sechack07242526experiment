/// <reference lib="dom" />

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type Viewport = { readonly width: number; readonly height: number; readonly label: string };
type JsonRecord = Record<string, unknown>;

const VIEWPORTS: readonly Viewport[] = [
  { width: 1366, height: 768, label: "1366x768" },
  { width: 1920, height: 1080, label: "1920x1080" },
];

function record(value: unknown): JsonRecord {
  return value as JsonRecord;
}

async function ensureDevice(request: APIRequestContext): Promise<void> {
  const response = await request.get("/api/device/status");
  const status = record(record(await response.json()).status);
  if (status.state === "disconnected") {
    expect((await request.post("/api/device/connect")).ok()).toBeTruthy();
  }
}

async function create(
  request: APIRequestContext,
  researchId: string,
  orderCode: "ABDC" | "CDBA",
): Promise<{ id: string; displayUrl: string }> {
  const response = await request.post("/api/sessions", {
    data: { researchId, consentConfirmed: true, orderCode },
  });
  expect(response.status()).toBe(201);
  const body = record(await response.json());
  return { id: String(record(body.snapshot).id), displayUrl: String(body.displayUrl) };
}

async function sessionAction(
  request: APIRequestContext,
  id: string,
  action: "prepare" | "start" | "abort" | "confirm-form-complete",
): Promise<void> {
  const response = await request.post(`/api/sessions/${encodeURIComponent(id)}/${action}`);
  expect(response.ok()).toBeTruthy();
}

async function waitForDisplay(request: APIRequestContext, id: string): Promise<void> {
  await expect.poll(async () => {
    const response = await request.get(`/api/sessions/${encodeURIComponent(id)}`);
    return record(record(await response.json()).snapshot).displayConnected;
  }).toBe(true);
}

async function expectNoViewportOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ horizontal: false, vertical: false });
}

async function capture(page: Page, name: string): Promise<void> {
  await expectNoViewportOverflow(page);
  await page.screenshot({ path: `artifacts/screenshots/${name}.png`, fullPage: false });
}

test("主要画面の承認用スクリーンショットを生成する", async ({ page, request }) => {
  test.setTimeout(90_000);
  await ensureDevice(request);

  for (const [viewportIndex, viewport] of VIEWPORTS.entries()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto("/operator");
    await expect(page.getByTestId("operator-app")).toBeVisible();
    await page.screenshot({
      path: `artifacts/screenshots/operator-${viewport.label}.png`,
      fullPage: true,
    });

    await page.goto("/device-test");
    await expect(page.getByTestId("device-test-app")).toBeVisible();
    await page.screenshot({
      path: `artifacts/screenshots/device-test-${viewport.label}.png`,
      fullPage: true,
    });

    const labelSession = await create(request, `SH26-94${viewportIndex * 2}`, "ABDC");
    await page.goto(labelSession.displayUrl);
    await waitForDisplay(request, labelSession.id);
    await sessionAction(request, labelSession.id, "prepare");
    await expect(page.getByRole("heading", { name: "同じ身体データを、4つの方法で提示します" })).toBeVisible();
    await capture(page, `participant-intro-${viewport.label}`);

    await sessionAction(request, labelSession.id, "start");
    await expect(page.getByTestId("participant-app")).toHaveAttribute("data-phase", "result", {
      timeout: 5_000,
    });
    await capture(page, `participant-label-result-${viewport.label}`);
    await expect(page.getByRole("heading", { name: "4つの提示は終了しました" })).toBeVisible({
      timeout: 15_000,
    });
    await capture(page, `participant-summary-${viewport.label}`);
    await sessionAction(request, labelSession.id, "confirm-form-complete");

    const pufferSession = await create(request, `SH26-94${viewportIndex * 2 + 1}`, "CDBA");
    await page.goto(pufferSession.displayUrl);
    await waitForDisplay(request, pufferSession.id);
    await sessionAction(request, pufferSession.id, "prepare");
    await sessionAction(request, pufferSession.id, "start");
    await expect(page.getByTestId("participant-app")).toHaveAttribute("data-phase", "result", {
      timeout: 5_000,
    });
    await capture(page, `participant-puffer-result-${viewport.label}`);
    await sessionAction(request, pufferSession.id, "abort");
  }
});
