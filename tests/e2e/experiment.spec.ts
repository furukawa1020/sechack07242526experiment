import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type JsonRecord = Record<string, unknown>;

const CONDITIONS = {
  A: { processing: "cloud", presentation: "label" },
  B: { processing: "local", presentation: "label" },
  C: { processing: "local", presentation: "puffer" },
  D: { processing: "cloud", presentation: "puffer" },
} as const;

const ORDERS = ["ABDC", "BCAD", "CDBA", "DACB"] as const;

function asRecord(value: unknown): JsonRecord {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as JsonRecord;
}

async function ensureDeviceReady(request: APIRequestContext): Promise<void> {
  const current = await request.get("/api/device/status");
  expect(current.ok()).toBeTruthy();
  const statusBody = asRecord(await current.json());
  const status = asRecord(statusBody.status);
  if (status.state === "disconnected") {
    const connected = await request.post("/api/device/connect");
    expect(connected.ok()).toBeTruthy();
  }
}

async function createSession(
  request: APIRequestContext,
  researchId: string,
  orderCode: (typeof ORDERS)[number],
): Promise<{ sessionId: string; displayUrl: string }> {
  const response = await request.post("/api/sessions", {
    data: { researchId, consentConfirmed: true, orderCode },
  });
  expect(response.status()).toBe(201);
  const body = asRecord(await response.json());
  const snapshot = asRecord(body.snapshot);
  expect(snapshot.orderCode).toBe(orderCode);
  return {
    sessionId: String(snapshot.id),
    displayUrl: String(body.displayUrl),
  };
}

async function operatorSnapshot(request: APIRequestContext, sessionId: string): Promise<JsonRecord> {
  const response = await request.get(`/api/sessions/${encodeURIComponent(sessionId)}`);
  expect(response.ok()).toBeTruthy();
  return asRecord(asRecord(await response.json()).snapshot);
}

async function mockCommandHistory(request: APIRequestContext): Promise<readonly string[]> {
  const response = await request.get("/api/test/mock-device/commands");
  expect(response.ok()).toBeTruthy();
  const commands = asRecord(await response.json()).commands;
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string")) {
    throw new TypeError("Mock device command history must be a string array.");
  }
  return commands;
}

async function action(
  request: APIRequestContext,
  sessionId: string,
  name: "prepare" | "start" | "resume" | "abort" | "emergency-stop" | "confirm-form-complete",
): Promise<JsonRecord> {
  const response = await request.post(
    `/api/sessions/${encodeURIComponent(sessionId)}/${name}`,
  );
  expect(response.ok()).toBeTruthy();
  return asRecord(asRecord(await response.json()).snapshot);
}

async function openReadyDisplay(page: Page, displayUrl: string, request: APIRequestContext, sessionId: string): Promise<void> {
  await page.goto(displayUrl);
  await expect(page.getByTestId("participant-app")).toBeVisible();
  await expect.poll(async () => (await operatorSnapshot(request, sessionId)).displayConnected).toBe(true);
}

function monitorExternalRequests(page: Page): string[] {
  const external: string[] = [];
  page.on("request", (webRequest) => {
    const url = new URL(webRequest.url());
    if (
      ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost"
    ) {
      external.push(webRequest.url());
    }
  });
  return external;
}

test("4つの固定提示順をMockDeviceで完走し、参加者へ内部コードを公開しない", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const externalRequests = monitorExternalRequests(page);
  await ensureDeviceReady(request);

  for (const [index, orderCode] of ORDERS.entries()) {
    const researchId = `TEST-8${index.toString().padStart(2, "0")}`;
    const { sessionId, displayUrl } = await createSession(request, researchId, orderCode);
    await openReadyDisplay(page, displayUrl, request, sessionId);
    await action(request, sessionId, "prepare");
    await expect(page.getByRole("heading", { name: "同じ固定模擬データを、4つの方法で提示します" })).toBeVisible();
    await action(request, sessionId, "start");

    await expect(page.getByRole("heading", { name: "4つの提示は終了しました" })).toBeVisible({
      timeout: 15_000,
    });
    const snapshot = await operatorSnapshot(request, sessionId);
    expect(snapshot.phase).toBe("summary");
    expect(snapshot.fixedState).toEqual({ score: 72, label: "高ストレス", pufferLevel: 0.6 });

    const summary = asRecord(await (await request.get(`/api/display/${encodeURIComponent(String(bodyTokenFromUrl(displayUrl)))}`)).json());
    const publicSnapshot = asRecord(summary.snapshot);
    expect(publicSnapshot.rehearsal).toBe(true);
    expect(publicSnapshot.fixedState).toBeNull();
    expect(JSON.stringify(publicSnapshot)).not.toContain("pufferLevel");
    expect(publicSnapshot.formUrl).toBeNull();
    await expect(
      page.getByText("研究参加用ではありません・回答送信なし・実機なし"),
    ).toBeVisible();
    const presentations = publicSnapshot.summary as JsonRecord[];
    expect(presentations).toHaveLength(4);
    expect(
      presentations.map(({ processing, presentation }) => ({ processing, presentation })),
    ).toEqual(
      [...orderCode].map((code) => CONDITIONS[code as keyof typeof CONDITIONS]),
    );

    const participantText = await page.locator("body").innerText();
    expect(participantText).not.toMatch(/(?:^|\s)[ABCD](?=\s|$)/m);
    expect(participantText).toContain("この表示は医療上の診断ではありません。");
    await action(request, sessionId, "confirm-form-complete");
    await expect(
      page.getByRole("heading", { name: "模擬リハーサルを終了しました" }),
    ).toBeVisible();
  }

  expect(externalRequests).toEqual([]);
});

