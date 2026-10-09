// @effect-diagnostics globalDate:off -- The week is formatted into calendar days in the viewer's zone via Intl, like usageFormat.
/**
 * Claude Code usage per project over the current weekly limit window, and each
 * project's estimated share of that week's limit.
 *
 * Claude reports only how much of the week is used, not what used it. The
 * share is estimated by API-equivalent cost, which tracks how the limit counts
 * a model's tokens more closely than raw token counts do.
 *
 * @module usageProjects
 */
import { UsageDay, type ServerProvider, type UsageSummaryInput } from "@t3tools/contracts";

import type { MergedProjectUsage } from "./usageMerge.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const WEEK_MINS = 7 * 24 * 60;
/** Claude's all-model weekly allowance; model-specific weeks carry other ids. */
const CLAUDE_WEEKLY_WINDOW_ID = "seven_day";

export interface ClaudeWeeklyWindow {
  readonly startMs: number;
  /** Null when no Claude account reports its week; the window is then the last seven days. */
  readonly resetsAtMs: number | null;
  readonly usedPercent: number | null;
}

/** The freshest reported Claude week that has not reset yet, or the last seven days. */
export function resolveClaudeWeeklyWindow(
  providers: readonly ServerProvider[],
  nowMs: number,
): ClaudeWeeklyWindow {
  let best: { readonly checkedAtMs: number; readonly window: ClaudeWeeklyWindow } | null = null;
  for (const provider of providers) {
    if (provider.driver !== "claudeAgent" || provider.usageLimits === undefined) continue;
    const week = provider.usageLimits.windows.find(
      (window) => window.id === CLAUDE_WEEKLY_WINDOW_ID,
    );
    const resetsAtMs = week?.resetsAt === undefined ? Number.NaN : Date.parse(week.resetsAt);
    if (week === undefined || !(resetsAtMs > nowMs)) continue;
    const checkedAtMs = Date.parse(provider.usageLimits.checkedAt) || 0;
    if (best !== null && best.checkedAtMs >= checkedAtMs) continue;
    best = {
      checkedAtMs,
      window: {
        startMs: resetsAtMs - (week.windowDurationMins ?? WEEK_MINS) * MINUTE_MS,
        resetsAtMs,
        usedPercent: week.usedPercent,
      },
    };
  }
  if (best !== null) return best.window;
  // Hour-aligned so the request stays the same while the page is open.
  return {
    startMs: Math.floor(nowMs / HOUR_MS) * HOUR_MS - WEEK_MINS * MINUTE_MS,
    resetsAtMs: null,
    usedPercent: null,
  };
}

function dayInZone(ms: number, timeZone: string): UsageDay {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return UsageDay.make(format.format(new Date(ms)));
}

/** A day-resolution summary covering the week, with project totals from its start. */
export function claudeWeeklyProjectsInput(
  window: ClaudeWeeklyWindow,
  nowMs: number,
  timeZone: string,
): UsageSummaryInput {
  return {
    sinceDay: dayInZone(window.startMs, timeZone),
    untilDay: dayInZone(nowMs, timeZone),
    timeZone,
    resolution: "day",
    projectsSinceTime: new Date(window.startMs).toISOString(),
  };
}

/** The directory name Claude Code files a working directory's transcripts under. */
export function claudeProjectKey(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface UsageProjectRoot {
  /** A project's workspace root or one of its worktrees. */
  readonly path: string;
  readonly name: string;
}

export interface WeeklyProjectRow {
  readonly name: string;
  /** False when no known project or worktree contains the directory; `name` is then its key. */
  readonly known: boolean;
  readonly totalTokens: number;
  readonly costUsd: number;
  /** Fraction of the week's Claude usage. */
  readonly share: number;
  /** Estimated percent of the weekly limit, when the week's usage is known. */
  readonly limitPercent: number | null;
}

/**
 * The root containing a project key: the exact directory, or the longest root
 * whose key prefixes it (a subdirectory). Keys are lossy, so a sibling folder
 * that only extends a root's name (`app` and `app-v2`) can match that root
 * when it is not itself a known root.
 */
function rootFor(key: string, roots: readonly UsageProjectRoot[]): UsageProjectRoot | null {
  let best: { readonly root: UsageProjectRoot; readonly length: number } | null = null;
  for (const root of roots) {
    const rootKey = claudeProjectKey(root.path);
    if (key !== rootKey && !key.startsWith(`${rootKey}-`)) continue;
    if (best === null || rootKey.length > best.length) best = { root, length: rootKey.length };
  }
  return best?.root ?? null;
}

/** Claude rows grouped by project, largest share first. */
export function weeklyProjectRows(
  projects: readonly MergedProjectUsage[],
  roots: readonly UsageProjectRoot[],
  usedPercent: number | null,
): readonly WeeklyProjectRow[] {
  const groups = new Map<
    string,
    { name: string; known: boolean; totalTokens: number; costUsd: number }
  >();
  for (const project of projects) {
    if (project.provider !== "claude") continue;
    const root = rootFor(project.project, roots);
    const name = root?.name ?? project.project;
    const group = groups.get(name) ?? { name, known: root !== null, totalTokens: 0, costUsd: 0 };
    group.totalTokens += project.totalTokens;
    group.costUsd += project.costUsd;
    groups.set(name, group);
  }
  const rows = [...groups.values()];
  const totalCost = rows.reduce((sum, row) => sum + row.costUsd, 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  // Without prices every cost is zero; tokens are the next best weight.
  const weight = (row: (typeof rows)[number]) =>
    totalCost > 0 ? row.costUsd / totalCost : totalTokens > 0 ? row.totalTokens / totalTokens : 0;
  return rows
    .map((row) => {
      const share = weight(row);
      return {
        ...row,
        share,
        limitPercent: usedPercent === null ? null : share * usedPercent,
      };
    })
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name));
}
