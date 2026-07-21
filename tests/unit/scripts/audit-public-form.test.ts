import { describe, expect, it } from "vitest";

import {
  decodePublicFormPayload,
  inspectPublicFormPayload,
  parsePublicFormAuditArguments,
  runPublicFormAudit,
} from "../../../scripts/audit-public-form.js";

const FORM_URL = "https://forms.gle/BeShY7cY5zMjunto9";
const CANONICAL_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSea5PhAbtkSS_Pg-xL-O7scpRddMn5ReoKzgAt7lSE7GTlA9Q/viewform?usp=send_form";
const FORM_TITLE = "身体状態の外化デバイスがユーザの心理状態に及ぼす影響の評価｜研究説明・参加同意・アンケート";
const SCALE = [
  "1全くそう思わない",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7非常にそう思う",
] as const;
const ROWS = ["第1提示", "第2提示", "第3提示", "第4提示"] as const;
const SCREEN_PROTOCOL_COPY = [
  "この実験では、同じ固定模擬データを4つの方法で提示します。",
  "表示される値は、あなた自身を測定したものではありません。",
  "この実験では、心拍その他の生体データを取得しません。",
  "状態は画面上のフグのふくらみで表します。",
  "アンケート回答は、Googleフォームの送信時にGoogleへ送信・保存されます。",
].join(" ");

interface FormFixtureOptions {
  readonly evaluationCount?: number;
  readonly malformedEvaluation?: boolean;
  readonly untitledInput?: boolean;
  readonly omitScreenProtocolCopy?: boolean;
}

function response(body: string, status = 200): Response {
  const result = new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  Object.defineProperty(result, "url", { value: CANONICAL_FORM_URL });
  return result;
}

function evaluationQuestion(index: number, malformed: boolean): readonly unknown[] {
  const entries = ROWS.map((label, rowIndex) => [
    20_000 + index * 10 + rowIndex,
    SCALE.map((choice) => [choice]),
    malformed && rowIndex === 0 ? 1 : 0,
    [label],
  ]);
  return [10_000 + index, `評価質問${String(index + 1)}`, null, 7, entries];
}

function formHtml(content: string, options: FormFixtureOptions = {}): string {
  const evaluationCount = options.evaluationCount ?? 11;
  const items: unknown[] = [
    [
      1,
      options.omitScreenProtocolCopy === true ? content : `${SCREEN_PROTOCOL_COPY} ${content}`,
      null,
      6,
      null,
    ],
    ...Array.from(
      { length: evaluationCount },
      (_, index) => evaluationQuestion(index, options.malformedEvaluation === true),
    ),
  ];
  if (options.untitledInput === true) items.push([999, null, null, 2, [[998, [["Option 1"]], 0]]]);
  const payload = [null, [null, items]];
  return `<title>${FORM_TITLE}</title><script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(payload)};</script>`;
}

