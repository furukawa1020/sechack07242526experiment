import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, statfs, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { loadExperimentConfig } from "../src/shared/config-loader.js";
import {
  assessFormAudit,
  STUDY_FORM_URL,
} from "../src/shared/form-audit.js";
import {
  formatConfigError,
  type ExperimentConfig,
} from "../src/shared/schemas.js";
import { ExperimentLogger } from "../src/server/logging/experiment-log.js";

const DEFAULT_CONFIG_PATH = "config/experiment.json";
const MINIMUM_FREE_BYTES = 1_073_741_824n;

export interface PreflightArguments {
  readonly allowMock: boolean;
  readonly help: boolean;
  readonly configPath?: string;
}

export interface PreflightEnvironment {
  readonly EXPERIMENT_CONFIG_PATH?: string;
  readonly DATA_DIRECTORY?: string;
  readonly [name: string]: string | undefined;
}

export interface GateCheck {
  readonly name: string;
  readonly status: "pass" | "warning" | "fail";
  readonly detail: string;
}

export interface PreflightReport {
  readonly mode: "production" | "development-mock";
  readonly configPath: string;
  readonly configHash: string;
  readonly configFileHash: string;
  readonly protocolVersion: string;
  readonly researchIdPattern: string;
  readonly deviceMode: ExperimentConfig["device"]["mode"];
  readonly serialPath: string;
  readonly baudRate: number;
  readonly ackTimeout: number;
  readonly allowMockInProduction: boolean;
  readonly fixedScore: number;
  readonly fixedLabel: string;
  readonly pufferLevel: number;
  readonly formUrl: string;
  readonly formAuditStatus: "GO" | "NO-GO" | "MISSING";
  readonly formAuditProtocolVersion: string;
  readonly formAuditFormUrl: string;
  readonly formAuditAuditedOn: string | null;
  readonly formAuditContentSha256: string;
  readonly formAuditTwoPersonVerified: boolean;
  readonly bindHost: string;
  readonly port: number;
  readonly allowLan: boolean;
  readonly allowExternalRuntimeRequests: boolean;
  readonly logPath: string;
  readonly logSessionCount: number;
  readonly availableBytes: bigint;
  readonly checks: readonly GateCheck[];
}

export interface CollectPreflightOptions {
  readonly rootDirectory?: string;
  readonly configPath?: string;
  readonly dataDirectoryOverride?: string;
  readonly allowMock?: boolean;
}

export interface RunPreflightOptions {
  readonly args?: readonly string[];
  readonly rootDirectory?: string;
  readonly environment?: PreflightEnvironment;
  readonly writeLine?: (line: string) => void;
}

function usage(): readonly string[] {
  return Object.freeze([
    "Usage: npm run preflight -- [--config <config path>] [--allow-mock]",
    "",
    "Options:",
    "  --config <path>  config/ 内の設定ファイルを指定します。",
    "  --allow-mock     開発用Mock確認として実行します（本番承認には使えません）。",
    "  --help           このヘルプを表示します。",
  ]);
}

export function parsePreflightArguments(args: readonly string[]): PreflightArguments {
  let allowMock = false;
  let help = false;
  let configPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--allow-mock") {
      allowMock = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--config") {
      if (configPath !== undefined) {
        throw new Error("--config may only be specified once.");
      }
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error("--config requires a path.");
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--config=")) {
      if (configPath !== undefined) {
        throw new Error("--config may only be specified once.");
      }
      const value = argument.slice("--config=".length);
      if (value.length === 0) {
        throw new Error("--config requires a path.");
      }
      configPath = value;
      continue;
    }
    throw new Error(`Unknown option: ${argument ?? "(missing)"}`);
  }

  return Object.freeze({
    allowMock,
    help,
    ...(configPath === undefined ? {} : { configPath }),
  });
}

export function isApprovedGoogleFormsUrl(value: string): boolean {
  if (value.length === 0) return false;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
    ) {
      return false;
    }
    if (parsed.hostname === "forms.gle") {
      return parsed.pathname !== "/" && parsed.pathname.length > 1;
    }
    return parsed.hostname === "docs.google.com"
      && parsed.pathname.startsWith("/forms/")
      && parsed.pathname.length > "/forms/".length;
  } catch {
    return false;
  }
}

export function isWindowsComPath(value: string): boolean {
  return /^(?:COM[1-9][0-9]*|\\\\\.\\COM[1-9][0-9]*)$/iu.test(value.trim());
}

