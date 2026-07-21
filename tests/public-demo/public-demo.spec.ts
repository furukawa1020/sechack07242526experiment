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

interface ViewportDimensions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
}

async function viewportDimensions(page: Page): Promise<ViewportDimensions> {
  return page.evaluate(() => {
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: scrollingElement.scrollWidth,
      documentHeight: scrollingElement.scrollHeight,
    };
  });
}

async function expectResponsiveViewportState(page: Page): Promise<void> {
  const dimensions = await viewportDimensions(page);
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  if (dimensions.viewportWidth > 640) {
    expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
  }
}

function relativeLuminance(cssRgb: string): number {
  const channels = cssRgb
    .match(/[\d.]+/gu)
    ?.slice(0, 3)
    .map(Number);
  if (channels === undefined || channels.length !== 3) {
    throw new Error(`Unsupported computed color: ${cssRgb}`);
  }
  const linear = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

async function expectSafeVisibleState(page: Page): Promise<void> {
  const body = page.locator("body");
  await expect(page.locator(".public-demo-notice")).toContainText("公開デモ（模擬表示）");
  await expect(page.locator(".public-demo-notice")).not.toContainText("公開Mockデモ");
  await expect(page.locator(".public-demo-notice")).toContainText("研究参加用ではありません");
  await expect(page.locator(".public-demo-notice")).toContainText("入力／保存／送信なし");
  await expect(page.locator(".public-demo-notice")).toContainText("実機なし");
  await expect(page.locator("a, form, input, textarea, select")).toHaveCount(0);
  await expect(page.locator("img[alt*='QR'], canvas")).toHaveCount(0);
  await expect(body).not.toContainText("Googleフォーム");
  await expect(body).not.toContainText(/(?:内部コード|条件コード)/u);
  await expect(page.getByText(/^[ABCD]$/u, { exact: true })).toHaveCount(0);
  await expectResponsiveViewportState(page);
}

async function resetScreenshotScroll(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
}

test("固定模擬データの4提示を操作でき、入力・フォーム・内部コードを公開しない", async ({
  page,
}, testInfo) => {
  const network = monitorNetwork(page);
  const ignoredCspDirectives: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("frame-ancestors")) {
      ignoredCspDirectives.push(message.text());
    }
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const viewportName = testInfo.project.name.replace("chromium-", "");

  await expect(
    page.getByRole("heading", { name: "同じ身体データを、4つの方法で提示します" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(
    "同じ身体データを、4つの方法で提示します",
  );
  await expect(page.locator("main main, article main")).toHaveCount(0);
  await expect(page.locator(".public-demo-kicker")).toHaveCount(0);
  await expectSafeVisibleState(page);
  await page.screenshot({
    path: `artifacts/screenshots/public-demo-intro-${viewportName}.png`,
    fullPage: false,
  });

  const presentations = [
    { position: 1, processing: "クラウド", presentation: "label" },
    { position: 2, processing: "この端末内", presentation: "label" },
    { position: 3, processing: "クラウド", presentation: "puffer" },
    { position: 4, processing: "この端末内", presentation: "puffer" },
  ] as const;

  let cloudLocationGeometry: Record<string, string | number> | null = null;
  let localLocationGeometry: Record<string, string | number> | null = null;

  for (const presentation of presentations) {
    if (presentation.position === 1) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    }
    await page.getByRole("button", { name: "次へ" }).click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.locator("[data-scene='result']")).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(
      `第${presentation.position}提示 / 4`,
    );
    await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveCount(2);
    await expect(page.locator("main main, article main")).toHaveCount(0);
    await expect(page.locator(".public-demo-presentation-header")).toContainText(
      `第${presentation.position}提示 / 4`,
    );
    await expect(
      page.getByTestId("handling-panel").getByText(presentation.processing, { exact: true }),
    ).toBeVisible();
    const processingIconKind = presentation.processing === "クラウド" ? "cloud" : "local";
    const otherProcessingIconKind = processingIconKind === "cloud" ? "local" : "cloud";
    const handlingIcons = page.getByTestId("handling-panel").locator(".public-demo-handling-icon");
    await expect(handlingIcons).toHaveCount(3);
    const iconAppearances = await handlingIcons.evaluateAll((icons) =>
      icons.map((icon) => {
        const bounds = icon.getBoundingClientRect();
        const style = window.getComputedStyle(icon);
        return {
          childTags: Array.from(icon.children, (child) => child.tagName.toLowerCase()),
          color: style.color,
          fill: icon.getAttribute("fill"),
          height: Math.round(bounds.height),
          kind: icon.getAttribute("data-icon-kind"),
          stroke: icon.getAttribute("stroke"),
          strokeWidth: icon.getAttribute("stroke-width"),
          viewBox: icon.getAttribute("viewBox"),
          width: Math.round(bounds.width),
        };
      }),
    );
    expect(iconAppearances.map(({ kind }) => kind)).toEqual([
      processingIconKind,
      "storage",
      "audience",
    ]);
    expect(iconAppearances.map(({ childTags }) => childTags)).toEqual([
      ["path"],
      ["path"],
      ["path"],
    ]);
    expect([...new Set(iconAppearances.map(({ color }) => color))]).toHaveLength(1);
    expect(new Set(iconAppearances.map(({ fill }) => fill))).toEqual(new Set(["none"]));
    expect([...new Set(iconAppearances.map(({ height }) => height))]).toHaveLength(1);
    expect(new Set(iconAppearances.map(({ stroke }) => stroke))).toEqual(new Set(["currentColor"]));
    expect(new Set(iconAppearances.map(({ strokeWidth }) => strokeWidth))).toEqual(
      new Set(["2.4"]),
    );
    expect(new Set(iconAppearances.map(({ viewBox }) => viewBox))).toEqual(new Set(["0 0 64 64"]));
    expect([...new Set(iconAppearances.map(({ width }) => width))]).toHaveLength(1);
    expect(iconAppearances[0]?.width).toBeGreaterThanOrEqual(48);
    const processingIcon = page
      .getByTestId("handling-panel")
      .locator(`[data-icon-kind='${processingIconKind}']`);
    await expect(processingIcon).toBeVisible();
    await expect(processingIcon).toHaveAttribute("aria-hidden", "true");
    await expect(processingIcon).toHaveAttribute("focusable", "false");
    await expect(
      page.getByTestId("handling-panel").locator(`[data-icon-kind='${otherProcessingIconKind}']`),
    ).toHaveCount(0);
    const locationGeometry = await page
      .getByTestId("handling-panel")
      .locator(".public-demo-processing-location")
      .evaluate((row) => {
        const icon = row.querySelector<SVGSVGElement>(".public-demo-handling-icon");
        const value = row.querySelector<HTMLElement>("dd span");
        if (icon === null || value === null)
          throw new Error("processing location cue is incomplete");
        const rowBounds = row.getBoundingClientRect();
        const iconBounds = icon.getBoundingClientRect();
        const rowStyle = window.getComputedStyle(row);
        const valueStyle = window.getComputedStyle(value);
        return {
          iconColor: window.getComputedStyle(icon).color,
          iconHeight: Math.round(iconBounds.height),
          iconWidth: Math.round(iconBounds.width),
          rowBackground: rowStyle.backgroundColor,
          rowHeight: Math.round(rowBounds.height),
          rowPaddingBottom: rowStyle.paddingBottom,
          rowPaddingTop: rowStyle.paddingTop,
          rowWidth: Math.round(rowBounds.width),
          valueColor: valueStyle.color,
          valueFontSize: valueStyle.fontSize,
          valueFontWeight: valueStyle.fontWeight,
        };
      });
    if (processingIconKind === "cloud" && cloudLocationGeometry === null) {
      cloudLocationGeometry = locationGeometry;
    }
    if (processingIconKind === "local" && localLocationGeometry === null) {
      localLocationGeometry = locationGeometry;
    }
    if (presentation.position <= 2) {
      await resetScreenshotScroll(page);
      await page.screenshot({
        path: `artifacts/screenshots/public-demo-${processingIconKind}-${viewportName}.png`,
        fullPage: false,
      });
    } else {
      const pufferName = presentation.position === 3 ? "puffer" : "puffer-local";
      await resetScreenshotScroll(page);
      await page.screenshot({
        path: `artifacts/screenshots/public-demo-${pufferName}-${viewportName}.png`,
        fullPage: false,
      });
    }
    if (presentation.presentation === "label") {
      await expect(page.locator(".public-demo-label-result")).toContainText("72 / 100");
      await expect(page.locator(".public-demo-label-result")).toContainText("高ストレス");
      await expect(page.getByTestId("public-demo-puffer")).toHaveCount(0);
    } else {
      await expect(page.locator(".public-demo-puffer-result")).toContainText(
        "状態はフグ型デバイスに",
      );
      await expect(page.locator(".public-demo-puffer-result")).toContainText(
        "実機は接続・動作していません",
      );
      await expect(page.getByTestId("public-demo-puffer")).toBeVisible();
    }
    await expectSafeVisibleState(page);
  }

  await page.getByRole("button", { name: "次へ" }).click();
  expect(localLocationGeometry).toEqual(cloudLocationGeometry);
  await expect(page.getByTestId("public-demo-summary")).toBeVisible();
  await expect(page.getByTestId("public-demo-summary").locator("li")).toHaveCount(4);
  await expect(page.getByTestId("public-demo-summary")).toContainText(
    "研究への参加や回答の送信は行いません",
  );
  await expectSafeVisibleState(page);
  await resetScreenshotScroll(page);
  await page.screenshot({
    path: `artifacts/screenshots/public-demo-summary-${viewportName}.png`,
    fullPage: false,
  });
  await expect(page.locator("body")).not.toContainText(/\b(?:CLOUD|LOCAL)\b/iu);

  const csp = await page
    .locator("meta[http-equiv='Content-Security-Policy']")
    .getAttribute("content");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("form-action 'none'");
  expect(csp).not.toContain("frame-ancestors");
  expect(ignoredCspDirectives).toEqual([]);
  expect(network.activeRequests).toEqual([]);
  expect(network.webSockets).toEqual([]);
  expect(network.externalRequests).toEqual([]);
});

test("自動リハーサルが規定時間で4提示を再生し、通信や保存を行わない", async ({ page }) => {
  const network = monitorNetwork(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.clock.install();

  await page.getByRole("button", { name: "自動リハーサルを開始" }).click();
  const app = page.getByTestId("public-demo-app");
  const stage = page.getByRole("main", { name: "固定模擬データの表示確認" });
  const rightPanelHtml: string[] = [];

  await expect(app).toHaveAttribute("data-rehearsal-mode", "automatic");
  await expect(page.getByRole("button", { name: "前へ" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "次へ" })).toBeDisabled();

  for (let position = 1; position <= 4; position += 1) {
    await expect(stage).toHaveAttribute("data-rehearsal-position", String(position));
    await expect(stage).toHaveAttribute("data-rehearsal-phase", "handling");
    await page.clock.fastForward(8_000);
    await expect(stage).toHaveAttribute("data-rehearsal-phase", "processing");
    await expect(page.locator(".public-demo-rehearsal-spinner")).toHaveCount(0);
    await page.clock.fastForward(3_000);
    await expect(stage).toHaveAttribute("data-rehearsal-phase", "result");
    rightPanelHtml.push(await page.getByTestId("result-panel").innerHTML());

    if (position >= 3) {
      const puffer = page.getByTestId("public-demo-puffer");
      await expect(puffer).toHaveAttribute("data-puffer-motion", "inflating");
      await expect(puffer).toHaveAttribute("data-motion-duration-ms", "6000");
      await page.clock.fastForward(6_000);
      await expect(puffer).toHaveAttribute("data-puffer-motion", "holding");
      await page.clock.fastForward(9_000);
      await expect(stage).toHaveAttribute("data-rehearsal-phase", "reset");
      await expect(page.getByTestId("public-demo-puffer")).toHaveAttribute(
        "data-puffer-motion",
        "deflating",
      );
      await page.clock.fastForward(6_000);
      await expect(page.getByTestId("public-demo-puffer")).toHaveAttribute(
        "data-puffer-motion",
        "resting",
      );
      await page.clock.fastForward(1_000);
    } else {
      await page.clock.fastForward(15_000);
      await expect(stage).toHaveAttribute("data-rehearsal-phase", "reset");
      await page.clock.fastForward(7_000);
    }
  }

  expect(rightPanelHtml[0]).toBe(rightPanelHtml[1]);
  expect(rightPanelHtml[2]).toBe(rightPanelHtml[3]);
  await expect(app).toHaveAttribute("data-rehearsal-mode", "manual");
  await expect(page.getByTestId("public-demo-summary")).toBeVisible();
  await expectSafeVisibleState(page);
  expect(network.activeRequests).toEqual([]);
  expect(network.webSockets).toEqual([]);
  expect(network.externalRequests).toEqual([]);
});

test("画面幅に応じて二列または一列で、横にはみ出さず操作できる", async ({ page }) => {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("Public demo viewport is unavailable.");
  const narrow = viewport.width <= 640;

  await page.goto("/", { waitUntil: "networkidle" });
  const notice = page.locator(".public-demo-notice");
  await expect(notice).toBeVisible();
  await expect(notice.locator("strong, span")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "次へ" })).toBeVisible();
  await expectResponsiveViewportState(page);

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "次へ" })).toBeFocused();
  await page.keyboard.press("Enter");
  const panelBounds = await page.locator(".public-demo-panel").evaluateAll((panels) =>
    panels.map((panel) => {
      const bounds = panel.getBoundingClientRect();
      return { bottom: bounds.bottom, left: bounds.left, right: bounds.right, top: bounds.top };
    }),
  );
  expect(panelBounds).toHaveLength(2);
  if (narrow) {
    expect(panelBounds[1]?.top).toBeGreaterThanOrEqual((panelBounds[0]?.bottom ?? 0) - 1);
  } else {
    expect(panelBounds[1]?.left).toBeGreaterThanOrEqual((panelBounds[0]?.right ?? 0) - 1);
    expect(panelBounds[1]?.top).toBeCloseTo(panelBounds[0]?.top ?? Number.NaN, 1);
  }
  for (const bounds of panelBounds) {
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(viewport.width);
  }

  const dimensions = await viewportDimensions(page);
  if (narrow) {
    expect(dimensions.documentHeight).toBeGreaterThan(dimensions.viewportHeight);
  } else {
    expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
  }
  await expectResponsiveViewportState(page);

  const previous = page.getByRole("button", { name: "前へ" });
  await page.keyboard.press("Shift+Tab");
  await expect(previous).toBeFocused();
  const previousFocus = await previous.evaluate((button) => {
    const style = window.getComputedStyle(button);
    return {
      backgroundColor: style.backgroundColor,
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(previousFocus.outlineStyle).toBe("solid");
  expect(previousFocus.outlineWidth).toBeGreaterThanOrEqual(3);
  expect(
    contrastRatio(previousFocus.outlineColor, previousFocus.backgroundColor),
  ).toBeGreaterThanOrEqual(3);

  await page.keyboard.press("Tab");
  const nextButton = page.getByRole("button", { name: "次へ" });
  await expect(nextButton).toBeFocused();
  const nextFocus = await nextButton.evaluate((button) => {
    const style = window.getComputedStyle(button);
    const bounds = button.getBoundingClientRect();
    return {
      backgroundColor: style.backgroundColor,
      bottom: bounds.bottom,
      height: bounds.height,
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(nextFocus.height).toBeGreaterThanOrEqual(44);
  expect(nextFocus.bottom).toBeLessThanOrEqual(viewport.height);
  expect(nextFocus.outlineStyle).toBe("solid");
  expect(nextFocus.outlineWidth).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(nextFocus.outlineColor, nextFocus.backgroundColor)).toBeGreaterThanOrEqual(
    3,
  );
});

test("公開レビュー用の固定経路を実機なしで開き、同じブラウザの表示だけを同期する", async ({
  context,
  page,
}, testInfo) => {
  const operatorNetwork = monitorNetwork(page);
  await page.goto("/operator/index.html", { waitUntil: "networkidle" });

  await expect(page).toHaveTitle("公開レビュー進行画面");
  await expect(page.getByTestId("public-review-operator")).toBeVisible();
  await expect(page.getByRole("heading", { name: "公開レビュー進行画面" })).toBeVisible();
  await expect(page.getByText("同じブラウザ内だけで同期します")).toBeVisible();
  await expect(page.locator("form, input, textarea, select")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Googleフォーム");
  await expectResponsiveViewportState(page);

  const displayPage = await context.newPage();
  const displayNetwork = monitorNetwork(displayPage);
  await displayPage.goto("/display/demo/index.html", { waitUntil: "networkidle" });
  await expect(displayPage).toHaveTitle("参加者表示・公開模擬レビュー");
  await expect(displayPage.getByTestId("public-review-display")).toBeVisible();
  await expect(displayPage.locator("button, a, form, input, textarea, select")).toHaveCount(0);

  await page.getByRole("button", { name: "第1提示" }).click();
  await expect(displayPage.locator(".public-demo-presentation-header")).toContainText(
    "第1提示 / 4",
  );
  await expect(
    displayPage.getByTestId("handling-panel").getByText("クラウド", { exact: true }),
  ).toBeVisible();
  await expect(
    displayPage.getByTestId("handling-panel").locator("[data-icon-kind='cloud']"),
  ).toBeVisible();

  await displayPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

  await page.getByRole("button", { name: "第2提示" }).click();
  await expect.poll(() => displayPage.evaluate(() => window.scrollY)).toBe(0);
  await expect(displayPage.locator(".public-demo-presentation-header")).toContainText(
    "第2提示 / 4",
  );
  await expect(
    displayPage.getByTestId("handling-panel").getByText("この端末内", { exact: true }),
  ).toBeVisible();
  await expectResponsiveViewportState(displayPage);

  const viewportName = testInfo.project.name.replace("chromium-", "");
  await resetScreenshotScroll(page);
  await page.screenshot({
    path: `artifacts/screenshots/public-review-operator-${viewportName}.png`,
    fullPage: false,
  });
  await resetScreenshotScroll(displayPage);
  await displayPage.screenshot({
    path: `artifacts/screenshots/public-review-display-${viewportName}.png`,
    fullPage: false,
  });
  await displayPage.close();

  await page.goto("/device-test/index.html", { waitUntil: "networkidle" });
  await expect(page).toHaveTitle("模擬装置確認・公開レビュー");
  await expect(page.getByTestId("public-review-device")).toContainText(
    "実機やUSBシリアルには接続せず",
  );
  await expect(page.getByText("未接続", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "模擬装置を接続" }).click();
  await page.getByRole("button", { name: "膨張を模擬" }).click();
  await expect(page.getByText("膨張状態を模擬中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^停止$/u }).click();
  await expect(page.getByText("停止済み", { exact: true })).toBeVisible();
  await expectResponsiveViewportState(page);

  await page.goto("/healthz/index.html", { waitUntil: "networkidle" });
  await expect(page).toHaveTitle("公開レビュー版・稼働確認");
  await expect(page.getByTestId("public-review-health")).toContainText(
    "公開レビュー版は正常に配信されています",
  );
  await expectResponsiveViewportState(page);

  for (const network of [operatorNetwork, displayNetwork]) {
    expect(network.activeRequests).toEqual([]);
    expect(network.webSockets).toEqual([]);
    expect(network.externalRequests).toEqual([]);
  }
});
