export const BUILD_LOCK_ENVIRONMENT_VARIABLE: "SECHACK_BUILD_LOCK_TOKEN";

export interface BuildLock {
  readonly token: string;
  readonly owned: boolean;
  childEnvironment(baseEnvironment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  release(): Promise<void>;
}

export interface AcquireBuildLockOptions {
  readonly kind?: "build" | "release";
  readonly environment?: NodeJS.ProcessEnv;
  readonly waitMs?: number;
}

export function acquireBuildLock(
  rootDirectory: string,
  options?: AcquireBuildLockOptions,
): Promise<BuildLock>;