describe("public Google Form audit", () => {
  it("parses only approved Google Forms URLs", () => {
    expect(parsePublicFormAuditArguments([])).toEqual({ help: false, url: FORM_URL });
    expect(parsePublicFormAuditArguments(["--url", "https://docs.google.com/forms/d/e/id/viewform"]))
      .toEqual({ help: false, url: "https://docs.google.com/forms/d/e/id/viewform" });
    expect(() => parsePublicFormAuditArguments(["--url", "https://example.com/form"]))
      .toThrow(/approved Google Forms/iu);
    expect(() => parsePublicFormAuditArguments(["--url"]))
      .toThrow(/requires a value/iu);
  });

  it("decodes inert unicode escapes without evaluating payload code", () => {
    expect(decodePublicFormPayload(String.raw`\u0033\u7a2e\u985e\n\"text\"`))
      .toBe('3種類 "text"');
  });

  it("fails internal mappings, legacy presentation count, and conflicting timing", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("A＝クラウド B=ローカル C：ローカル D:クラウド 3種類 4種類 各提示の直後 4種類すべての提示を体験した後 全11問"),
    );
    expect(report.findings.filter((item) => item.status === "fail").map((item) => item.id))
      .toEqual(["internal-condition-mapping", "legacy-three-presentations", "answer-timing"]);
    expect(report.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("passes machine-checkable content while retaining the administrator warning", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml([
        "この実験では、同じ固定模擬データを4つの方法で提示します。",
        "アプリで4つの提示をすべて見終え、サマリーが表示された後、このフォームへ戻ってください。",
        "第1提示から第4提示までを、11問でそれぞれ評価してください。",
        "回答は、4つの提示がすべて終了してから行ってください。",
      ].join(" ")),
    );
    expect(report.findings.filter((item) => item.status === "fail")).toEqual([]);
    expect(report.findings.find((item) => item.id === "administrator-only-settings")?.status)
      .toBe("warning");
  });

  it("fails when the fixed-data and screen-puffer protocol explanation is incomplete", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml(
        "4つの提示をすべて体験した後、全11問へ回答してください。",
        { omitScreenProtocolCopy: true },
      ),
    );
    expect(report.findings.find((item) => item.id === "screen-protocol-copy")?.status)
      .toBe("fail");
  });

  it("still rejects an affirmative immediate-answer instruction beside the approved negation", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml([
        "4つの提示をすべて見終え、サマリーが表示された後、このフォームへ戻ってください。",
        "各提示の直後には回答せず、4つの提示がすべて終了してから回答してください。",
        "各提示の直後に11項目へ回答してください。",
        "全11問",
      ].join(" ")),
    );
    expect(report.findings.find((item) => item.id === "answer-timing")?.status).toBe("fail");
  });

  it("counts actual evaluation nodes and validates their rows, scale, and optional status", () => {
    const copy = "4つの提示をすべて体験した後、全11問へ回答してください。";
    const missingQuestion = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml(copy, { evaluationCount: 10 }),
    );
    expect(missingQuestion.findings.find((item) => item.id === "eleven-questions")?.status)
      .toBe("fail");

    const malformed = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml(copy, { malformedEvaluation: true }),
    );
    expect(malformed.findings.find((item) => item.id === "evaluation-structure")?.status)
      .toBe("fail");
  });

  it("rejects an untitled response item even when the visible copy otherwise passes", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("4つの提示をすべて体験した後、全11問へ回答してください。", {
        untitledInput: true,
      }),
    );
    expect(report.findings.find((item) => item.id === "untitled-inputs")?.status).toBe("fail");
  });

  it("returns nonzero for a blocked live payload without submitting data", async () => {
    const requests: Array<{ readonly input: string; readonly init?: RequestInit }> = [];
    const lines: string[] = [];
    const exitCode = await runPublicFormAudit({
      args: [],
      writeLine: (line) => lines.push(line),
      fetchImplementation: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input: String(input), ...(init === undefined ? {} : { init }) });
        return response(
          formHtml("A：クラウド B：ローカル C：ローカル D：クラウド 3種類 4種類 各提示の直後 4種類すべての提示を体験した後 全11問"),
        );
      }) as typeof fetch,
    });
    expect(exitCode).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.credentials).toBe("omit");
    expect(lines.at(-1)).toMatch(/NO-GO/iu);
  });

  it("fails closed on non-HTML or unsuccessful responses", async () => {
    const lines: string[] = [];
    const exitCode = await runPublicFormAudit({
      writeLine: (line) => lines.push(line),
      fetchImplementation: (async () => response("not found", 404)) as typeof fetch,
    });
    expect(exitCode).toBe(1);
    expect(lines.at(-1)).toMatch(/HTTP 404/iu);
  });

  it("fails closed when the stable public payload cannot be extracted", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      FORM_URL,
      `<title>${FORM_TITLE}</title>4種類 4つの提示をすべて体験した後 全11問`,
    );
    expect(report.contentSha256).toBe("");
    expect(report.findings.find((item) => item.id === "canonical-public-payload")?.status)
      .toBe("fail");
  });
});
