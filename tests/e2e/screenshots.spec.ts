/// <reference lib="dom" />

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

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
  await page.evaluate(async () => document.fonts.ready);
  const report = await page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    const inspected = document.querySelectorAll<HTMLElement>([
      "[data-surface]",
      ".operator-header",
      ".operator-layout",
      ".operator-card",
      ".operator-status-grid",
      ".display-url-block",
      ".emergency-button",
      ".device-test-header",
      ".device-test-layout",
      ".device-status-hero",
      ".device-command-card",
      ".device-event-card",
      ".device-event-list code",
      ".participant-footer",
      ".participant-intro",
      ".intro-card",
      ".participant-condition-stage",
      ".condition-grid",
      ".condition-panel",
      ".participant-summary",
    ].join(","));
    const outsideViewport = [...inspected].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const outside = rect.left < -1
        || rect.top < -1
        || rect.right > viewport.width + 1
        || rect.bottom > viewport.height + 1;
      if (!outside || rect.width === 0 || rect.height === 0) return [];
      return [{
        element: element.dataset["testid"] ?? element.className,
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      }];
    });
    return {
      viewport,
      document: {
        width: scrollingElement.scrollWidth,
        height: scrollingElement.scrollHeight,
      },
      body: {
        width: document.body.scrollWidth,
        height: document.body.scrollHeight,
      },
      outsideViewport,
    };
  });

  expect(report.document.width).toBeLessThanOrEqual(report.viewport.width);
  expect(report.document.height).toBeLessThanOrEqual(report.viewport.height);
  expect(report.body.width).toBeLessThanOrEqual(report.viewport.width);
  expect(report.body.height).toBeLessThanOrEqual(report.viewport.height);
  expect(report.outsideViewport).toEqual([]);
}

async function capture(page: Page, name: string): Promise<void> {
  await expectNoViewportOverflow(page);
  await page.screenshot({ path: `artifacts/screenshots/${name}.png`, fullPage: false });
}

async function expectRenderedLineCount(locator: Locator, expected: number): Promise<void> {
  const lineCount = await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const lineTops: number[] = [];
    for (const rect of range.getClientRects()) {
      if (rect.width === 0 || rect.height === 0) continue;
      if (!lineTops.some((top) => Math.abs(top - rect.top) < 1)) lineTops.push(rect.top);
    }
    return lineTops.length;
  });
  expect(lineCount).toBe(expected);
}

async function expectParticipantSurfaceFillsViewport(page: Page): Promise<void> {
  const geometry = await page.getByTestId("participant-app").evaluate((element) => {
    const surface = element.getBoundingClientRect();
    const footerElement = element.querySelector<HTMLElement>(".participant-footer");
    const footer = footerElement?.getBoundingClientRect();
    const sceneElement = [...element.children]
      .find((child): child is HTMLElement => child instanceof HTMLElement && child !== footerElement);
    const scene = sceneElement?.getBoundingClientRect();
    return {
      footerBottom: footer?.bottom ?? null,
      footerTop: footer?.top ?? null,
      height: surface.height,
      left: surface.left,
      sceneBottom: scene?.bottom ?? null,
      sceneLeft: scene?.left ?? null,
      sceneTop: scene?.top ?? null,
      sceneWidth: scene?.width ?? null,
      top: surface.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: surface.width,
    };
  });

  expect(geometry.left).toBeCloseTo(0, 1);
  expect(geometry.top).toBeCloseTo(0, 1);
  expect(geometry.width).toBeCloseTo(geometry.viewportWidth, 1);
  expect(geometry.height).toBeCloseTo(geometry.viewportHeight, 1);
  expect(geometry.footerBottom).toBeCloseTo(geometry.viewportHeight, 1);
  expect(geometry.sceneLeft).toBeCloseTo(0, 1);
  expect(geometry.sceneTop).toBeCloseTo(0, 1);
  expect(geometry.sceneWidth).toBeCloseTo(geometry.viewportWidth, 1);
  expect(geometry.sceneBottom).toBeCloseTo(geometry.footerTop ?? Number.NaN, 1);
}

async function expectChildrenCenteredWithin(
  container: Locator,
  childSelector: string,
  axes: Readonly<{ horizontal: boolean; vertical: boolean }> = {
    horizontal: true,
    vertical: true,
  },
): Promise<void> {
  const geometry = await container.evaluate((element, selector) => {
    const children = [...element.querySelectorAll<HTMLElement>(selector)]
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (children.length === 0) throw new Error(`No visible centered content matched ${selector}`);

    const bounds = element.getBoundingClientRect();
    const content = {
      bottom: Math.max(...children.map((rect) => rect.bottom)),
      left: Math.min(...children.map((rect) => rect.left)),
      right: Math.max(...children.map((rect) => rect.right)),
      top: Math.min(...children.map((rect) => rect.top)),
    };
    return {
      horizontalDelta: (content.left + content.right - bounds.left - bounds.right) / 2,
      verticalDelta: (content.top + content.bottom - bounds.top - bounds.bottom) / 2,
    };
  }, childSelector);

  if (axes.horizontal) expect(Math.abs(geometry.horizontalDelta)).toBeLessThanOrEqual(2);
  if (axes.vertical) expect(Math.abs(geometry.verticalDelta)).toBeLessThanOrEqual(2);
}