export function evaluatePreflightGates(
  config: ExperimentConfig,
  allowMock: boolean,
  now = new Date(),
): readonly GateCheck[] {
  const checks: GateCheck[] = [];
  const production = !allowMock;

  if (production) {
    checks.push({
      name: "device.mode",
      status: config.device.mode === "serial" ? "pass" : "fail",
      detail: config.device.mode === "serial"
        ? "Serial実機モードです。"
        : "本番ではSerial実機モードが必須です。",
    });
  } else {
    checks.push({
      name: "device.mode",
      status: config.device.mode === "mock" ? "warning" : "pass",
      detail: config.device.mode === "mock"
        ? "開発用Mock確認です。本番承認には使用できません。"
        : "Serial実機モードを開発ゲートで確認しています。",
    });
  }

  if (config.device.mode === "serial" || production) {
    checks.push({
      name: "device.serialPath",
      status: isWindowsComPath(config.device.serialPath) ? "pass" : "fail",
      detail: isWindowsComPath(config.device.serialPath)
        ? "Windows COMポート形式です。"
        : "本番のserialPathにはCOM1以上（または \\\\.\\COM10 形式）が必要です。",
    });
  } else {
    checks.push({
      name: "device.serialPath",
      status: "warning",
      detail: "MockモードのためCOMポート確認を省略しました。",
    });
  }

  checks.push({
    name: "device.allowMockInProduction",
    status: config.device.allowMockInProduction ? "fail" : "pass",
    detail: config.device.allowMockInProduction
      ? "allowMockInProductionはfalseでなければなりません。"
      : "本番Mock許可は無効です。",
  });

  const approvedFormUrl = isApprovedGoogleFormsUrl(config.formUrl);
  const expectedFormUrl = config.formUrl === STUDY_FORM_URL;
  checks.push({
    name: "formUrl",
    status: approvedFormUrl && expectedFormUrl ? "pass" : production ? "fail" : "warning",
    detail: approvedFormUrl && expectedFormUrl
      ? "指定された研究用Google Forms URLと完全一致しています。"
      : production
        ? `本番ではformUrlを${STUDY_FORM_URL}と完全一致させる必要があります。`
        : "開発確認のため、指定フォームURLとの不一致または未設定を警告扱いにしました。",
  });

  const formAudit = assessFormAudit(config, now);
  checks.push({
    name: "formAudit",
    status: formAudit.approved ? "pass" : production ? "fail" : "warning",
    detail: formAudit.approved
      ? `フォーム監査のGO、二名確認、設定との一致、有効期限内（${String(formAudit.ageDays)}日前）を確認しました。`
      : production
        ? `本番フォーム監査ゲートを通過できません（${formAudit.issues.join(", ")}）。`
        : "フォーム監査は未承認です。開発用Mock確認には影響しませんが、本番リリースは生成できません。",
  });

  checks.push({
    name: "network.allowExternalRuntimeRequests",
    status: config.network.allowExternalRuntimeRequests ? "fail" : "pass",
    detail: config.network.allowExternalRuntimeRequests
      ? "外部ランタイム通信を許可してはなりません。"
      : "外部ランタイム通信は禁止されています。",
  });

  return Object.freeze(checks);
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (
      pathFromParent !== ".."
      && !pathFromParent.startsWith(`..${sep}`)
      && !isAbsolute(pathFromParent)
    );
}

export function resolveLogPath(
  rootDirectory: string,
  configuredDirectory: string,
): { readonly path: string; readonly safe: boolean } {
  const dataRoot = resolve(rootDirectory, "data");
  const logPath = resolve(rootDirectory, configuredDirectory);
  return Object.freeze({
    path: logPath,
    safe: isInside(dataRoot, logPath),
  });
}