function bodyTokenFromUrl(displayUrl: string): string {
  const path = new URL(displayUrl, "http://127.0.0.1:4173").pathname;
  return decodeURIComponent(path.slice("/display/".length));
}

test("重複研究用IDを拒否する", async ({ page, request }) => {
  await ensureDeviceReady(request);
  const created = await createSession(request, "TEST-890", "ABDC");
  await openReadyDisplay(page, created.displayUrl, request, created.sessionId);
  await action(request, created.sessionId, "abort");

  const duplicate = await request.post("/api/sessions", {
    data: { researchId: "TEST-890", consentConfirmed: true, orderCode: "ABDC" },
  });
  expect(duplicate.status()).toBe(409);
  expect(asRecord(await duplicate.json()).code).toBe("DUPLICATE_RESEARCH_ID");
});

test("途中リロード後は明示的な復旧確認まで進行しない", async ({ page, request }) => {
  await ensureDeviceReady(request);
  const created = await createSession(request, "TEST-891", "BCAD");
  await openReadyDisplay(page, created.displayUrl, request, created.sessionId);
  await action(request, created.sessionId, "prepare");
  await action(request, created.sessionId, "start");
  await expect(page.getByTestId("participant-app")).toHaveAttribute("data-phase", "handling");
  await page.reload();

  await expect.poll(async () => (await operatorSnapshot(request, created.sessionId)).recoveryRequired).toBe(true);
  const pausedPhase = (await operatorSnapshot(request, created.sessionId)).phase;
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect((await operatorSnapshot(request, created.sessionId)).phase).toBe(pausedPhase);

  await action(request, created.sessionId, "resume");
  await expect(page.getByRole("heading", { name: "4つの提示は終了しました" })).toBeVisible({
    timeout: 15_000,
  });
  await action(request, created.sessionId, "confirm-form-complete");
});

test("画面フグのresult中の実リロードはSTOP・収縮後にerrorとなり再開できない", async ({ page, request }) => {
  await ensureDeviceReady(request);
  const created = await createSession(request, "TEST-892", "CDBA");
  await openReadyDisplay(page, created.displayUrl, request, created.sessionId);
  await action(request, created.sessionId, "prepare");
  await action(request, created.sessionId, "start");
  await expect(page.getByTestId("participant-app")).toHaveAttribute("data-phase", "result", {
    timeout: 5_000,
  });
  const commandBaseline = (await mockCommandHistory(request)).length;
  await page.reload();

  await expect.poll(async () => (await operatorSnapshot(request, created.sessionId)).phase).toBe("error");
  const failed = await operatorSnapshot(request, created.sessionId);
  expect(failed).toMatchObject({
    phase: "error",
    errorCode: "DISPLAY_LOST_DURING_STIMULUS",
    recoveryRequired: false,
  });
  const safetyCommands = (await mockCommandHistory(request)).slice(commandBaseline);
  expect(safetyCommands).toContain("stop");
  expect(safetyCommands).toContain("deflate");
  expect(safetyCommands.indexOf("stop")).toBeLessThan(safetyCommands.indexOf("deflate"));
  await expect(page.getByRole("heading", { name: "実験を一時停止しています" })).toBeVisible();
  await expect(page.getByTestId("screen-puffer-visual")).toHaveCount(0);

  const resume = await request.post(`/api/sessions/${encodeURIComponent(created.sessionId)}/resume`);
  expect(resume.status()).toBe(409);
  expect(asRecord(await resume.json()).code).toBe("RECOVERY_NOT_REQUIRED");
  await action(request, created.sessionId, "abort");
});

test("画面フグのreset中の実リロードもSTOP・収縮後にerrorとなり再開できない", async ({ page, request }) => {
  await ensureDeviceReady(request);
  const created = await createSession(request, "TEST-896", "CDBA");
  await openReadyDisplay(page, created.displayUrl, request, created.sessionId);
  await action(request, created.sessionId, "prepare");
  await action(request, created.sessionId, "start");
  await expect(page.getByTestId("participant-app")).toHaveAttribute("data-phase", "reset", {
    timeout: 5_000,
  });
  const commandBaseline = (await mockCommandHistory(request)).length;
  await page.reload();

  await expect.poll(async () => (await operatorSnapshot(request, created.sessionId)).phase).toBe("error");
  const failed = await operatorSnapshot(request, created.sessionId);
  expect(failed).toMatchObject({
    phase: "error",
    errorCode: "DISPLAY_LOST_DURING_STIMULUS",
    recoveryRequired: false,
  });
  const safetyCommands = (await mockCommandHistory(request)).slice(commandBaseline);
  expect(safetyCommands).toContain("stop");
  expect(safetyCommands).toContain("deflate");
  expect(safetyCommands.indexOf("stop")).toBeLessThan(safetyCommands.indexOf("deflate"));
  await expect(page.getByRole("heading", { name: "実験を一時停止しています" })).toBeVisible();
  await expect(page.getByTestId("screen-puffer-visual")).toHaveCount(0);

  const resume = await request.post(`/api/sessions/${encodeURIComponent(created.sessionId)}/resume`);
  expect(resume.status()).toBe(409);
  expect(asRecord(await resume.json()).code).toBe("RECOVERY_NOT_REQUIRED");
  await action(request, created.sessionId, "abort");
});

