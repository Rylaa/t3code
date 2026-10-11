/**
 * The Skills & plugins sheet's own wording on top of the shared view-models
 * in `@t3tools/client-runtime/state/thread-extensions`.
 */
import {
  threadExtensionUsesLabel,
  type ThreadExtensionRow,
} from "@t3tools/client-runtime/state/thread-extensions";
import * as DateTime from "effect/DateTime";

import { relativeTime } from "../../lib/time";

/** "5m ago", or "just now" under a minute. */
export function lastUsedAgo(lastUsedAt: DateTime.Utc): string {
  const elapsed = relativeTime(DateTime.formatIso(lastUsedAt));
  return elapsed === "<1m" ? "just now" : `${elapsed} ago`;
}

/** A row's meta: "3 uses · 5m ago", or null for something never used. */
export function threadExtensionMetaLabel(
  row: Pick<ThreadExtensionRow, "count" | "lastUsedAt">,
): string | null {
  const uses = threadExtensionUsesLabel(row.count);
  if (uses === null || row.lastUsedAt === null) return uses;
  return `${uses} · ${lastUsedAgo(row.lastUsedAt)}`;
}
