import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  fetchPublicFormAudit,
  type PublicFormAuditReport,
} from "./audit-public-form.js";
import { assessFormAudit, STUDY_FORM_URL } from "../src/shared/form-audit.js";
import {
  hashProductionCriticalConfig,
  loadExperimentConfig,
} from "../src/shared/config-loader.js";
import { assessProductionPolicy } from "../src/shared/production-policy.js";
import {
  formatConfigError,
  type ExperimentConfig,
} from "../src/shared/schemas.js";

const DEFAULT_CONFIG_PATH = "config/experiment.production.json";
const EXPECTED_FORM_ID =
  "1FAIpQLSea5PhAbtkSS_Pg-xL-O7scpRddMn5ReoKzgAt7lSE7GTlA9Q";
const EXPECTED_FORM_TITLE =
  "身体状態の外化デバイスがユーザの心理状態に及ぼす影響の評価｜研究説明・参加同意・アンケート";
const ADMINISTRATOR_ONLY_FINDING = "administrator-only-settings";
const REQUIRED_MACHINE_FINDING_IDS = Object.freeze([
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
]);

export interface ReleaseFormVerificationArguments {
  readonly configPath?: string;
  readonly help: boolean;
}

export interface ReleaseFormVerificationResult {
  readonly approved: boolean;
  readonly issues: readonly string[];
  readonly report: PublicFormAuditReport;
}

export interface VerifyReleaseFormOptions {
  readonly configPath?: string;
  readonly rootDirectory?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: Date;
}

export interface RunReleaseFormVerificationOptions extends VerifyReleaseFormOptions {
  readonly args?: readonly string[];
  readonly writeLine?: (line: string) => void;
}

function usage(): readonly string[] {
  return Object.freeze([
    "Usage: npm run verify:form-release -- [--config <config path>]",
    "",
    "Fetches the configured public Google Form with a read-only GET and verifies it for release.",
    "This command is a build/release gate; it is never part of experiment runtime traffic.",
  ]);
}

export function parseReleaseFormVerificationArguments(
  args: readonly string[],
): ReleaseFormVerificationArguments {
  let configPath: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--config") {
      if (configPath !== undefined) throw new Error("--config may only be specified once.");
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error("--config requires a path.");
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--config=")) {
      if (configPath !== undefined) throw new Error("--config may only be specified once.");
      const value = argument.slice("--config=".length);
      if (value.length === 0) throw new Error("--config requires a path.");
      configPath = value;
      continue;
    }
    throw new Error(`Unknown option: ${argument ?? "(missing)"}`);
  }
  return Object.freeze({ help, ...(configPath === undefined ? {} : { configPath }) });
}

export function isExpectedStudyFormFinalUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "docs.google.com"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.hash === ""
      && (parsed.search === "" || parsed.search === "?usp=send_form")
      && parsed.pathname === `/forms/d/e/${EXPECTED_FORM_ID}/viewform`;
  } catch {
    return false;
  }
}

