import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { isApprovedGoogleFormsUrl } from "./preflight.js";

const DEFAULT_FORM_URL = "https://forms.gle/BeShY7cY5zMjunto9";
const EXPECTED_FORM_ID = "1FAIpQLSea5PhAbtkSS_Pg-xL-O7scpRddMn5ReoKzgAt7lSE7GTlA9Q";
const EXPECTED_STUDY_TITLE = "身体状態の外化デバイスがユーザの心理状態に及ぼす影響の評価";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const EVALUATION_QUESTION_COUNT = 11;
const EVALUATION_ROW_LABELS = Object.freeze(["第1提示", "第2提示", "第3提示", "第4提示"]);
const EVALUATION_SCALE_LABELS = Object.freeze([
  "1全くそう思わない",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7非常にそう思う",
]);
const SCREEN_PROTOCOL_COPY_PATTERNS = Object.freeze([
  /同じ固定模擬データを、?4つの方法で提示/gu,
  /表示される値は、?あなた自身を測定したものではありません/gu,
  /心拍(?:など|その他)の生体データを取得しません/gu,
  /画面上のフグ/gu,
  /アンケート回答は[^。！？]{0,80}Googleフォーム[^。！？]{0,80}(?:送信|保存)/gu,
]);

export interface PublicFormAuditFinding {
  readonly id: string;
  readonly status: "pass" | "warning" | "fail";
  readonly detail: string;
}

export interface PublicFormAuditReport {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly title: string;
  /** SHA-256 of the stable FB_PUBLIC_LOAD_DATA_ payload, not the dynamic HTML shell. */
  readonly contentSha256: string;
  readonly findings: readonly PublicFormAuditFinding[];
}

export interface PublicFormAuditArguments {
  readonly help: boolean;
  readonly url: string;
}

export interface RunPublicFormAuditOptions {
  readonly args?: readonly string[];
  readonly fetchImplementation?: typeof fetch;
  readonly writeLine?: (line: string) => void;
}

function usage(): readonly string[] {
  return Object.freeze([
    "Usage: npm run audit:form -- [--url <Google Forms URL>]",
    "",
    "The command performs a read-only GET. It never submits a response or edits the form.",
  ]);
}

