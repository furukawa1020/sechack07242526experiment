import { describe, expect, it } from "vitest";

import {
  decodePublicFormPayload,
  inspectPublicFormPayload,
  parsePublicFormAuditArguments,
  runPublicFormAudit,
} from "../../../scripts/audit-public-form.js";

const FORM_URL = "https://forms.gle/BeShY7cY5zMjunto9";

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function formHtml(content: string): string {
  return `<title>研究フォーム</title><script>var FB_PUBLIC_LOAD_DATA_ = [${JSON.stringify(content)}];</script>`;
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
      "https://docs.google.com/forms/d/e/id/viewform",
      formHtml("A＝クラウド B=ローカル C：ローカル D:クラウド 3種類 4種類 各提示の直後 4種類すべての提示を体験した後 全11問"),
    );
    expect(report.findings.filter((item) => item.status === "fail").map((item) => item.id))
      .toEqual(["internal-condition-mapping", "legacy-three-presentations", "answer-timing"]);
    expect(report.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("passes machine-checkable content while retaining the administrator warning", () => {
    const report = inspectPublicFormPayload(
      FORM_URL,
      "https://docs.google.com/forms/d/e/id/viewform",
      formHtml("4種類 4つの提示をすべて体験した後 全11問"),
    );
    expect(report.findings.filter((item) => item.status === "fail")).toEqual([]);
    expect(report.findings.find((item) => item.id === "administrator-only-settings")?.status)
      .toBe("warning");
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
      "<title>研究フォーム</title>4種類 4つの提示をすべて体験した後 全11問",
    );
    expect(report.contentSha256).toBe("");
    expect(report.findings.find((item) => item.id === "canonical-public-payload")?.status)
      .toBe("fail");
  });
});
