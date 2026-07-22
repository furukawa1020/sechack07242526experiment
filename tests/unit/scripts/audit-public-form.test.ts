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
const RESEARCH_ID_PATTERN = "^SH26-[0-9]{3}$";
const EXTERNAL_NON_TRANSMISSION_COPY =
  "この実験用Webアプリから、固定模擬身体データを外部へ送信・保存することはありません。";
const SCREEN_PROTOCOL_COPY = [
  "この実験では、同じ固定模擬データを4つの方法で提示します。",
  "表示される値は、あなた自身を測定したものではありません。",
  "この実験では、心拍その他の生体データを取得しません。",
  "状態は画面上のフグのふくらみで表します。",
  "アンケート回答は、Googleフォームの送信時にGoogleへ送信・保存されます。",
  EXTERNAL_NON_TRANSMISSION_COPY,
].join(" ");

interface FormFixtureOptions {
  readonly evaluationCount?: number;
  readonly extraResponseType?: number;
  readonly forbiddenInternalCodeChoices?: boolean;
  readonly forbiddenSequenceInput?: boolean;
  readonly malformedEvaluation?: boolean;
  readonly extraFreeText?: "paragraph" | "short";
  readonly personalDataChoice?: boolean;
  readonly personalDataNegationChoice?: boolean;
  readonly untitledInput?: boolean;
  readonly omitScreenProtocolCopy?: boolean;
  readonly researchIdCount?: number;
  readonly researchIdLabel?: string;
  readonly researchIdRequired?: boolean;
  readonly researchIdValidation?: "missing" | "unknown" | "valid" | "wrong-pattern";
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

function researchIdQuestion(index: number, options: FormFixtureOptions): readonly unknown[] {
  const validation = options.researchIdValidation === "missing"
    ? undefined
    : options.researchIdValidation === "unknown"
      ? [[999, 999, [RESEARCH_ID_PATTERN], "形式を確認してください"]]
      : [[
          4,
          301,
          [options.researchIdValidation === "wrong-pattern" ? "^SH26-.*$" : RESEARCH_ID_PATTERN],
          "SH26-001の形式で入力してください",
        ]];
  const entry: unknown[] = [
    30_000 + index,
    null,
    options.researchIdRequired === false ? 0 : 1,
  ];
  if (validation !== undefined) entry.push(null, validation);
  return [
    29_000 + index,
    options.researchIdLabel ?? "研究用ID",
    "研究スタッフから伝えられた研究用IDを入力してください。",
    0,
    [entry],
  ];
}

function formHtml(content: string, options: FormFixtureOptions = {}): string {
  const evaluationCount = options.evaluationCount ?? 11;
  const researchIdCount = options.researchIdCount ?? 1;
  const items: unknown[] = [
    [
      1,
      options.omitScreenProtocolCopy === true ? content : `${SCREEN_PROTOCOL_COPY} ${content}`,
      null,
      6,
      null,
    ],
    ...Array.from(
      { length: researchIdCount },
      (_, index) => researchIdQuestion(index, options),
    ),
    ...(options.forbiddenSequenceInput === true
      ? [
          [
            40_000,
            "研究用情報の入力",
            "研究用IDと提示順コードを使用します。研究スタッフの案内に従って入力してください。",
            8,
            null,
          ],
          [40_001, null, null, 2, [[40_002, [["Option 1"]], 0]]],
        ]
      : []),
    ...(options.forbiddenInternalCodeChoices === true
      ? [[41_000, "入力項目", null, 2, [[41_001, [["A"], ["B"], ["C"], ["D"]], 1]]]]
      : []),
    ...(options.extraFreeText === undefined
      ? []
      : [[
          42_000,
          "追加コメント",
          null,
          options.extraFreeText === "short" ? 0 : 1,
          [[42_001, null, 0]],
        ]]),
    ...(options.personalDataChoice === true
      ? [[42_100, "氏名を選択してください", null, 2, [[42_101, [["例"]], 1]]]]
      : []),
    ...(options.personalDataNegationChoice === true
      ? [[42_110, "氏名やメールアドレスは収集しません", null, 2, [[42_111, [["確認しました"]], 1]]]]
      : []),
    ...(options.extraResponseType === undefined
      ? []
      : [[
          42_200,
          "追加の回答項目",
          null,
          options.extraResponseType,
          [[42_201, [["選択肢1"], ["選択肢2"]], 0]],
        ]]),
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
    expect(() => parsePublicFormAuditArguments([
      "--url",
      "https://docs.google.com/forms/d/e/id/viewform?usp=pp_url&entry.1=secret",
    ])).toThrow(/approved Google Forms/iu);
    expect(() => parsePublicFormAuditArguments([
      "--url",
      "https://forms.gle/example?unknown=1",
    ])).toThrow(/approved Google Forms/iu);
    expect(parsePublicFormAuditArguments([
      "--url",
      "https://docs.google.com/forms/d/e/id/viewform?usp=send_form",
    ])).toEqual({
      help: false,
      url: "https://docs.google.com/forms/d/e/id/viewform?usp=send_form",
    });
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

  it("normalizes full-width internal condition mappings before detection", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("Ａ 条件 → クラウド 4つの提示をすべて体験した後、全11問へ回答してください。"),
    );
    expect(report.findings.find((item) => item.id === "internal-condition-mapping")?.status)
      .toBe("fail");
  });