export function assessReleaseFormVerification(
  config: ExperimentConfig,
  report: PublicFormAuditReport,
  now = new Date(),
): ReleaseFormVerificationResult {
  const issues: string[] = [];
  const productionPolicy = assessProductionPolicy(config, now, {
    criticalConfigSha256: hashProductionCriticalConfig(config),
  });
  for (const issue of productionPolicy.deviceIssues) {
    issues.push(`production-device-${issue}`);
  }
  for (const issue of productionPolicy.protocolIssues) {
    issues.push(`production-protocol-${issue}`);
  }
  for (const issue of productionPolicy.goEvidence.issues) {
    issues.push(`production-go-evidence-${issue}`);
  }
  for (const issue of assessFormAudit(config, now).issues) {
    issues.push(`form-audit-${issue}`);
  }
  if (config.formUrl !== STUDY_FORM_URL) issues.push("configured-short-url-mismatch");
  if (report.requestedUrl !== STUDY_FORM_URL || report.requestedUrl !== config.formUrl) {
    issues.push("requested-short-url-mismatch");
  }
  if (!isExpectedStudyFormFinalUrl(report.finalUrl)) issues.push("final-form-id-mismatch");
  if (report.title !== EXPECTED_FORM_TITLE) issues.push("form-title-mismatch");

  const machineFindings = report.findings.filter(
    (finding) => finding.id !== ADMINISTRATOR_ONLY_FINDING,
  );
  if (machineFindings.length === 0) issues.push("machine-findings-missing");
  const findingById = new Map(machineFindings.map((finding) => [finding.id, finding]));
  for (const requiredId of REQUIRED_MACHINE_FINDING_IDS) {
    const required = findingById.get(requiredId);
    if (required === undefined) {
      issues.push(`machine-finding-missing:${requiredId}`);
    } else if (required.status !== "pass") {
      issues.push(`machine-finding-not-pass:${requiredId}`);
    }
  }
  for (const finding of machineFindings) {
    if (
      finding.status !== "pass"
      && !REQUIRED_MACHINE_FINDING_IDS.some((requiredId) => requiredId === finding.id)
    ) {
      issues.push(`machine-finding-not-pass:${finding.id}`);
    }
  }
  for (const finding of report.findings) {
    if (finding.id === ADMINISTRATOR_ONLY_FINDING && finding.status === "fail") {
      issues.push(`machine-finding-not-pass:${finding.id}`);
    }
  }

  const recordedSha256 = config.formAudit?.contentSha256 ?? "";
  if (report.contentSha256 === "" || report.contentSha256 !== recordedSha256) {
    issues.push("payload-sha256-mismatch");
  }
  return Object.freeze({
    approved: issues.length === 0,
    issues: Object.freeze([...new Set(issues)]),
    report,
  });
}

export async function verifyReleaseForm(
  options: VerifyReleaseFormOptions = {},
): Promise<ReleaseFormVerificationResult> {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const now = options.now ?? new Date();
  const loaded = await loadExperimentConfig(
    options.configPath ?? DEFAULT_CONFIG_PATH,
    { rootDirectory, production: true, currentDate: now },
  );
  if (loaded.config.formUrl !== STUDY_FORM_URL) {
    throw new Error(`Production formUrl must exactly match ${STUDY_FORM_URL}.`);
  }
  const report = await fetchPublicFormAudit(
    loaded.config.formUrl,
    options.fetchImplementation ?? fetch,
  );
  return assessReleaseFormVerification(
    loaded.config,
    report,
    now,
  );
}

export function renderReleaseFormVerification(
  result: ReleaseFormVerificationResult,
  writeLine: (line: string) => void,
): void {
  writeLine("Googleフォーム本番リリース照合（読取り専用）");
  writeLine(`対象short URL: ${result.report.requestedUrl}`);
  writeLine(`最終URL: ${result.report.finalUrl}`);
  writeLine(`タイトル: ${result.report.title}`);
  writeLine(`公開payload SHA-256: ${result.report.contentSha256 || "(抽出失敗)"}`);
  writeLine("");
  for (const finding of result.report.findings) {
    const marker = finding.status === "pass" ? "PASS" : finding.status === "warning" ? "WARN" : "FAIL";
    writeLine(`  [${marker}] ${finding.id}: ${finding.detail}`);
  }
  writeLine("");
  if (result.approved) {
    writeLine("結果: PASS（公開内容と承認済み本番設定が一致）");
    return;
  }
  for (const issue of result.issues) writeLine(`  [FAIL] ${issue}`);
  writeLine(`結果: FAIL (${String(result.issues.length)}件。本番リリースを生成しません)`);
}

export async function runReleaseFormVerification(
  options: RunReleaseFormVerificationOptions = {},
): Promise<number> {
  const writeLine = options.writeLine ?? console.info;
  try {
    const parsed = parseReleaseFormVerificationArguments(options.args ?? process.argv.slice(2));
    if (parsed.help) {
      for (const line of usage()) writeLine(line);
      return 0;
    }
    const result = await verifyReleaseForm({
      ...(parsed.configPath === undefined
        ? options.configPath === undefined ? {} : { configPath: options.configPath }
        : { configPath: parsed.configPath }),
      ...(options.rootDirectory === undefined ? {} : { rootDirectory: options.rootDirectory }),
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    renderReleaseFormVerification(result, writeLine);
    return result.approved ? 0 : 1;
  } catch (error) {
    writeLine("結果: FAIL (Googleフォーム本番リリース照合を完了できませんでした)");
    for (const message of formatConfigError(error)) writeLine(`  [FAIL] ${message}`);
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  process.exitCode = await runReleaseFormVerification();
}
