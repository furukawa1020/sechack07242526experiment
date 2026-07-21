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
    await page.getByRole("button", { name: "次へ" }).click();
    await expect(page.locator("[data-scene='result']")).toBeVisible();
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
        if (icon === null || value === null) throw new Error("processing location cue is incomplete");
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
      await page.screenshot({
        path: `artifacts/screenshots/public-demo-${processingIconKind}-${viewportName}.png`,
        fullPage: false,
      });
    } else {
      const pufferName = presentation.position === 3 ? "puffer" : "puffer-local";
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
