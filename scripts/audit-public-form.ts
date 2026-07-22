import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { SCREEN_PRODUCTION_RESEARCH_ID_PATTERN } from "../src/shared/production-policy.js";

const DEFAULT_FORM_URL = "https://forms.gle/BeShY7cY5zMjunto9";
const EXPECTED_FORM_ID = "1FAIpQLSea5PhAbtkSS_Pg-xL-O7scpRddMn5ReoKzgAt7lSE7GTlA9Q";
const EXPECTED_STUDY_TITLE = "身体状態の外化デバイスがユーザの心理状態に及ぼす影響の評価";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const EVALUATION_QUESTION_COUNT = 11;
const EXPECTED_RESPONSE_ITEM_COUNT = EVALUATION_QUESTION_COUNT + 1;
const RESEARCH_ID_LABEL = "研究用ID";
const SHORT_ANSWER_ITEM_TYPE = 0;
const PARAGRAPH_ANSWER_ITEM_TYPE = 1;
const REQUIRED_ENTRY_FLAG = 1;
const REGULAR_EXPRESSION_VALIDATION_TYPE = 4;
const REGULAR_EXPRESSION_MATCHES_OPERATOR = 301;
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
  /この実験用Webアプリから、固定模擬身体データを外部へ送信・保存することはありません。/gu,
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
  if (!isApprovedPublicFormAuditUrl(url)) {
    throw new Error("--url must be an approved Google Forms HTTPS URL.");
  }
  return Object.freeze({ help, url });
}

function hasApprovedPublicFormQuery(url: URL): boolean {
  return url.hash === ""
    && (url.search === "" || url.search === "?usp=send_form");
}

/** The audit never accepts prefill parameters, response values, or unknown query flags. */
export function isApprovedPublicFormAuditUrl(value: string): boolean {
  if (value.length === 0) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || !hasApprovedPublicFormQuery(url)
    ) {
      return false;
    }
    if (url.hostname === "forms.gle") {
      return /^\/[A-Za-z0-9_-]+$/u.test(url.pathname);
    }
    return url.hostname === "docs.google.com"
      && /^\/forms\/d\/(?:e\/)?[A-Za-z0-9_-]+\/viewform$/u.test(url.pathname);
  } catch {
    return false;
  }
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

function itemType(item: readonly unknown[]): number | null {
  return typeof item[3] === "number" ? item[3] : null;
}

function isResponseItem(item: readonly unknown[]): boolean {
  const type = itemType(item);
  return type !== null && ![6, 8].includes(type);
}

function normalizedLabel(value: string): string {
  return value.normalize("NFKC").trim();
}

function isResearchIdLikeLabel(value: string): boolean {
  return normalizedLabel(value).replace(/\s/gu, "").toLocaleLowerCase("en-US")
    .includes(RESEARCH_ID_LABEL.toLocaleLowerCase("en-US"));
}

function itemEntries(item: readonly unknown[]): readonly (readonly unknown[])[] | null {
  const entries = arrayValue(item[4]);
  if (entries === null || !entries.every((entry) => Array.isArray(entry))) return null;
  return entries as readonly (readonly unknown[])[];
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const nested of value) collectStrings(nested, output);
}

function itemStrings(item: readonly unknown[]): readonly string[] {
  const values: string[] = [];
  collectStrings(item, values);
  return values;
}

