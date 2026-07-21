import { pathToFileURL } from "node:url";

import { isApprovedGoogleFormsUrl } from "./preflight.js";

const DEFAULT_FORM_URL = "https://forms.gle/BeShY7cY5zMjunto9";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface PublicFormAuditFinding {
  readonly id: string;
  readonly status: "pass" | "warning" | "fail";
  readonly detail: string;
}

export interface PublicFormAuditReport {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly title: string;
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
  const title = /<title[^>]*>([^<]*)<\/title>/iu.exec(decoded)?.[1]?.trim() ?? "(title not found)";
  const internalMappings = [
    /A[：:]\s*クラウド/gu,
    /B[：:]\s*(?:ローカル|端末内)/gu,
    /C[：:]\s*(?:ローカル|端末内)/gu,
    /D[：:]\s*クラウド/gu,
  ].reduce((total, pattern) => total + occurrences(decoded, pattern), 0);
  const legacyThree = occurrences(decoded, /3種類/gu);
  const currentFour = occurrences(decoded, /4種類/gu);
  const immediateAnswer = occurrences(decoded, /各提示の直後/gu);
  const afterAllFour = occurrences(
    decoded,
    /4種類すべての提示を体験した後|4つの提示をすべて体験した後/gu,
  );
  const elevenQuestions = occurrences(decoded, /全11問|11項目の質問|11問/gu);

  return Object.freeze({
    requestedUrl,
    finalUrl,
    title,
    findings: Object.freeze([
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
          ? `4種類という現行説明を${String(currentFour)}件確認しました。`
          : "4種類という現行説明を確認できませんでした。",
      ),
      finding(
        "answer-timing",
        immediateAnswer === 0 && afterAllFour > 0 ? "pass" : "fail",
        immediateAnswer === 0 && afterAllFour > 0
          ? "4提示後にまとめて回答する説明だけを確認しました。"
          : `旧説明「各提示の直後」=${String(immediateAnswer)}件、4提示後の説明=${String(afterAllFour)}件です。`,
      ),
      finding(
        "eleven-questions",
        elevenQuestions > 0 ? "pass" : "fail",
        elevenQuestions > 0
          ? `11問／11項目の説明を${String(elevenQuestions)}件確認しました。`
          : "11問／11項目の説明を確認できませんでした。",
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
