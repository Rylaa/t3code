import {
  formatSubagentDisplayTitle,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { WorkflowAgentCounts } from "@t3tools/client-runtime/state/subagent-workflow";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";

const PROMPT_TITLE_LIMIT = 80;

export type SubagentRowTone = "working" | "completed" | "failed" | "stopped";

export interface SubagentRowPresentation {
  readonly title: string;
  readonly detail: string | null;
  readonly statusLabel: string;
  readonly tone: SubagentRowTone;
  readonly live: boolean;
  readonly canOpenThread: boolean;
}

function rowTitle(subagent: Pick<OrchestrationV2Subagent, "title" | "prompt">): string {
  const title = subagent.title?.trim();
  if (title) return formatSubagentDisplayTitle(title);
  const prompt = subagent.prompt.trim();
  if (prompt.length === 0) return "Subagent";
  return prompt.length > PROMPT_TITLE_LIMIT
    ? `${prompt.slice(0, PROMPT_TITLE_LIMIT - 3)}...`
    : prompt;
}

function rowTone(status: OrchestrationV2Subagent["status"]): SubagentRowTone {
  if (isActiveSubagentStatus(status)) return "working";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

function rowStatusLabel(status: OrchestrationV2Subagent["status"]): string {
  switch (status) {
    case "pending":
    case "running":
      return "Working";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}

export function resolveSubagentRowPresentation(
  subagent: Pick<
    OrchestrationV2Subagent,
    "title" | "prompt" | "status" | "progress" | "result" | "childThreadId"
  >,
): SubagentRowPresentation {
  const live = isActiveSubagentStatus(subagent.status);
  return {
    title: rowTitle(subagent),
    detail: subagentDetailPreview(subagent),
    statusLabel: rowStatusLabel(subagent.status),
    tone: rowTone(subagent.status),
    live,
    canOpenThread: subagent.childThreadId !== null,
  };
}

/**
 * A workflow's totals line above its progress bar, e.g. "3/12 agents · 1.23M tok · 273 tools".
 * Null without run totals, so servers that report none show no line, as before.
 */
export function workflowTotalsLine(
  counts: Pick<WorkflowAgentCounts, "settled" | "total">,
  stats: string | null,
): string | null {
  if (stats === null) return null;
  return counts.total === 0 ? stats : `${counts.settled}/${counts.total} agents · ${stats}`;
}