export function parsePublicFormAuditArguments(
  args: readonly string[],
): PublicFormAuditArguments {
  let help = false;
  let url = DEFAULT_FORM_URL;
  let urlSpecified = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--url") {
      if (urlSpecified) throw new Error("--url may only be specified once.");
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error("--url requires a value.");
      }
      url = value;
      urlSpecified = true;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--url=")) {
      if (urlSpecified) throw new Error("--url may only be specified once.");
      url = argument.slice("--url=".length);
      if (url.length === 0) throw new Error("--url requires a value.");
      urlSpecified = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument ?? "(missing)"}`);
  }
  if (!isApprovedGoogleFormsUrl(url)) {
    throw new Error("--url must be an approved Google Forms HTTPS URL.");
  }
  return Object.freeze({ help, url });
}

/** Decode only inert JavaScript string escapes; never evaluate form payload code. */
export function decodePublicFormPayload(source: string): string {
  return source
    .replace(/\\u([0-9a-f]{4})/giu, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\n/gu, " ")
    .replace(/\\r/gu, " ")
    .replace(/\\t/gu, " ")
    .replace(/\\"/gu, '"');
}

function occurrences(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function arrayValue(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parsePublicFormItems(publicPayload: string | null): readonly (readonly unknown[])[] | null {
  if (publicPayload === null) return null;
  try {
    const root = arrayValue(JSON.parse(publicPayload) as unknown);
    const form = arrayValue(root?.[1]);
    const rawItems = arrayValue(form?.[1]);
    if (rawItems === null || !rawItems.every((item) => Array.isArray(item))) return null;
    return rawItems as readonly (readonly unknown[])[];
  } catch {
    return null;
  }
}

function expectedCanonicalFormUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "docs.google.com"
      && url.pathname === `/forms/d/e/${EXPECTED_FORM_ID}/viewform`;
  } catch {
    return false;
  }
}

function entryLabel(entry: readonly unknown[]): string | null {
  return stringValue(arrayValue(entry[3])?.[0]);
}

function entryScale(entry: readonly unknown[]): readonly (string | null)[] | null {
  const rawChoices = arrayValue(entry[1]);
  if (rawChoices === null) return null;
  return rawChoices.map((choice) => stringValue(arrayValue(choice)?.[0]));
}

function evaluationQuestionStructureIsValid(item: readonly unknown[]): boolean {
  if (item[3] !== 7 || stringValue(item[1]) === null) return false;
  const entries = arrayValue(item[4]);
  if (entries === null || entries.length !== EVALUATION_ROW_LABELS.length) return false;
  return entries.every((rawEntry, index) => {
    const entry = arrayValue(rawEntry);
    if (entry === null || entry[2] !== 0) return false;
    const scale = entryScale(entry);
    return entryLabel(entry) === EVALUATION_ROW_LABELS[index]
      && scale !== null
      && scale.length === EVALUATION_SCALE_LABELS.length
      && scale.every((label, scaleIndex) => label === EVALUATION_SCALE_LABELS[scaleIndex]);
  });
}

function immediateAnswerInstructions(source: string): number {
  return [...source.matchAll(/各提示の直後[^。！？]{0,80}/gu)].filter((match) => {
    const context = match[0];
    return !(
      /各提示の直後ではなく/gu.test(context)
      || /各提示の直後(?:に|には|では)?回答(?:せず|しない|しません|する必要はありません)/gu
        .test(context)
    );
  }).length;
}

function afterAllFourInstructions(source: string): number {
  const patterns = [
    /4種類すべての提示を体験した後/gu,
    /4つの提示をすべて体験した後/gu,
    /4つの提示をすべて見終え[^。！？]{0,60}後/gu,
    /4つの提示がすべて終了してから[^。！？]{0,60}(?:回答|フォームへ戻)/gu,
    /回答は[^。！？]{0,60}4つの提示がすべて終了してから/gu,
    /4提示(?:を)?すべて(?:体験|見終え|確認)[^。！？]{0,60}(?:後|してから)/gu,
  ] as const;
  return patterns.reduce((total, pattern) => total + occurrences(source, pattern), 0);
}

function finding(
  id: string,
  status: PublicFormAuditFinding["status"],
  detail: string,
): PublicFormAuditFinding {
  return Object.freeze({ id, status, detail });
}

export function inspectPublicFormPayload(
  requestedUrl: string,
  finalUrl: string,
  source: string,
): PublicFormAuditReport {
  const decoded = decodePublicFormPayload(source);
  const publicPayload = /FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);\s*<\/script>/su.exec(source)?.[1] ?? null;
  const formItems = parsePublicFormItems(publicPayload);
  const contentSha256 = publicPayload === null
    ? ""
    : createHash("sha256").update(publicPayload, "utf8").digest("hex");
  const title = /<title[^>]*>([^<]*)<\/title>/iu.exec(decoded)?.[1]?.trim() ?? "(title not found)";
  const internalMappings = [
    /A[：:=＝]\s*クラウド/gu,
    /B[：:=＝]\s*(?:ローカル|端末内)/gu,
    /C[：:=＝]\s*(?:ローカル|端末内)/gu,
    /D[：:=＝]\s*クラウド/gu,
  ].reduce((total, pattern) => total + occurrences(decoded, pattern), 0);
  const legacyThree = occurrences(decoded, /3種類/gu);
  const currentFour = occurrences(decoded, /4種類|4つの提示|4提示/gu);
  const immediateAnswer = immediateAnswerInstructions(decoded);
  const afterAllFour = afterAllFourInstructions(decoded);
  const screenProtocolCopyMatches = SCREEN_PROTOCOL_COPY_PATTERNS.map(
    (pattern) => occurrences(decoded, pattern),
  );
  const screenProtocolCopyComplete = screenProtocolCopyMatches.every((count) => count > 0);
  const evaluationQuestions = formItems?.filter((item) => item[3] === 7) ?? [];
  const evaluationStructureValid = evaluationQuestions.length === EVALUATION_QUESTION_COUNT
    && evaluationQuestions.every(evaluationQuestionStructureIsValid);
  const untitledInputs = formItems?.filter((item) => {
    const type = item[3];
    return typeof type === "number" && ![6, 8].includes(type) && stringValue(item[1]) === null;
  }).length ?? 0;
  const fileUploads = formItems?.filter((item) => item[3] === 13).length ?? 0;

  return Object.freeze({
    requestedUrl,
    finalUrl,
    title,
    contentSha256,
    findings: Object.freeze([
      finding(
        "canonical-public-payload",
        formItems === null ? "fail" : "pass",
        formItems === null
          ? "安定した公開内容payloadを抽出・解析できませんでした。"
          : `公開内容payloadのSHA-256は${contentSha256}です。`,
      ),
      finding(
        "canonical-form",
        expectedCanonicalFormUrl(finalUrl) ? "pass" : "fail",
        expectedCanonicalFormUrl(finalUrl)
          ? "指定された研究フォームIDへ到達しました。"
          : "指定された研究フォームIDへ到達していません。",
      ),
      finding(
        "study-title",
        title.startsWith(EXPECTED_STUDY_TITLE) ? "pass" : "fail",
        title.startsWith(EXPECTED_STUDY_TITLE)
          ? "研究タイトルを確認しました。"
          : "研究タイトルが想定値と一致しません。",
      ),
      finding(
        "internal-condition-mapping",
        internalMappings === 0 ? "pass" : "fail",
        internalMappings === 0
          ? "公開payloadにA〜Dの固定対応は見つかりませんでした。"
          : `公開payloadにA〜Dの固定対応を${String(internalMappings)}件検出しました。`,
      ),
      finding(
        "legacy-three-presentations",
        legacyThree === 0 ? "pass" : "fail",
        legacyThree === 0
          ? "3種類という旧説明は見つかりませんでした。"
          : `3種類という旧説明を${String(legacyThree)}件検出しました。`,
      ),
      finding(
        "four-presentations",
        currentFour > 0 ? "pass" : "fail",
        currentFour > 0
          ? `4提示という現行説明を${String(currentFour)}件確認しました。`
          : "4提示という現行説明を確認できませんでした。",
      ),
      finding(
        "screen-protocol-copy",
        screenProtocolCopyComplete ? "pass" : "fail",
        screenProtocolCopyComplete
          ? "固定模擬データ、本人非測定、生体データ非取得、画面上のフグ、Googleフォーム送信先の説明を確認しました。"
          : `screen版の必須説明5点の出現数は${screenProtocolCopyMatches.join("/")}です。`,
      ),
      finding(
        "answer-timing",
        immediateAnswer === 0 && afterAllFour > 0 ? "pass" : "fail",
        immediateAnswer === 0 && afterAllFour > 0
          ? "4提示後にまとめて回答する説明だけを確認しました。"
          : `各提示直後に回答させる旧説明=${String(immediateAnswer)}件、4提示後の説明=${String(afterAllFour)}件です。`,
      ),
      finding(
        "eleven-questions",
        evaluationQuestions.length === EVALUATION_QUESTION_COUNT ? "pass" : "fail",
        evaluationQuestions.length === EVALUATION_QUESTION_COUNT
          ? "公開フォーム構造に11件の評価質問を確認しました。"
          : `公開フォーム構造の評価質問は${String(evaluationQuestions.length)}件です。`,
      ),
      finding(
        "evaluation-structure",
        evaluationStructureValid ? "pass" : "fail",
        evaluationStructureValid
          ? "11評価質問は第1〜第4提示、7件法、任意回答で統一されています。"
          : "11評価質問の提示行、7件法、任意回答設定が承認候補構造と一致しません。",
      ),
      finding(
        "untitled-inputs",
        untitledInputs === 0 ? "pass" : "fail",
        untitledInputs === 0
          ? "無題の回答入力項目はありません。"
          : `無題の回答入力項目を${String(untitledInputs)}件検出しました。`,
      ),
      finding(
        "file-uploads",
        fileUploads === 0 && !/ファイル(?:を)?アップロード/gu.test(decoded) ? "pass" : "fail",
        fileUploads === 0 && !/ファイル(?:を)?アップロード/gu.test(decoded)
          ? "ファイルアップロード項目はありません。"
          : "ファイルアップロード項目を検出しました。",
      ),
      finding(
        "administrator-only-settings",
        "warning",
        "メール収集、ログイン要求、分岐、必須設定は管理画面と未ログイン実回答経路で二名確認が必要です。",
      ),
    ]),
  });
}

export async function fetchPublicFormAudit(
  url: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<PublicFormAuditReport> {
  const response = await fetchImplementation(url, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "follow",
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: { Accept: "text/html" },
  });
  if (!response.ok) throw new Error(`Google Forms returned HTTP ${String(response.status)}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error(`Google Forms returned an unexpected content type: ${contentType || "(missing)"}.`);
  }
  const source = await response.text();
  if (Buffer.byteLength(source, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Google Forms response exceeded the 5 MiB audit limit.");
  }
  return inspectPublicFormPayload(url, response.url || url, source);
}