test("結果提示中のMock装置切断ではSTOP・収縮を試行してセッションをerrorへ移す", async ({
  page,
  request,
}) => {
  await ensureDeviceReady(request);
  const created = await createSession(request, "TEST-895", "CDBA");
  await openReadyDisplay(page, created.displayUrl, request, created.sessionId);
  await action(request, created.sessionId, "prepare");

  const historyBeforeInjectionResponse = await request.get("/api/test/mock-device/commands");
  expect(historyBeforeInjectionResponse.ok()).toBeTruthy();
  const historyBeforeInjection = asRecord(await historyBeforeInjectionResponse.json()).commands;
  if (!Array.isArray(historyBeforeInjection)) {
    throw new TypeError("Mock device command history must be an array.");
  }
  const commandBaseline = historyBeforeInjection.length;

  const injected = await request.post("/api/test/mock-device/disconnect", {
    data: { command: "inflate" },
  });
  expect(injected.status()).toBe(202);
  await action(request, created.sessionId, "start");

  await expect(page.getByRole("heading", { name: "実験を一時停止しています" })).toBeVisible({
    timeout: 5_000,
  });
  await expect.poll(async () => (await operatorSnapshot(request, created.sessionId)).phase)
    .toBe("error");
  const snapshot = await operatorSnapshot(request, created.sessionId);
  expect(snapshot.errorCode).toBe("DEVICE_DISCONNECTED");
  expect(snapshot.deviceStatus).toBe("disconnected");

  const historyResponse = await request.get("/api/test/mock-device/commands");
  expect(historyResponse.ok()).toBeTruthy();
  const commands = asRecord(await historyResponse.json()).commands;
  if (!Array.isArray(commands)) {
    throw new TypeError("Mock device command history must be an array.");
  }
  const commandsAfterInjection = commands.slice(commandBaseline);
  expect(commandsAfterInjection).toEqual(expect.arrayContaining(["inflate", "stop", "deflate"]));
  const inflateIndex = commandsAfterInjection.indexOf("inflate");
  const stopIndex = commandsAfterInjection.indexOf("stop", inflateIndex + 1);
  const deflateIndex = commandsAfterInjection.indexOf("deflate", stopIndex + 1);
  expect(stopIndex).toBeGreaterThan(inflateIndex);
  expect(deflateIndex).toBeGreaterThan(stopIndex);

  const csv = await request.get("/api/exports/sessions.csv");
  expect(csv.ok()).toBeTruthy();
  expect(await csv.text()).toContain("DEVICE_DISCONNECTED");
  await action(request, created.sessionId, "abort");
});

test("緊急停止はセッションを再開不能な中断状態へ移す", async ({ page, request }) => {
  await ensureDeviceReady(request);
  const created = await createSession(request, "TEST-893", "DACB");
  await openReadyDisplay(page, created.displayUrl, request, created.sessionId);
  await action(request, created.sessionId, "prepare");
  await action(request, created.sessionId, "start");
  const stopped = await action(request, created.sessionId, "emergency-stop");
  expect(stopped.phase).toBe("aborted");
  expect(stopped.errorCode).toBe("EMERGENCY_STOP");
  await expect(page.getByRole("heading", { name: "実験を中止しました" })).toBeVisible();

  const resume = await request.post(`/api/sessions/${encodeURIComponent(created.sessionId)}/resume`);
  expect(resume.status()).toBe(409);
});

test("スタッフ画面の緊急ショートカットは進行中でも直ちに停止する", async ({ browser, page, request }) => {
  await ensureDeviceReady(request);
  const created = await createSession(request, "TEST-894", "CDBA");
  const displayContext = await browser.newContext();
  const display = await displayContext.newPage();
  await openReadyDisplay(display, created.displayUrl, request, created.sessionId);
  await page.goto("/operator");
  await expect(page.getByRole("button", { name: /緊急停止/u })).toBeVisible();
  await action(request, created.sessionId, "prepare");
  await action(request, created.sessionId, "start");

  await page.keyboard.press("Control+Alt+Shift+S");
  await expect.poll(async () => (await operatorSnapshot(request, created.sessionId)).phase).toBe("aborted");
  expect((await operatorSnapshot(request, created.sessionId)).errorCode).toBe("EMERGENCY_STOP");
  await expect(page.getByText("緊急停止を送信しました。参加者画面で刺激の停止を確認してください。")).toBeVisible();
  await displayContext.close();
});
