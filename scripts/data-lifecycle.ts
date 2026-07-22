import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createLifecyclePlan,
  createRetentionReport,
} from "../src/server/logging/data-lifecycle.js";

type LifecycleCommand = "preview" | "retention-report";

export interface DataLifecycleArguments {
  readonly command?: LifecycleCommand;
  readonly help: boolean;
  readonly action?: "exclude" | "delete";
  readonly researchId?: string;
  readonly retentionDays?: number;
  readonly asOf?: string;
}

export interface RunDataLifecycleOptions {
  readonly args?: readonly string[];
  readonly repositoryRoot?: string;
  readonly now?: Date;
  readonly writeLine?: (line: string) => void;
}

function usage(): readonly string[] {
  return Object.freeze([
    "研究データのライフサイクル管理（対象は data/sessions の正式JSONLのみ）",
    "",
    "Preview (read-only):",
    "  npm run data:lifecycle -- preview --action exclude --research-id SH26-001",
    "  npm run data:lifecycle -- preview --action delete --research-id SH26-001",
    "",
    "Mutation commands are disabled. Exclusion/deletion requires a PI-approved external procedure.",
    "",
    "Retention report (read-only):",
    "  npm run data:lifecycle -- retention-report --retention-days 365 [--as-of YYYY-MM-DD]",
    "",
    "Googleフォームの回答は取得・変更しません。同じ研究用IDはフォーム管理者が手動照合します。",
  ]);
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function assignOnce(current: string | undefined, value: string, option: string): string {
  if (current !== undefined) throw new Error(`${option} may only be specified once.`);
  return value;
}

export function parseDataLifecycleArguments(args: readonly string[]): DataLifecycleArguments {
  let command: LifecycleCommand | undefined;
  let action: "exclude" | "delete" | undefined;
  let researchId: string | undefined;
  let retentionDays: number | undefined;
  let asOf: string | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument !== undefined && !argument.startsWith("--")) {
      if (command !== undefined) throw new Error("Only one lifecycle command may be specified.");
      if (!["preview", "retention-report"].includes(argument)) {
        throw new Error("Unknown lifecycle command.");
      }
      command = argument as LifecycleCommand;
      continue;
    }

    const equalsIndex = argument?.indexOf("=") ?? -1;
    const option = equalsIndex < 0 ? argument : argument?.slice(0, equalsIndex);
    const inlineValue = equalsIndex < 0 ? undefined : argument?.slice(equalsIndex + 1);
    const readValue = (): string => {
      if (inlineValue !== undefined) {
        if (inlineValue.length === 0) throw new Error(`${option ?? "option"} requires a value.`);
        return inlineValue;
      }
      const value = optionValue(args, index, option ?? "option");
      index += 1;
      return value;
    };

    switch (option) {
      case "--action": {
        const value = readValue();
        if (value !== "exclude" && value !== "delete") {
          throw new Error("--action must be exclude or delete.");
        }
        if (action !== undefined) throw new Error("--action may only be specified once.");
        action = value;
        break;
      }
      case "--research-id":
        researchId = assignOnce(researchId, readValue(), "--research-id");
        break;
      case "--retention-days": {
        if (retentionDays !== undefined) {
          throw new Error("--retention-days may only be specified once.");
        }
        retentionDays = Number(readValue());
        break;
      }
      case "--as-of":
        asOf = assignOnce(asOf, readValue(), "--as-of");
        break;
      default:
        throw new Error("Unknown lifecycle option.");
    }
  }

  if (help) return Object.freeze({ help: true, ...(command === undefined ? {} : { command }) });
  if (command === undefined) throw new Error("A lifecycle command is required.");
  if (command === "preview") {
    if (action === undefined || researchId === undefined) {
      throw new Error("preview requires --action and --research-id.");
    }
    if (
      retentionDays !== undefined
      || asOf !== undefined
    ) {
      throw new Error("preview accepts only --action and --research-id.");
    }
  } else {
    if (retentionDays === undefined) {
      throw new Error("retention-report requires --retention-days.");
    }
    if (
      action !== undefined
      || researchId !== undefined
    ) {
      throw new Error("retention-report received an option for another command.");
    }
  }

  return Object.freeze({
    command,
    help: false,
    ...(action === undefined ? {} : { action }),
    ...(researchId === undefined ? {} : { researchId }),
    ...(retentionDays === undefined ? {} : { retentionDays }),
    ...(asOf === undefined ? {} : { asOf }),
  });
}

export async function runDataLifecycle(options: RunDataLifecycleOptions = {}): Promise<number> {
  const writeLine = options.writeLine ?? console.info;
  try {
    const parsed = parseDataLifecycleArguments(options.args ?? process.argv.slice(2));
    if (parsed.help) {
      for (const line of usage()) writeLine(line);
      return 0;
    }
    const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
    let result: unknown;
    switch (parsed.command) {
      case "preview":
        result = await createLifecyclePlan({
          repositoryRoot,
          action: parsed.action as "exclude" | "delete",
          researchId: parsed.researchId as string,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        break;
      case "retention-report":
        result = await createRetentionReport({
          repositoryRoot,
          retentionDays: parsed.retentionDays as number,
          ...(parsed.asOf === undefined ? {} : { asOf: parsed.asOf }),
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        break;
      default:
        throw new Error("A lifecycle command is required.");
    }
    writeLine(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    writeLine(`結果: FAIL (${error instanceof Error ? error.message : "lifecycle operation failed"})`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runDataLifecycle();
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  void main();
}
