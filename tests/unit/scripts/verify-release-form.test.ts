import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXPECTED_FORM_TITLE,
  type PublicFormAuditReport,
} from "../../../scripts/audit-public-form.js";
import {
  assessReleaseFormVerification,
  isExpectedStudyFormFinalUrl,
  parseReleaseFormVerificationArguments,
  runReleaseFormVerification,
} from "../../../scripts/verify-release-form.js";
import { hashProductionCriticalConfig } from "../../../src/shared/config-loader.js";
import { STUDY_FORM_URL } from "../../../src/shared/form-audit.js";
import {
  parseExperimentConfig,
  SCREEN_PROTOCOL_VERSION,
  type ExperimentConfig,
} from "../../../src/shared/schemas.js";

const PROTOCOL_VERSION = SCREEN_PROTOCOL_VERSION;
const AUDIT_NOW = new Date("2026-07-21T12:00:00.000Z");
const EXPECTED_FINAL_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSea5PhAbtkSS_Pg-xL-O7scpRddMn5ReoKzgAt7lSE7GTlA9Q/viewform?usp=send_form";
const REQUIRED_FINDINGS = [
  "canonical-public-payload",
  "canonical-form",
  "study-title",
  "internal-condition-mapping",
  "legacy-three-presentations",
  "four-presentations",
  "screen-protocol-copy",
  "answer-timing",
  "eleven-questions",
  "evaluation-structure",
  "exact-response-item-contract",
  "research-id-field",
  "research-id-required",
  "research-id-format-validation",
  "forbidden-sequence-input",
  "forbidden-personal-data-input",
  "forbidden-free-text-input",
  "untitled-inputs",
  "file-uploads",
] as const;

const temporaryRoots: string[] = [];