test("主要画面の承認用スクリーンショットを生成する", async ({ page, request }) => {
  test.setTimeout(90_000);
  await ensureDevice(request);
  // The preceding emergency-stop E2E intentionally locks device-test actions.
  // Creating and safely deleting a setup session is the production reset path.
  const resetSession = await create(request, "SH26-939", "ABDC");
  expect((await request.delete(`/api/sessions/${encodeURIComponent(resetSession.id)}`)).ok()).toBeTruthy();

  for (const [viewportIndex, viewport] of VIEWPORTS.entries()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto("/operator");
    await expect(page.getByTestId("operator-app")).toBeVisible();
    await capture(page, `operator-${viewport.label}`);

    await page.goto("/device-test");
    await expect(page.getByTestId("device-test-app")).toBeVisible();
    await page.getByRole("button", { name: "膨張テスト" }).click();
    await expect(page.locator(".device-event-list code")).toHaveCount(1);
    await page.getByRole("button", { name: "収縮" }).click();
    await expect(page.locator(".device-event-list code")).toHaveCount(2);
    await capture(page, `device-test-${viewport.label}`);
    await expect.poll(async () => {
      const response = await request.get("/api/device/status");
      return record(record(await response.json()).status).state;
    }).toBe("idle");

    const labelSession = await create(request, `SH26-94${viewportIndex * 2}`, "ABDC");
    await page.goto(labelSession.displayUrl);
    await waitForDisplay(request, labelSession.id);

    const operatorPage = await page.context().newPage();
    await operatorPage.setViewportSize({ width: viewport.width, height: viewport.height });
    await operatorPage.goto("/operator");
    await expect(operatorPage.getByRole("heading", { name: "進行状況" })).toBeVisible();
    await expect(operatorPage.getByRole("button", { name: /緊急停止/u })).toBeVisible();
    await operatorPage.getByRole("checkbox", { name: /全画面表示し、目視確認済み/u }).check();
    await capture(operatorPage, `operator-session-${viewport.label}`);
    await operatorPage.getByRole("button", { name: "共通導入を表示" }).click();

    const introHeading = page.getByRole("heading", { name: "同じ身体データを、4つの方法で提示します" });
    await expect(introHeading).toBeVisible();
    await expect(page.locator(".message-eyebrow")).toHaveCount(0);
    await expectRenderedLineCount(introHeading, 1);
    await expectParticipantSurfaceFillsViewport(page);
    await expectChildrenCenteredWithin(page.locator(".participant-intro"), ":scope > .intro-card");
    await expect(page.locator(".intro-card")).toHaveCSS("text-align", "center");
    await capture(page, `participant-intro-${viewport.label}`);

    await sessionAction(request, labelSession.id, "start");
    await expect(page.getByTestId("participant-app")).toHaveAttribute("data-phase", "result", {
      timeout: 5_000,
    });
    await expectParticipantSurfaceFillsViewport(page);
    await expectChildrenCenteredWithin(page.locator(".label-result"), ":scope > *");
    await capture(page, `participant-label-result-${viewport.label}`);
    const summaryHeading = page.getByRole("heading", { name: "4つの提示は終了しました" });
    await expect(summaryHeading).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".message-eyebrow")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Googleフォームを開くQRコード" })).toBeVisible();
    await expectParticipantSurfaceFillsViewport(page);
    await expectChildrenCenteredWithin(
      page.locator(".participant-summary"),
      ":scope > *",
      { horizontal: false, vertical: true },
    );
    await capture(page, `participant-summary-${viewport.label}`);
    await sessionAction(request, labelSession.id, "confirm-form-complete");
    await operatorPage.close();

    const pufferSession = await create(request, `SH26-94${viewportIndex * 2 + 1}`, "CDBA");
    await page.goto(pufferSession.displayUrl);
    await waitForDisplay(request, pufferSession.id);
    const pufferOperatorPage = await page.context().newPage();
    await pufferOperatorPage.setViewportSize({ width: viewport.width, height: viewport.height });
    await pufferOperatorPage.goto("/operator");
    await expect(pufferOperatorPage.getByRole("heading", { name: "進行状況" })).toBeVisible();
    await pufferOperatorPage.getByRole("checkbox", { name: /全画面表示し、目視確認済み/u }).check();
    await pufferOperatorPage.getByRole("button", { name: "共通導入を表示" }).click();
    await expect(page.getByRole("heading", { name: "同じ身体データを、4つの方法で提示します" })).toBeVisible();
    await sessionAction(request, pufferSession.id, "start");
    await expect(page.getByTestId("participant-app")).toHaveAttribute("data-phase", "result", {
      timeout: 5_000,
    });
    await expectRenderedLineCount(page.locator(".puffer-result > p"), 2);
    await expectParticipantSurfaceFillsViewport(page);
    await expectChildrenCenteredWithin(page.locator(".puffer-result"), ":scope > *");
    await capture(page, `participant-puffer-result-${viewport.label}`);
    await sessionAction(request, pufferSession.id, "abort");
    await pufferOperatorPage.close();
  }
});