function normalizedVisibleText(value: string): string {
  return value
    .replace(/<[^>]*>/gu, " ")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function visibleSentences(item: readonly unknown[]): readonly string[] {
  return normalizedVisibleText(itemStrings(item).join(" "))
    .split(/[。！？\n]+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const SEQUENCE_TERM_PATTERN = /(?:提示(?:の)?(?:順|順序|順番)(?:の)?(?:コード|番号)?|提示コード|順序(?:コード|番号)?|条件(?:コード|番号)|内部(?:コード|番号)|割付(?:コード|番号)|オーダー(?:コード|番号)?)/iu;
const INPUT_ACTION_PATTERN = /(?:入力|記入|回答|選択|送信|使用|伝え)/u;

function explicitlyNegatesSequenceInput(value: string): boolean {
  return /(?:提示(?:の)?(?:順|順序|順番)(?:の)?(?:コード|番号)?|提示コード|順序(?:コード|番号)?|条件(?:コード|番号)|内部(?:コード|番号)|割付(?:コード|番号)|オーダー(?:コード|番号)?)[^。！？]{0,60}(?:入力|記入|回答|選択|送信|使用)(?:は|を)?(?:しない|しません|せず|不要|する必要はありません|することはありません|求めません|させません|させることはありません)/iu.test(value)
    || /(?:入力|記入|回答|選択|送信|使用)(?:は|を)?(?:しない|しません|せず|不要|する必要はありません|することはありません|求めません|させません|させることはありません)[^。！？]{0,60}(?:提示(?:の)?(?:順|順序|順番)(?:の)?(?:コード|番号)?|提示コード|順序(?:コード|番号)?|条件(?:コード|番号)|内部(?:コード|番号)|割付(?:コード|番号)|オーダー(?:コード|番号)?)/iu.test(value);
}

function normalizedSequenceText(value: string): string {
  return value.replace(/[-\s・_]+/gu, "");
}

function normalizedInternalCode(value: string): string {
  return value.normalize("NFKC").toLocaleUpperCase("en-US").replace(/[^A-D]/gu, "");
}

function itemContainsForbiddenSequenceInput(item: readonly unknown[]): boolean {
  const strings = itemStrings(item);
  if (visibleSentences(item).some((sentence) => {
    const normalized = normalizedSequenceText(sentence);
    return SEQUENCE_TERM_PATTERN.test(normalized)
      && INPUT_ACTION_PATTERN.test(normalized)
      && !explicitlyNegatesSequenceInput(normalized);
  })) return true;
  if (!isResponseItem(item)) return false;
  if (strings.some((value) => ["ABDC", "BCAD", "CDBA", "DACB"].includes(
    normalizedInternalCode(value),
  ))) return true;
  return strings.some((value) => /^[A-D]$/u.test(
    normalizedLabel(value).toLocaleUpperCase("en-US"),
  ));
}

const PROHIBITED_PERSONAL_DATA_PATTERN = /(?:氏名|名前|フルネーム|メール(?:アドレス)?|e-?mail|学籍番号|学生番号|住所|電話番号|携帯番号|IPアドレス|位置情報|生年月日|顔写真|カメラ|マイク|ブラウザ指紋|心拍|生体データ)/iu;
const PERSONAL_DATA_ACTION_PATTERN = /(?:入力|記入|回答|選択|送信|提供|提出|収集|取得|記録|アップロード)/u;

function explicitlyNegatesPersonalDataCollection(value: string): boolean {
  return /(?:入力|記入|回答|選択|送信|提供|提出|収集|取得|記録|アップロード)(?:は|を)?(?:しない|しません|せず|不要|する必要はありません|することはありません|求めません|行いません)/u.test(value)
    || /(?:収集|取得|記録)(?:されません|しない方針)/u.test(value);
}

function itemContainsForbiddenPersonalDataInput(item: readonly unknown[]): boolean {
  const sentences = visibleSentences(item);
  if (
    isResponseItem(item)
    && sentences.some((sentence) =>
      PROHIBITED_PERSONAL_DATA_PATTERN.test(sentence)
      && !explicitlyNegatesPersonalDataCollection(sentence))
  ) return true;
  return sentences.some((sentence) =>
    PROHIBITED_PERSONAL_DATA_PATTERN.test(sentence)
    && PERSONAL_DATA_ACTION_PATTERN.test(sentence)
    && !explicitlyNegatesPersonalDataCollection(sentence));
}

function researchIdFormatValidationIsValid(item: readonly unknown[]): boolean {
  const entries = itemEntries(item);
  if (entries === null || entries.length !== 1) return false;
  const validations = arrayValue(entries[0]?.[4]);
  if (validations === null || validations.length !== 1) return false;
  const validation = arrayValue(validations[0]);
  const operands = arrayValue(validation?.[2]);
  return validation?.[0] === REGULAR_EXPRESSION_VALIDATION_TYPE
    && validation[1] === REGULAR_EXPRESSION_MATCHES_OPERATOR
    && operands?.length === 1
    && operands[0] === SCREEN_PRODUCTION_RESEARCH_ID_PATTERN;
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
      && url.username === ""
      && url.password === ""
      && hasApprovedPublicFormQuery(url)
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
  const title = stringValue(item[1]);
  if (item[3] !== 7 || title === null || normalizedVisibleText(title).length === 0) return false;
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
  const normalizedDecoded = decoded.normalize("NFKC");
  const publicPayload = /FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);\s*<\/script>/su.exec(source)?.[1] ?? null;
  const formItems = parsePublicFormItems(publicPayload);
  const contentSha256 = publicPayload === null
    ? ""
    : createHash("sha256").update(publicPayload, "utf8").digest("hex");
  const title = /<title[^>]*>([^<]*)<\/title>/iu.exec(decoded)?.[1]?.trim() ?? "(title not found)";
  const internalConditionTerm =
    "(?:クラウド|ローカル|(?:この)?端末内|状態(?:ラベル|指標)|高ストレス|フグ(?:型デバイス)?|ふくらみ|膨らみ|cloud|local|label|puffer)";
  const internalMappings = [
    new RegExp(
      `(?:条件\\s*)?[A-D]\\s*(?:条件)?\\s*(?:[:=→-]|は)\\s*${internalConditionTerm}`,
      "giu",
    ),
    new RegExp(
      `(?:条件\\s*)?[A-D]\\s*(?:条件)\\s*[（(]?\\s*${internalConditionTerm}`,
      "giu",
    ),
    new RegExp(
      `[A-D]\\s*[（(]\\s*${internalConditionTerm}`,
      "giu",
    ),
    new RegExp(
      `${internalConditionTerm}\\s*(?:[:=→-]|は)?\\s*[（(]?\\s*(?:条件\\s*)?[A-D](?:\\s*条件)?`,
      "giu",
    ),
  ].reduce((total, pattern) => total + occurrences(normalizedDecoded, pattern), 0);
  const legacyThree = occurrences(
    normalizedDecoded,
    /(?:(?:3|三)\s*(?:種類|つ\s*の\s*(?:提示|方法)|方法)|(?<!第)(?:3|三)\s*提示)/gu,
  );
  const currentFour = occurrences(decoded, /4種類|4つの提示|4提示/gu);
  const immediateAnswer = immediateAnswerInstructions(decoded);
  const afterAllFour = afterAllFourInstructions(decoded);
  const screenProtocolCopyMatches = SCREEN_PROTOCOL_COPY_PATTERNS.map(
    (pattern) => occurrences(decoded, pattern),
  );
  const screenProtocolCopyComplete = screenProtocolCopyMatches.every((count) => count > 0);
  const evaluationQuestions = formItems?.filter((item) => item[3] === 7) ?? [];
  const normalizedEvaluationTitles = evaluationQuestions.map((item) =>
    normalizedVisibleText(stringValue(item[1]) ?? ""));
  const evaluationStructureValid = evaluationQuestions.length === EVALUATION_QUESTION_COUNT
    && evaluationQuestions.every(evaluationQuestionStructureIsValid)
    && new Set(normalizedEvaluationTitles).size === EVALUATION_QUESTION_COUNT;
  const responseItems = formItems?.filter(isResponseItem) ?? [];
  const researchIdItems = responseItems.filter((item) => {
    const label = stringValue(item[1]);
    return label !== null && isResearchIdLikeLabel(label);
  });
  const researchIdLabels = researchIdItems.map((item) => stringValue(item[1]) ?? "(無題)");
  const researchIdItem = researchIdItems.length === 1 ? researchIdItems[0] : undefined;
  const researchIdEntries = researchIdItem === undefined ? null : itemEntries(researchIdItem);
  const researchIdStructureIdentifiable = researchIdItem !== undefined
    && itemType(researchIdItem) === SHORT_ANSWER_ITEM_TYPE
    && researchIdEntries?.length === 1;
  const researchIdFieldValid = researchIdStructureIdentifiable
    && normalizedLabel(stringValue(researchIdItem?.[1]) ?? "") === RESEARCH_ID_LABEL;
  const researchIdRequired = researchIdStructureIdentifiable
    && researchIdEntries?.[0]?.[2] === REQUIRED_ENTRY_FLAG;
  const researchIdFormatValid = researchIdItem !== undefined
    && researchIdStructureIdentifiable
    && researchIdFormatValidationIsValid(researchIdItem);
  const allowedResponseItems = new Set<readonly unknown[]>();
  if (
    researchIdItem !== undefined
    && researchIdFieldValid
    && researchIdRequired
    && researchIdFormatValid
  ) {
    allowedResponseItems.add(researchIdItem);
  }
  if (evaluationStructureValid) {
    for (const item of evaluationQuestions) allowedResponseItems.add(item);
  }
  const unexpectedResponseItems = responseItems.filter(
    (item) => !allowedResponseItems.has(item),
  );
  const unexpectedResponseTypes = [...new Set(
    unexpectedResponseItems.map((item) => itemType(item) ?? -1),
  )].sort((left, right) => left - right);
  const exactResponseItemContractValid = formItems !== null
    && responseItems.length === EXPECTED_RESPONSE_ITEM_COUNT
    && allowedResponseItems.size === EXPECTED_RESPONSE_ITEM_COUNT
    && unexpectedResponseItems.length === 0;
  const forbiddenSequenceInputItems = formItems?.filter(itemContainsForbiddenSequenceInput) ?? [];
  const forbiddenSequenceInputValid = formItems !== null
    && forbiddenSequenceInputItems.length === 0;
  const forbiddenPersonalDataItems = formItems
    ?.filter(itemContainsForbiddenPersonalDataInput) ?? [];
  const forbiddenPersonalDataValid = formItems !== null
    && forbiddenPersonalDataItems.length === 0;
  const extraFreeTextItems = responseItems.filter((item) => {
    const type = itemType(item);
    if (type !== SHORT_ANSWER_ITEM_TYPE && type !== PARAGRAPH_ANSWER_ITEM_TYPE) return false;
    return !(
      researchIdFieldValid
      && researchIdItems.length === 1
      && item === researchIdItem
    );
  });
  const extraFreeTextValid = formItems !== null && extraFreeTextItems.length === 0;
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
          ? "固定模擬データ、本人非測定、生体データ非取得、画面上のフグ、Googleフォーム回答の送信先、実験アプリによる固定模擬データの外部非送信・非保存の説明を確認しました。"
          : `screen版の必須説明6点の出現数は${screenProtocolCopyMatches.join("/")}です。`,
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
        "exact-response-item-contract",
        exactResponseItemContractValid ? "pass" : "fail",
        exactResponseItemContractValid
          ? "回答項目は、厳密な研究用ID欄1件と承認候補構造の評価グリッド11件だけです。"
          : formItems === null
            ? "公開payloadを解析できないため、回答項目の厳密な許可リストを確認できません。"
            : `回答項目は${String(responseItems.length)}件です。許可されるのは厳密な研究用ID欄1件と承認候補構造の評価グリッド11件だけです。許可外または構造不適合=${String(unexpectedResponseItems.length)}件、type=${unexpectedResponseTypes.join("/") || "なし"}。`,
      ),
      finding(
        "research-id-field",
        researchIdFieldValid ? "pass" : "fail",
        researchIdFieldValid
          ? "ラベルが「研究用ID」の短文入力欄を1件だけ確認しました。"
          : `「研究用ID」を含む回答入力欄は${String(researchIdItems.length)}件（ラベル: ${researchIdLabels.join(" / ") || "なし"}）です。厳密なラベル「研究用ID」の短文入力・単一entryは1件だけ必要です。`,
      ),
      finding(
        "research-id-required",
        researchIdRequired ? "pass" : "fail",
        researchIdRequired
          ? "研究用ID欄が必須回答であることを公開payloadで確認しました。"
          : "研究用ID欄の必須フラグを公開payloadで確認できません。",
      ),
      finding(
        "research-id-format-validation",
        researchIdFormatValid ? "pass" : "fail",
        researchIdFormatValid
          ? `研究用ID欄に${SCREEN_PRODUCTION_RESEARCH_ID_PATTERN}との完全一致validationを確認しました。`
          : `研究用ID欄に${SCREEN_PRODUCTION_RESEARCH_ID_PATTERN}との完全一致validationを確認できません。validationの欠落または未知の構造はNO-GOです。`,
      ),
      finding(
        "forbidden-sequence-input",
        forbiddenSequenceInputValid ? "pass" : "fail",
        forbiddenSequenceInputValid
          ? "提示順、順序コード、内部コードA〜Dを参加者へ入力させる説明・回答項目はありません。"
          : formItems === null
            ? "公開payloadを解析できないため、提示順・内部コード入力の不存在を確認できません。"
            : `提示順、順序コード、内部コードA〜Dの入力を求める説明または回答項目を${String(forbiddenSequenceInputItems.length)}件検出しました。`,
      ),
      finding(
        "forbidden-personal-data-input",
        forbiddenPersonalDataValid ? "pass" : "fail",
        forbiddenPersonalDataValid
          ? "氏名、メールアドレス等の禁止された個人情報を入力・収集する説明や回答項目はありません。"
          : formItems === null
            ? "公開payloadを解析できないため、禁止された個人情報入力の不存在を確認できません。"
            : `氏名、メールアドレス等の禁止された個人情報を入力・収集する説明または回答項目を${String(forbiddenPersonalDataItems.length)}件検出しました。`,
      ),
      finding(
        "forbidden-free-text-input",
        extraFreeTextValid ? "pass" : "fail",
        extraFreeTextValid
          ? "厳密な研究用ID欄以外に短文・段落の自由記述回答項目はありません。"
          : formItems === null
            ? "公開payloadを解析できないため、研究用ID以外の自由記述回答項目の不存在を確認できません。"
            : `厳密な研究用ID欄以外の短文・段落の自由記述回答項目を${String(extraFreeTextItems.length)}件検出しました。`,
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
        "メール収集、ログイン要求、分岐、機械検査対象外の必須設定は管理画面と未ログイン実回答経路で二名確認が必要です。",
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