export function renderPublicFormAudit(
  report: PublicFormAuditReport,
  writeLine: (line: string) => void,
): void {
  writeLine("Googleフォーム公開内容・読取り専用監査");
  writeLine(`対象URL: ${report.requestedUrl}`);
  writeLine(`最終URL: ${report.finalUrl}`);
  writeLine(`タイトル: ${report.title}`);
  writeLine(`公開内容SHA-256: ${report.contentSha256 || "(抽出失敗)"}`);
  writeLine("");
  for (const item of report.findings) {
    const marker = item.status === "pass" ? "PASS" : item.status === "warning" ? "WARN" : "FAIL";
    writeLine(`[${marker}] ${item.id}: ${item.detail}`);
  }
  const failures = report.findings.filter((item) => item.status === "fail").length;
  writeLine("");
  writeLine(
    failures === 0
      ? "結果: 自動監査PASS（人手による二名照合は別途必要です）"
      : `結果: NO-GO (${String(failures)}件の公開内容ブロッカー)`,
  );
}

export async function runPublicFormAudit(
  options: RunPublicFormAuditOptions = {},
): Promise<number> {
  const writeLine = options.writeLine ?? console.info;
  try {
    const parsed = parsePublicFormAuditArguments(options.args ?? process.argv.slice(2));
    if (parsed.help) {
      for (const line of usage()) writeLine(line);
      return 0;
    }
    const report = await fetchPublicFormAudit(
      parsed.url,
      options.fetchImplementation ?? fetch,
    );
    renderPublicFormAudit(report, writeLine);
    return report.findings.some((item) => item.status === "fail") ? 1 : 0;
  } catch (error) {
    writeLine(`結果: 監査失敗 (${error instanceof Error ? error.message : "unknown error"})`);
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  process.exitCode = await runPublicFormAudit();
}
