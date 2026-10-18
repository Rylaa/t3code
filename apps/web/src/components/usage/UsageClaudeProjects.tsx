import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { mergeProjectUsage, type EnvironmentUsage } from "@t3tools/shared/usageMerge";
import {
  formatDateTimeShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import {
  claudeWeeklyProjectsInput,
  resolveClaudeWeeklyWindow,
  weeklyProjectRows,
  type UsageProjectRoot,
} from "@t3tools/shared/usageProjects";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { useUsage } from "../../state/usage";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { PROVIDER_PRESENTATION } from "./usageProviders";

/** Enough rows to answer "where did the week go"; the long tail is one click away. */
const COLLAPSED_ROWS = 8;

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * Claude Code usage per project over the current weekly limit window, with
 * each project's estimated part of the weekly limit.
 */
export function UsageClaudeProjects({
  selectedEnvironmentIds,
  providers,
  now,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  /** Providers of the selected environments, for Claude's reported week. */
  readonly providers: readonly ServerProvider[];
  readonly now: number;
}) {
  const week = resolveClaudeWeeklyWindow(providers, now);
  const input = claudeWeeklyProjectsInput(week, now, TIME_ZONE);
  const usage = useUsage(input, selectedEnvironmentIds);
  const projects = useProjects();
  const threads = useThreadShells();
  const titles = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const roots: UsageProjectRoot[] = projects.map((project) => ({
    path: project.workspaceRoot,
    name: project.title,
  }));
  for (const thread of threads) {
    const name = titles.get(`${thread.environmentId}:${thread.projectId}`);
    if (thread.worktreePath !== null && name !== undefined) {
      roots.push({ path: thread.worktreePath, name });
    }
  }
  const answered = usage.selectedEnvironments.flatMap(
    ({ environmentId, label, summary }): EnvironmentUsage[] =>
      summary === null ? [] : [{ environmentId, label, summary }],
  );
  const rows = weeklyProjectRows(mergeProjectUsage(answered), roots, week.usedPercent);
  const reportsProjects = answered.some(({ summary }) => summary.projects !== undefined);
  const peak = rows[0]?.share ?? 0;
  const [expanded, setExpanded] = useState(false);
  const shownRows = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">Claude Code by project</h2>
        <p className="text-xs text-muted-foreground">
          {week.resetsAtMs === null
            ? "Last 7 days. The signed-in Claude account does not report a weekly limit, so shares are of this usage."
            : `This week, until it resets ${formatDateTimeShort(new Date(week.resetsAtMs).toISOString())}. ${formatPercent((week.usedPercent ?? 0) / 100, 0)} of the weekly limit is used; each project's part is estimated from its API-equivalent cost.`}
        </p>
      </div>
      {usage.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : answered.length > 0 && !reportsProjects ? (
        <p className="text-sm text-muted-foreground">
          Update T3 Code on the selected environments to see usage by project.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Claude Code usage in this window.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {shownRows.map((row) => (
              <li key={row.name} className="flex flex-col gap-1.5">
                <div className="flex min-w-0 items-baseline gap-3">
                  {/* A folder no project or worktree in T3 Code contains shows its encoded name, muted. */}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm font-medium",
                      row.known ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {row.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatTokens(row.totalTokens)} tokens · {formatUsd(row.costUsd)}
                  </span>
                  <span className="w-20 shrink-0 text-end text-sm font-semibold text-foreground tabular-nums">
                    {row.limitPercent === null
                      ? formatPercent(row.share)
                      : `≈${formatPercent(row.limitPercent / 100)}`}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${peak > 0 ? (row.share / peak) * 100 : 0}%`,
                      backgroundColor: PROVIDER_PRESENTATION.claude.color,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
          {rows.length > COLLAPSED_ROWS ? (
            <Button
              variant="ghost-muted"
              size="xs"
              className="self-start"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show fewer" : `Show all ${rows.length} projects`}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
