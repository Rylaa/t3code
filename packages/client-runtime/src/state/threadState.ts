import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * Progressive history cursor for bounded hydration. Absent/cleared on full
   * snapshot paths. Errors here are thread/history-local and must not be
   * promoted into the environment disconnect path.
   */
  readonly history: ThreadHistoryMeta;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  history: EMPTY_THREAD_HISTORY_META,
};

export interface ThreadLoadFailure {
  readonly threadKey: string;
  readonly message: string;
}

/**
 * Keeps a thread's last load failure until messages arrive. Each retry clears the
 * runtime error while it runs, which would otherwise flip the view back to loading
 * and paint the previous thread's timeline in its place.
 */
export function latchThreadLoadFailure(
  latched: ThreadLoadFailure | null,
  threadKey: string,
  error: string | null,
): ThreadLoadFailure | null {
  if (error === null || (latched?.threadKey === threadKey && latched.message === error)) {
    return latched;
  }
  return { threadKey, message: error };
}
