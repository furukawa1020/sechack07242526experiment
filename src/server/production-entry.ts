import {
  startProductionReleaseCli as startVerifiedProductionRelease,
  type RunningExperimentServer,
} from "./index.js";

/**
 * The only callable export from dist-server/index.js.
 *
 * JavaScript callers may pass arguments to a zero-argument function, so this
 * wrapper deliberately forwards none of the source-only test seams.
 */
export function startProductionReleaseCli(): Promise<RunningExperimentServer> {
  return startVerifiedProductionRelease();
}
