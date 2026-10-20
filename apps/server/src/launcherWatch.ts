import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);

// Sampled when this module loads, before config resolution and the bootstrap
// read, so a launcher that dies during startup is still noticed.
const startupParentPid = process.ppid;

/**
 * Completes when the process that launched this backend is gone.
 *
 * A desktop-launched backend reads its bootstrap envelope once and never looks
 * at its launcher again. When the launcher dies without a graceful stop, the
 * backend would keep serving and holding its ownership lock while no desktop
 * can reach it, and every replacement launch is refused. Any change of parent
 * counts rather than only a move to pid 1. A backend that already starts under
 * init has no launcher to lose, so it is not watched.
 */
export const awaitLauncherLoss = (options?: {
  readonly launcherPid?: number;
  readonly getParentPid?: () => number;
  readonly interval?: Duration.Input;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const launcherPid = options?.launcherPid ?? startupParentPid;
    const getParentPid = options?.getParentPid ?? (() => process.ppid);
    const interval = options?.interval ?? DEFAULT_POLL_INTERVAL;
    if (launcherPid <= 1) return yield* Effect.never;
    const poll: Effect.Effect<void> = Effect.suspend(() => {
      const parentPid = getParentPid();
      return parentPid === launcherPid
        ? Effect.flatMap(Effect.sleep(interval), () => poll)
        : Effect.logWarning("desktop launcher is gone; shutting down the backend", {
            launcherPid,
            parentPid,
          });
    });
    return yield* poll;
  });