function fixtureDigest(label: string): string {
  return createHash("sha256").update(`fixture:${label}`, "utf8").digest("hex");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

function config(contentSha256 = "a".repeat(64)): ExperimentConfig {
  const source = {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    studyTitle: "テスト研究",
    bindHost: "127.0.0.1",
    port: 4173,
    researchIdPattern: "^SH26-[0-9]{3}$",
    orders: ["ABDC", "BCAD", "CDBA", "DACB"],
    fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
    timingMs: {
      handling: 8_000,
      processing: 3_000,
      result: 15_000,
      reset: 7_000,
      inflateRamp: 6_000,
      deflateRamp: 6_000,
    },
    device: {
      mode: "screen",
      serialPath: "",
      baudRate: 115_200,
      ackTimeout: 1_000,
      allowMockInProduction: false,
    },
    formUrl: STUDY_FORM_URL,
    formAudit: {
      status: "GO",
      protocolVersion: PROTOCOL_VERSION,
      formUrl: STUDY_FORM_URL,
      auditedOn: "2026-07-21",
      contentSha256,
      twoPersonVerified: true,
    },
    logging: {
      directory: "./data/sessions",
      includeAbortedInOrderBalancing: true,
    },
    network: { allowLan: false, allowExternalRuntimeRequests: false },
  };
  const criticalConfigSha256 = hashProductionCriticalConfig(parseExperimentConfig(source));
  const approval = (documentId: string, digest: string) => ({
    status: "GO" as const,
    protocolVersion: PROTOCOL_VERSION,
    documentId,
    documentVersion: "1.0",
    contentSha256: digest,
    approvedOn: "2026-07-20",
    applicableUntil: "2026-07-22",
  });
  return parseExperimentConfig({
    ...source,
    goEvidence: {
      status: "GO",
      protocolVersion: PROTOCOL_VERSION,
      criticalConfigSha256,
      researchPlan: approval("PLAN-001", fixtureDigest("research-plan")),
      ethicsDetermination: approval("ETHICS-001", fixtureDigest("ethics")),
      preStimulusConsent: approval("CONSENT-001", fixtureDigest("consent")),
      dataManagementPlan: approval("DATA-PLAN-001", fixtureDigest("data-plan")),
      screenPilot: {
        ...approval("SCREEN-PILOT-001", fixtureDigest("screen-pilot")),
        completedSessions: 3,
        sourceTreeSha256: fixtureDigest("source-tree"),
        pilotConfigFileHash: fixtureDigest("pilot-config"),
      },
      releaseVerification: {
        status: "GO",
        protocolVersion: PROTOCOL_VERSION,
        appVersion: "1.0.0",
        sourceTreeSha256: fixtureDigest("source-tree"),
        criticalConfigSha256,
        reviews: [
          {
            reviewId: "RELEASE-REVIEW-001",
            reviewerCode: "REV-0001",
            reviewVersion: "1.0",
            status: "GO",
            protocolVersion: PROTOCOL_VERSION,
            criticalConfigSha256,
            reviewedOn: "2026-07-20",
            applicableUntil: "2026-07-22",
            attestationSha256: fixtureDigest("release-review-1"),
          },
          {
            reviewId: "RELEASE-REVIEW-002",
            reviewerCode: "REV-0002",
            reviewVersion: "1.0",
            status: "GO",
            protocolVersion: PROTOCOL_VERSION,
            criticalConfigSha256,
            reviewedOn: "2026-07-20",
            applicableUntil: "2026-07-22",
            attestationSha256: fixtureDigest("release-review-2"),
          },
        ],
      },
    },
  });
}

function report(overrides: Partial<PublicFormAuditReport> = {}): PublicFormAuditReport {
  return {
    requestedUrl: STUDY_FORM_URL,
    finalUrl: EXPECTED_FINAL_URL,
    title: EXPECTED_FORM_TITLE,
    contentSha256: "a".repeat(64),
    findings: [
      ...REQUIRED_FINDINGS.map((id) => ({ id, status: "pass" as const, detail: "pass" })),
      { id: "administrator-only-settings", status: "warning", detail: "manual" },
    ],
    ...overrides,
  };
}

function approvedFormHtml(): { readonly html: string; readonly sha256: string } {
  const content = [
    "この実験では、同じ固定模擬データを4つの方法で提示します。",
    "表示される値は、あなた自身を測定したものではありません。",
    "この実験では、心拍その他の生体データを取得しません。",
    "状態は画面上のフグのふくらみで表します。",
    "アンケート回答は、Googleフォームの送信時にGoogleへ送信・保存されます。",
    "この実験用Webアプリから、固定模擬身体データを外部へ送信・保存することはありません。",
    "4つの提示をすべて見終え、サマリーが表示された後、このフォームへ戻ってください。",
    "各提示の直後には回答せず、4つの提示がすべて終了してから回答してください。",
    "第1提示から第4提示までを、11問でそれぞれ評価してください。",
  ].join(" ");
  const rows = ["第1提示", "第2提示", "第3提示", "第4提示"];
  const scale = ["1全くそう思わない", "2", "3", "4", "5", "6", "7非常にそう思う"];
  const items = [
    [
      null,
      "研究用ID",
      "研究スタッフから伝えられた研究用IDを入力してください。",
      0,
      [[null, null, 1, null, [[4, 301, ["^SH26-[0-9]{3}$"], "形式を確認してください"]]]],
    ],
    ...Array.from({ length: 11 }, (_unused, questionIndex) => [
      null,
      `評価質問${String(questionIndex + 1)}`,
      null,
      7,
      rows.map((row) => [null, scale.map((label) => [label]), 0, [row]]),
    ]),
  ];
  const payload = JSON.stringify([content, [null, items]]);
  return {
    html: `<title>${EXPECTED_FORM_TITLE}</title><script>var FB_PUBLIC_LOAD_DATA_ = ${payload};</script>`,
    sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
  };
}

describe("production release Google Form verification", () => {
  it("parses one safe config path and rejects malformed arguments", () => {
    expect(parseReleaseFormVerificationArguments([])).toEqual({ help: false });
    expect(parseReleaseFormVerificationArguments(["--config", "config/production.json"]))
      .toEqual({ help: false, configPath: "config/production.json" });
    expect(() => parseReleaseFormVerificationArguments(["--config"]))
      .toThrow(/requires a path/iu);
    expect(() => parseReleaseFormVerificationArguments(["--unknown"]))
      .toThrow(/unknown option/iu);
  });

  it("pins the final docs.google.com form identifier", () => {
    expect(isExpectedStudyFormFinalUrl(EXPECTED_FINAL_URL)).toBe(true);
    expect(isExpectedStudyFormFinalUrl(
      "https://docs.google.com/forms/d/e/different/viewform?usp=send_form",
    )).toBe(false);
    expect(isExpectedStudyFormFinalUrl(
      `https://example.test/forms/d/e/1FAIpQLSea5PhAbtkSS_Pg-xL-O7scpRddMn5ReoKzgAt7lSE7GTlA9Q/viewform`,
    )).toBe(false);
    expect(isExpectedStudyFormFinalUrl(
      `${EXPECTED_FINAL_URL}&entry.123=participant-data`,
    )).toBe(false);
    expect(isExpectedStudyFormFinalUrl(
      EXPECTED_FINAL_URL.replace("usp=send_form", "usp=pp_url"),
    )).toBe(false);
    expect(isExpectedStudyFormFinalUrl(`${EXPECTED_FINAL_URL}#prefill`)).toBe(false);
    expect(isExpectedStudyFormFinalUrl(EXPECTED_FINAL_URL.split("?")[0] ?? "")).toBe(true);
  });

  it("passes only when local approval and the live report are exactly bound", () => {
    expect(assessReleaseFormVerification(config(), report(), AUDIT_NOW)).toMatchObject({
      approved: true,
      issues: [],
    });
  });

  it("rejects non-screen production metadata even if the form evidence itself matches", () => {
    const formal = config();
    const serial = {
      ...formal,
      protocolVersion: "serial-form-test-v1",
      device: { ...formal.device, mode: "serial", serialPath: "COM3" },
      formAudit: { ...formal.formAudit!, protocolVersion: "serial-form-test-v1" },
    } as ExperimentConfig;
    expect(assessReleaseFormVerification(serial, report(), AUDIT_NOW)).toMatchObject({
      approved: false,
      issues: expect.arrayContaining([
        "production-device-serial-device-not-allowed",
        "production-device-production-protocol-version-not-screen",
      ]),
    });
  });

  it.each([
    ["payload SHA", report({ contentSha256: "b".repeat(64) }), "payload-sha256-mismatch"],
    ["short URL", report({ requestedUrl: "https://forms.gle/different" }), "requested-short-url-mismatch"],
    ["final form ID", report({ finalUrl: "https://docs.google.com/forms/d/e/different/viewform" }), "final-form-id-mismatch"],
    ["title", report({ title: "別のフォーム" }), "form-title-mismatch"],
    [
      "machine finding",
      report({
        findings: report().findings.map((finding) => finding.id === "answer-timing"
          ? { ...finding, status: "fail" as const }
          : finding),
      }),
      "machine-finding-not-pass:answer-timing",
    ],
  ] as const)("rejects a mismatched %s", (_label, publicReport, issue) => {
    const result = assessReleaseFormVerification(config(), publicReport, AUDIT_NOW);
    expect(result.approved).toBe(false);
    expect(result.issues).toContain(issue);
  });

  it.each([
    "untitled-inputs",
    "research-id-field",
    "research-id-required",
    "research-id-format-validation",
    "forbidden-sequence-input",
    "forbidden-personal-data-input",
    "forbidden-free-text-input",
  ])("fails closed when the required %s machine finding is absent", (findingId) => {
    const missing = report({
      findings: report().findings.filter((finding) => finding.id !== findingId),
    });
    expect(assessReleaseFormVerification(config(), missing, AUDIT_NOW).issues)
      .toContain(`machine-finding-missing:${findingId}`);
  });

  it("performs one credential-free GET and verifies the configured payload SHA", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-form-release-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "config"));
    const approved = approvedFormHtml();
    await writeFile(
      join(root, "config", "production.json"),
      JSON.stringify(config(approved.sha256)),
      "utf8",
    );
    const requests: Array<{ readonly input: string; readonly init?: RequestInit }> = [];
    const response = new Response(approved.html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(response, "url", { value: EXPECTED_FINAL_URL });
    const output: string[] = [];
    const exitCode = await runReleaseFormVerification({
      args: ["--config", "config/production.json"],
      rootDirectory: root,
      now: AUDIT_NOW,
      writeLine: (line) => output.push(line),
      fetchImplementation: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input: String(input), ...(init === undefined ? {} : { init }) });
        return response;
      }) as typeof fetch,
    });
    expect(exitCode, output.join("\n")).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe(STUDY_FORM_URL);
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.credentials).toBe("omit");
    expect(output.at(-1)).toMatch(/結果: PASS/iu);
  });

  it("fails closed when the read-only fetch cannot complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-form-release-fail-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "production.json"), JSON.stringify(config()), "utf8");
    const output: string[] = [];
    const exitCode = await runReleaseFormVerification({
      args: ["--config", "config/production.json"],
      rootDirectory: root,
      now: AUDIT_NOW,
      writeLine: (line) => output.push(line),
      fetchImplementation: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(exitCode).toBe(1);
    expect(output).toContain("  [FAIL] offline");
  });

  it("rejects Serial metadata before attempting the live form GET", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-form-release-serial-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "config"));
    const formal = config();
    await writeFile(join(root, "config", "production.json"), JSON.stringify({
      ...formal,
      protocolVersion: "serial-form-test-v1",
      device: { ...formal.device, mode: "serial", serialPath: "COM3" },
      formAudit: { ...formal.formAudit!, protocolVersion: "serial-form-test-v1" },
    }), "utf8");
    let requestCount = 0;
    const exitCode = await runReleaseFormVerification({
      args: ["--config", "config/production.json"],
      rootDirectory: root,
      now: AUDIT_NOW,
      writeLine: () => undefined,
      fetchImplementation: (async () => {
        requestCount += 1;
        return new Response();
      }) as typeof fetch,
    });
    expect(exitCode).toBe(1);
    expect(requestCount).toBe(0);
  });

});
