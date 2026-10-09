import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

export type ThreadSyncPhase = "loading" | "syncing";

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
}): ThreadSyncPhase | null {
  if (!input.shellExists) {
    return null;
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      return input.detailExists ? "syncing" : "loading";
    case "deleted":
    case "live":
      return null;
  }
}

export function threadSyncLabel(phase: ThreadSyncPhase): string {
  return phase === "loading" ? "Loading messages..." : "Syncing messages...";
}

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