  it.each([
    "A：状態ラベル",
    "C：フグ",
    "条件B（状態指標）",
    "puffer = D条件",
  ])("rejects an internal code mapped to any presentation attribute: %s", (mapping) => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml(`${mapping} 4つの提示をすべて体験した後、全11問へ回答してください。`),
    );
    expect(report.findings.find((item) => item.id === "internal-condition-mapping")?.status)
      .toBe("fail");
  });

  it.each([
    "3種類を比較します",
    "3つの提示を体験します",
    "3提示が終了してから回答します",
    "三つの方法を比較します",
  ])("rejects every supported legacy three-presentation expression: %s", (copy) => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml(`${copy} 4つの提示をすべて体験した後、全11問へ回答してください。`),
    );
    expect(report.findings.find((item) => item.id === "legacy-three-presentations")?.status)
      .toBe("fail");
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
    expect(report.findings.find((item) => item.id === "research-id-field")?.status)
      .toBe("pass");
    expect(report.findings.find((item) => item.id === "research-id-required")?.status)
      .toBe("pass");
    expect(report.findings.find((item) => item.id === "research-id-format-validation")?.status)
      .toBe("pass");
    expect(report.findings.find((item) => item.id === "forbidden-sequence-input")?.status)
      .toBe("pass");
    expect(report.findings.find((item) => item.id === "exact-response-item-contract")?.status)
      .toBe("pass");
  });

  it.each([
    ["missing", { researchIdCount: 0 }, "research-id-field"],
    ["duplicate", { researchIdCount: 2 }, "research-id-field"],
    ["decorated label", { researchIdLabel: "研究用ID（必須）" }, "research-id-field"],
    ["optional", { researchIdRequired: false }, "research-id-required"],
    ["missing validation", { researchIdValidation: "missing" }, "research-id-format-validation"],
    ["unknown validation", { researchIdValidation: "unknown" }, "research-id-format-validation"],
    ["broad validation", { researchIdValidation: "wrong-pattern" }, "research-id-format-validation"],
  ] as const)("fails a %s research ID field", (_label, options, findingId) => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("4つの提示をすべて体験した後、全11問へ回答してください。", options),
    );
    expect(report.findings.find((item) => item.id === findingId)?.status).toBe("fail");
  });

  it("rejects participant input of presentation order or internal codes", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("4つの提示をすべて体験した後、全11問へ回答してください。", {
        forbiddenSequenceInput: true,
      }),
    );
    expect(report.findings.find((item) => item.id === "forbidden-sequence-input")?.status)
      .toBe("fail");

    const internalCodes = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("4つの提示をすべて体験した後、全11問へ回答してください。", {
        forbiddenInternalCodeChoices: true,
      }),
    );
    expect(internalCodes.findings.find((item) => item.id === "forbidden-sequence-input")?.status)
      .toBe("fail");
  });

  it.each([
    "提示 順序 コードを入力してください。",
    "提示順番の番号を記入してください。",
    "オーダー・コードを回答してください。",
    "条件 番号を選択してください。",
  ])("normalizes presentation-order wording before rejecting input: %s", (copy) => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml(`4つの提示をすべて体験した後、全11問へ回答してください。 ${copy}`),
    );
    expect(report.findings.find((item) => item.id === "forbidden-sequence-input")?.status)
      .toBe("fail");
  });

  it.each([
    "提示順コードは入力しません。",
    "参加者へ内部コードを入力させません。",
    "順序番号を回答する必要はありません。",
    "参加者に提示順を入力させることはありません。",
  ])("does not treat an explicit sequence-input negation as an instruction: %s", (copy) => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml(`4つの提示をすべて体験した後、全11問へ回答してください。 ${copy}`),
    );
    expect(report.findings.find((item) => item.id === "forbidden-sequence-input")?.status)
      .toBe("pass");
  });

  it.each(["short", "paragraph"] as const)(
    "rejects a non-research-ID %s free-text field without flagging the 11 evaluation grids",
    (extraFreeText) => {
      const report = inspectPublicFormPayload(
        FORM_URL,
        CANONICAL_FORM_URL,
        formHtml("4つの提示をすべて体験した後、全11問へ回答してください。", {
          extraFreeText,
        }),
      );
      expect(report.findings.find((item) => item.id === "forbidden-free-text-input")?.status)
        .toBe("fail");
      expect(report.findings.find((item) => item.id === "evaluation-structure")?.status)
        .toBe("pass");
    },
  );

  it("rejects personal-data response items and affirmative collection copy", () => {
    const responseItem = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("4つの提示をすべて体験した後、全11問へ回答してください。", {
        personalDataChoice: true,
      }),
    );
    expect(responseItem.findings.find(
      (item) => item.id === "forbidden-personal-data-input",
    )?.status).toBe("fail");

    const instruction = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("4つの提示をすべて体験した後、全11問へ回答してください。メールアドレスを入力してください。"),
    );
    expect(instruction.findings.find(
      (item) => item.id === "forbidden-personal-data-input",
    )?.status).toBe("fail");
  });

  it("permits explicit non-collection copy while the approved 11 grids remain valid", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("4つの提示をすべて体験した後、全11問へ回答してください。氏名やメールアドレスは収集しません。"),
    );
    expect(report.findings.find(
      (item) => item.id === "forbidden-personal-data-input",
    )?.status).toBe("pass");
    expect(report.findings.find((item) => item.id === "forbidden-free-text-input")?.status)
      .toBe("pass");
    expect(report.findings.find((item) => item.id === "evaluation-structure")?.status)
      .toBe("pass");

    const consentChoice = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("4つの提示をすべて体験した後、全11問へ回答してください。", {
        personalDataNegationChoice: true,
      }),
    );
    expect(consentChoice.findings.find(
      (item) => item.id === "forbidden-personal-data-input",
    )?.status).toBe("pass");
    expect(consentChoice.findings.find(
      (item) => item.id === "exact-response-item-contract",
    )?.status).toBe("fail");
  });

  it.each([
    ["multiple choice", 2],
    ["dropdown", 3],
    ["checkbox", 4],
    ["linear scale", 5],
    ["date", 9],
    ["time", 10],
    ["duration", 11],
    ["unknown Google response type", 12],
    ["file upload", 13],
    ["unknown future response type", 99],
  ] as const)(
    "rejects an extra %s response item (type %i) even when it contains no PII keyword",
    (_label, extraResponseType) => {
      const report = inspectPublicFormPayload(
        FORM_URL,
        CANONICAL_FORM_URL,
        formHtml("4つの提示をすべて体験した後、全11問へ回答してください。", {
          extraResponseType,
        }),
      );
      const contract = report.findings.find(
        (item) => item.id === "exact-response-item-contract",
      );
      expect(contract?.status).toBe("fail");
      expect(contract?.detail).toContain("許可外または構造不適合=1件");
      expect(report.findings.find(
        (item) => item.id === "forbidden-personal-data-input",
      )?.status).toBe("pass");
    },
  );

  it("rejects a consent checkbox in the post-presentation evaluation form", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml("4つの提示をすべて体験した後、全11問へ回答してください。", {
        extraResponseType: 4,
      }).replace("追加の回答項目", "研究参加に同意します"),
    );
    expect(report.findings.find(
      (item) => item.id === "exact-response-item-contract",
    )?.status).toBe("fail");
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

  it("fails when only the app external non-transmission and non-storage explanation is missing", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml([
        "この実験では、同じ固定模擬データを4つの方法で提示します。",
        "表示される値は、あなた自身を測定したものではありません。",
        "この実験では、心拍その他の生体データを取得しません。",
        "状態は画面上のフグのふくらみで表します。",
        "アンケート回答は、Googleフォームの送信時にGoogleへ送信・保存されます。",
        "4つの提示をすべて体験した後、全11問へ回答してください。",
      ].join(" "), { omitScreenProtocolCopy: true }),
    );
    const finding = report.findings.find((item) => item.id === "screen-protocol-copy");
    expect(finding?.status).toBe("fail");
    expect(finding?.detail).toContain("1/1/1/1/1/0");
  });

  it("rejects copy that permits external transmission while denying only storage", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml([
        "この実験では、同じ固定模擬データを4つの方法で提示します。",
        "表示される値は、あなた自身を測定したものではありません。",
        "この実験では、心拍その他の生体データを取得しません。",
        "状態は画面上のフグのふくらみで表します。",
        "アンケート回答は、Googleフォームの送信時にGoogleへ送信・保存されます。",
        "この実験用Webアプリから、固定模擬身体データを外部へ送信しますが、保存しません。",
      ].join(" "), { omitScreenProtocolCopy: true }),
    );
    const finding = report.findings.find((item) => item.id === "screen-protocol-copy");
    expect(finding?.status).toBe("fail");
    expect(finding?.detail).toContain("1/1/1/1/1/0");
  });

  it.each([
    "この実験用Webアプリから、固定模擬身体データを外部へ送信・保存しませんとは言い切れません。",
    "この実験用Webアプリから、固定模擬身体データを外部へ送信・保存しないよう努めます。",
    "この実験用Webアプリから、固定模擬身体データを外部へ送信・保存しませんが必要時には送信します。",
  ])("rejects qualified or reversible non-transmission copy: %s", (unsafeCopy) => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      CANONICAL_FORM_URL,
      formHtml(
        SCREEN_PROTOCOL_COPY.replace(EXTERNAL_NON_TRANSMISSION_COPY, unsafeCopy),
        { omitScreenProtocolCopy: true },
      ),
    );
    const finding = report.findings.find((item) => item.id === "screen-protocol-copy");
    expect(finding?.status).toBe("fail");
    expect(finding?.detail).toContain("1/1/1/1/1/0");
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
    expect(report.findings.find((item) => item.id === "research-id-field")?.status)
      .toBe("fail");
    expect(report.findings.find((item) => item.id === "forbidden-sequence-input")?.status)
      .toBe("fail");
  });
});
