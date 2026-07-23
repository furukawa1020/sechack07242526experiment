import {
  hashExperimentConfig,
  hashProductionCriticalConfig,
  loadExperimentConfig,
} from "./config-loader.js";
import { assessProductionPolicy } from "./production-policy.js";
import {
  formatConfigError,
  parseExperimentConfig,
  SCREEN_PROTOCOL_VERSION,
  type ExperimentConfig,
} from "./schemas.js";

export const FORMAL_SCREEN_PROTOCOL_VERSION = SCREEN_PROTOCOL_VERSION;
export const FORMAL_PRODUCTION_CONFIG_PATH = "config/experiment.json";
export const FORMAL_PRODUCTION_BIND_HOST = "127.0.0.1";
export const FORMAL_PRODUCTION_PORT = 4_173;

/**
 * Formal production uses the shared config shape plus the closed production
 * policy. Approval material is intentionally absent: the application neither
 * stores nor verifies it in external-compliance mode.
 */
export type FormalProductionConfig = ExperimentConfig;

export interface FormalLoadedExperimentConfig {
  readonly config: FormalProductionConfig;
  readonly configHash: string;
  readonly configFileHash: string;
  readonly sourceBytes: Uint8Array;
  readonly path: string;
}

export interface LoadFormalProductionConfigOptions {
  readonly rootDirectory?: string;
  readonly allowedDirectory?: string;
  readonly currentDate?: Date;
}

function productionPolicyErrors(config: ExperimentConfig): readonly string[] {
  const assessment = assessProductionPolicy(config);
  return Object.freeze([
    ...assessment.deviceIssues,
    ...assessment.protocolIssues,
    ...assessment.formIssues,
    ...assessment.networkIssues,
    ...assessment.complianceIssues,
  ]);
}

export function parseFormalProductionConfig(input: unknown): FormalProductionConfig {
  const config = parseExperimentConfig(input);
  const issues = productionPolicyErrors(config);
  if (issues.length > 0) {
    throw new Error(`Formal production config rejected (${issues.join(", ")}).`);
  }
  return config;
}

export function formatFormalProductionConfigError(error: unknown): readonly string[] {
  return formatConfigError(error);
}

export function hashFormalProductionConfig(config: FormalProductionConfig): string {
  return hashExperimentConfig(config);
}

export function hashFormalProductionCriticalConfig(config: FormalProductionConfig): string {
  return hashProductionCriticalConfig(config);
}

/**
 * Kept as a compatibility surface for schema-v4 manifests. External
 * compliance never packages approval evidence, so the value is always null.
 */
export function hashFormalProductionGoEvidence(
  _config: FormalProductionConfig,
): null {
  return null;
}

export async function loadFormalProductionConfig(
  requestedPath = FORMAL_PRODUCTION_CONFIG_PATH,
  options: LoadFormalProductionConfigOptions = {},
): Promise<FormalLoadedExperimentConfig> {
  const loaded = await loadExperimentConfig(requestedPath, {
    ...(options.rootDirectory === undefined
      ? {}
      : { rootDirectory: options.rootDirectory }),
    ...(options.allowedDirectory === undefined
      ? {}
      : { allowedDirectory: options.allowedDirectory }),
    production: true,
    ...(options.currentDate === undefined
      ? {}
      : { currentDate: options.currentDate }),
  });
  return Object.freeze({
    config: loaded.config,
    configHash: loaded.configHash,
    configFileHash: loaded.configFileHash,
    sourceBytes: loaded.sourceBytes,
    path: loaded.path,
  });
}
