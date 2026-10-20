import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import {
  isSidebarSubagentThread,
  resolveSidebarThreadStatus,
  sortThreadsForSidebar,
} from "../components/Sidebar.logic";
import { focusProjectKey } from "./focus.logic";

function waitingOnUser(thread: EnvironmentThreadShell): boolean {
  const status = resolveSidebarThreadStatus(thread);
  return status === "input" || status === "approval";
}

/**
 * Threads of focused projects move to the Focus section, waiting-on-you first.
 * Archived, subagent, settled and snoozed threads keep their usual place.
 */
export function splitFocusThreads(
  threads: readonly EnvironmentThreadShell[],
  focusProjectKeys: ReadonlySet<string>,
  now: string,
): {
  readonly focusThreads: readonly EnvironmentThreadShell[];
  readonly otherThreads: readonly EnvironmentThreadShell[];
} {
  if (focusProjectKeys.size === 0) return { focusThreads: [], otherThreads: threads };
  const isFocused = (thread: EnvironmentThreadShell) =>
    focusProjectKeys.has(focusProjectKey(thread.environmentId, thread.projectId)) &&
    thread.archivedAt === null &&
    !isSidebarSubagentThread(thread) &&
    thread.settledOverride !== "settled" &&
    !effectiveSnoozed(thread, { now });
  return {
    focusThreads: sortThreadsForSidebar(threads.filter(isFocused)).toSorted(
      (left, right) => Number(waitingOnUser(right)) - Number(waitingOnUser(left)),
    ),
    otherThreads: threads.filter((thread) => !isFocused(thread)),
  };
}