export async function collectPreflightReport(
  options: CollectPreflightOptions = {},
): Promise<PreflightReport> {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const allowMock = options.allowMock ?? false;
  const loaded = await loadExperimentConfig(
    options.configPath ?? DEFAULT_CONFIG_PATH,
    { rootDirectory, production: false },
  );
  const config = loaded.config;
  const resolvedLog = resolveLogPath(
    rootDirectory,
    options.dataDirectoryOverride ?? config.logging.directory,
  );
  const dataRoot = resolve(rootDirectory, "data");
  const fileSystem = await statfs(dataRoot, { bigint: true });
  const availableBytes = fileSystem.bavail * fileSystem.bsize;
  const configFileHash = createHash("sha256")
    .update(await readFile(loaded.path))
    .digest("hex");
  let logDirectoryCheck: GateCheck;
  let logSessionCount = 0;
  if (!resolvedLog.safe) {
    logDirectoryCheck = {
      name: "logging.directory",
      status: "fail",
      detail: "ログ保存先はリポジトリのdata/内でなければなりません。",
    };
  } else {
    const probePath = resolve(resolvedLog.path, `.preflight-${randomUUID()}`);
    try {
      await mkdir(resolvedLog.path, { recursive: true, mode: 0o700 });
      const dataRootStat = await lstat(dataRoot);
      const logDirectoryStat = await lstat(resolvedLog.path);
      if (dataRootStat.isSymbolicLink() || logDirectoryStat.isSymbolicLink()) {
        throw new Error("data/またはログ保存先がシンボリックリンク／junctionです。");
      }
      const [realDataRoot, realLogDirectory] = await Promise.all([
        realpath(dataRoot),
        realpath(resolvedLog.path),
      ]);
      if (!isInside(realDataRoot, realLogDirectory)) {
        throw new Error("ログ保存先が実体パス上でdata/の外へ出ています。");
      }
      const handle = await open(probePath, "wx", 0o600);
      try {
        await handle.writeFile("preflight\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      logDirectoryCheck = {
        name: "logging.directory",
        status: "pass",
        detail: "ログ保存先はdata/内の通常ディレクトリで、書込みと同期を確認しました。",
      };
    } catch (error) {
      logDirectoryCheck = {
        name: "logging.directory",
        status: "fail",
        detail: `ログ保存先の安全な書込みを確認できません: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    } finally {
      try {
        await unlink(probePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logDirectoryCheck = {
            name: "logging.directory",
            status: "fail",
            detail: "ログ保存先の検査用ファイルを削除できませんでした。",
          };
        }
      }
    }
  }
  const cloudSyncPath = /(?:^|[\\/])(?:OneDrive|Dropbox|Google Drive)(?:[\\/]|$)/iu.test(rootDirectory);
  let logIntegrityCheck: GateCheck;
  if (logDirectoryCheck.status === "pass") {
    try {
      const summaries = await new ExperimentLogger({ directory: resolvedLog.path }).listSessionSummaries();
      logSessionCount = summaries.length;
      logIntegrityCheck = {
        name: "logging.integrity",
        status: "pass",
        detail: `${String(logSessionCount)}件のセッションログを検証しました。`,
      };
    } catch (error) {
      logIntegrityCheck = {
        name: "logging.integrity",
        status: "fail",
        detail: `既存ログを安全に読み取れません: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  } else {
    logIntegrityCheck = {
      name: "logging.integrity",
      status: "fail",
      detail: "ログ保存先を検証できないため、既存ログの整合性を確認できません。",
    };
  }
  const checks = [
    ...evaluatePreflightGates(config, allowMock),
    logDirectoryCheck,
    logIntegrityCheck,
    {
      name: "logging.cloudSyncPath",
      status: cloudSyncPath ? "fail" : "pass",
      detail: cloudSyncPath
        ? "リリース先が既知のクラウド同期ディレクトリ内です。"
        : "リリース先は既知のクラウド同期パスではありません。",
    } satisfies GateCheck,
    {
      name: "disk.freeSpace",
      status: availableBytes >= MINIMUM_FREE_BYTES ? "pass" : "fail",
      detail: availableBytes >= MINIMUM_FREE_BYTES
        ? "ログ保存先ボリュームに1 GiB以上の空き容量があります。"
        : "ログ保存先ボリュームの空き容量が1 GiB未満です。",
    } satisfies GateCheck,
  ];

  return Object.freeze({
    mode: allowMock ? "development-mock" : "production",
    configPath: loaded.path,
    configHash: loaded.configHash,
    configFileHash,
    protocolVersion: config.protocolVersion,
    researchIdPattern: config.researchIdPattern,
    deviceMode: config.device.mode,
    serialPath: config.device.serialPath,
    baudRate: config.device.baudRate,
    ackTimeout: config.device.ackTimeout,
    allowMockInProduction: config.device.allowMockInProduction,
    fixedScore: config.fixedState.score,
    fixedLabel: config.fixedState.label,
    pufferLevel: config.fixedState.pufferLevel,
    formUrl: config.formUrl,
    formAuditStatus: config.formAudit?.status ?? "MISSING",
    formAuditProtocolVersion: config.formAudit?.protocolVersion ?? "",
    formAuditFormUrl: config.formAudit?.formUrl ?? "",
    formAuditAuditedOn: config.formAudit?.auditedOn ?? null,
    formAuditContentSha256: config.formAudit?.contentSha256 ?? "",
    formAuditTwoPersonVerified: config.formAudit?.twoPersonVerified ?? false,
    bindHost: config.bindHost,
    port: config.port,
    allowLan: config.network.allowLan,
    allowExternalRuntimeRequests: config.network.allowExternalRuntimeRequests,
    logPath: resolvedLog.path,
    logSessionCount,
    availableBytes,
    checks: Object.freeze(checks),
  });
}

export function formatByteCount(bytes: bigint): string {
  const units = [
    { label: "PiB", size: 1_125_899_906_842_624n },
    { label: "TiB", size: 1_099_511_627_776n },
    { label: "GiB", size: 1_073_741_824n },
    { label: "MiB", size: 1_048_576n },
    { label: "KiB", size: 1_024n },
  ] as const;
  const unit = units.find((candidate) => bytes >= candidate.size);
  if (unit === undefined) return `${bytes.toString()} B`;
  const whole = bytes / unit.size;
  const fraction = ((bytes % unit.size) * 100n) / unit.size;
  return `${whole.toString()}.${fraction.toString().padStart(2, "0")} ${unit.label}`;
}

export function renderPreflightReport(
  report: PreflightReport,
  writeLine: (line: string) => void,
): void {
  writeLine(`SecHack365 preflight: ${report.mode === "production" ? "本番ゲート" : "開発用Mock確認"}`);
  writeLine("");
  writeLine("設定情報");
  writeLine(`  設定パス: ${report.configPath}`);
  writeLine(`  設定ファイルSHA-256: ${report.configFileHash}`);
  writeLine(`  設定内容SHA-256: ${report.configHash}`);
  writeLine(`  protocolVersion: ${report.protocolVersion}`);
  writeLine(`  ID形式: ${report.researchIdPattern}`);
  writeLine(`  device mode: ${report.deviceMode}`);
  writeLine(`  serialPath: ${report.serialPath === "" ? "(未設定)" : report.serialPath}`);
  writeLine(`  baudRate: ${report.baudRate}`);
  writeLine(`  ACK timeout: ${report.ackTimeout} ms`);
  writeLine(`  allowMockInProduction: ${String(report.allowMockInProduction)}`);
  writeLine(`  固定状態: score=${report.fixedScore}, label=${report.fixedLabel}, pufferLevel=${report.pufferLevel}`);
  writeLine(`  Google Forms URL: ${report.formUrl === "" ? "(未設定)" : report.formUrl}`);
  writeLine(`  フォーム監査: ${report.formAuditStatus}`);
  writeLine(`  監査対象protocolVersion: ${report.formAuditProtocolVersion === "" ? "(未設定)" : report.formAuditProtocolVersion}`);
  writeLine(`  監査対象URL: ${report.formAuditFormUrl === "" ? "(未設定)" : report.formAuditFormUrl}`);
  writeLine(`  監査日: ${report.formAuditAuditedOn ?? "(未設定)"}`);
  writeLine(`  公開内容SHA-256: ${report.formAuditContentSha256 === "" ? "(未設定)" : report.formAuditContentSha256}`);
  writeLine(`  二名確認: ${String(report.formAuditTwoPersonVerified)}`);
  writeLine(`  bind: ${report.bindHost}:${report.port}`);
  writeLine(`  allowLan: ${String(report.allowLan)}`);
  writeLine(`  allowExternalRuntimeRequests: ${String(report.allowExternalRuntimeRequests)}`);
  writeLine(`  ログ保存先: ${report.logPath}`);
  writeLine(`  検証済みセッションログ: ${String(report.logSessionCount)}件`);
  writeLine(`  空き容量: ${formatByteCount(report.availableBytes)} (${report.availableBytes.toString()} bytes)`);
  writeLine("");
  writeLine("ゲート判定");
  for (const check of report.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warning" ? "WARN" : "FAIL";
    writeLine(`  [${marker}] ${check.name}: ${check.detail}`);
  }
  writeLine("");
  const failureCount = report.checks.filter((check) => check.status === "fail").length;
  writeLine(failureCount === 0
    ? "結果: PASS"
    : `結果: FAIL (${failureCount}件。本番を開始しないでください)`);
}

export async function runPreflight(options: RunPreflightOptions = {}): Promise<number> {
  const writeLine = options.writeLine ?? console.info;
  try {
    const parsed = parsePreflightArguments(options.args ?? process.argv.slice(2));
    if (parsed.help) {
      for (const line of usage()) writeLine(line);
      return 0;
    }
    const environment = options.environment ?? process.env;
    const report = await collectPreflightReport({
      ...(options.rootDirectory === undefined ? {} : { rootDirectory: options.rootDirectory }),
      configPath: parsed.configPath
        ?? environment.EXPERIMENT_CONFIG_PATH
        ?? DEFAULT_CONFIG_PATH,
      ...(environment.DATA_DIRECTORY === undefined
        ? {}
        : { dataDirectoryOverride: environment.DATA_DIRECTORY }),
      allowMock: parsed.allowMock,
    });
    renderPreflightReport(report, writeLine);
    return report.checks.some((check) => check.status === "fail") ? 1 : 0;
  } catch (error) {
    writeLine("結果: FAIL (点検を完了できませんでした。本番を開始しないでください)");
    for (const message of formatConfigError(error)) {
      writeLine(`  [FAIL] ${message}`);
    }
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runPreflight();
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined
  && pathToFileURL(resolve(entryPath)).href === import.meta.url
) {
  void main();
}
