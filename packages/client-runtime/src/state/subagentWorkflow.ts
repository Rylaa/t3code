/**
 * How web and mobile present a provider workflow carried on the subagent that
 * coordinates it: its agents grouped under their phases, and a compact count.
 */
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowAgent,
  type OrchestrationV2WorkflowPhase,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { formatTokens } from "@t3tools/shared/usageFormat";

export type WorkflowPhaseState = "pending" | "running" | "done";

export const WORKFLOW_PHASE_STATE_LABEL: Record<WorkflowPhaseState, string> = {
  pending: "Not started",
  running: "Running",
  done: "Done",
};

/**
 * A workflow agent's state in subagent status terms, which clients label and
 * color like any subagent. Cancelled is client-only: an agent a dead run left
 * unsettled.
 */
export type WorkflowAgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface PresentedWorkflowAgent extends OrchestrationV2WorkflowAgent {
  readonly status: WorkflowAgentStatus;
}

export interface PresentedWorkflow extends Omit<OrchestrationV2SubagentWorkflow, "agents"> {
  readonly agents: ReadonlyArray<PresentedWorkflowAgent>;
}

export interface WorkflowPhaseGroup {
  /** null groups agents whose phase the coordinator never announced. */
  readonly index: number | null;
  readonly title: string | null;
  /** The plan's one-line note on the phase, when the script declared one. */
  readonly detail: string | null;
  readonly state: WorkflowPhaseState;
  readonly agents: ReadonlyArray<PresentedWorkflowAgent>;
  /** How many of its agents are no longer at work. */
  readonly settled: number;
}

export interface WorkflowAgentCounts {
  readonly total: number;
  readonly settled: number;
  readonly running: number;
  readonly failed: number;
}

function isActiveWorkflowAgent(agent: PresentedWorkflowAgent): boolean {
  return agent.status === "pending" || agent.status === "running";
}

function phaseState(agents: ReadonlyArray<PresentedWorkflowAgent>): WorkflowPhaseState {
  if (agents.length === 0) return "pending";
  return agents.some(isActiveWorkflowAgent) ? "running" : "done";
}

/**
 * The workflow as clients present it. A run that is no longer active has no
 * agent at work, even when its last snapshot says otherwise: a provider that
 * died or a server restart ends the run without settling its agents. Those
 * agents drop their activity, as every settled agent does.
 */
export function presentedWorkflow(
  workflow: OrchestrationV2SubagentWorkflow,
  runActive: boolean,
): PresentedWorkflow {
  return {
    ...workflow,
    agents: workflow.agents.map((agent): PresentedWorkflowAgent => {
      const live = agent.state === "queued" || agent.state === "running";
      if (live && !runActive) {
        const { activity: _activity, ...rest } = agent;
        return { ...rest, status: "cancelled" };
      }
      return { ...agent, status: agent.state === "queued" ? "pending" : agent.state };
    }),
  };
}

/** The run's persisted script path, readable through orchestration.getWorkflowScript. */
export function workflowScriptPath(workflow: OrchestrationV2SubagentWorkflow): string | null {
  return workflow.runHandles?.scriptPath ?? null;
}

function phaseGroup(
  phase: OrchestrationV2WorkflowPhase | null,
  agents: ReadonlyArray<PresentedWorkflowAgent>,
): WorkflowPhaseGroup {
  const settled = agents.filter((agent) => !isActiveWorkflowAgent(agent)).length;
  return {
    index: phase?.index ?? null,
    title: phase?.title ?? null,
    detail: phase?.detail ?? null,
    state: phaseState(agents),
    agents,
    settled,
  };
}

/** Phases in the order the workflow announced them, each with its agents. */
export function groupWorkflowAgentsByPhase(
  workflow: PresentedWorkflow,
): ReadonlyArray<WorkflowPhaseGroup> {
  const phaseIndexes = new Set(workflow.phases.map((phase) => phase.index));
  const agentsByPhase = new Map<number, Array<PresentedWorkflowAgent>>();
  const unphased: Array<PresentedWorkflowAgent> = [];
  for (const agent of workflow.agents) {
    if (agent.phaseIndex === undefined || !phaseIndexes.has(agent.phaseIndex)) {
      unphased.push(agent);
      continue;
    }
    const agents = agentsByPhase.get(agent.phaseIndex) ?? [];
    agents.push(agent);
    agentsByPhase.set(agent.phaseIndex, agents);
  }
  const groups: Array<WorkflowPhaseGroup> = workflow.phases.map((phase) =>
    phaseGroup(phase, agentsByPhase.get(phase.index) ?? []),
  );
  if (unphased.length > 0) groups.push(phaseGroup(null, unphased));
  return groups;
}

export function countWorkflowAgents(workflow: PresentedWorkflow): WorkflowAgentCounts {
  let settled = 0;
  let running = 0;
  let failed = 0;
  for (const agent of workflow.agents) {
    if (agent.status === "running") running += 1;
    if (agent.status === "failed") failed += 1;
    if (!isActiveWorkflowAgent(agent)) settled += 1;
  }
  return { total: workflow.agents.length, settled, running, failed };
}

/**
 * How far a running workflow has come, from 0 to 1. Each announced phase is an
 * equal step. A phase behind the furthest started one is credited by its
 * settled agents, or in full if it launched none. The furthest phase keeps a
 * slot open for an agent not launched yet, since nothing reports that a phase
 * is closed, so a running workflow never reads complete. Without agents in any
 * announced phase it is the settled share of all agents, with the same slot.
 */
export function workflowProgressFraction(workflow: PresentedWorkflow): number {
  const phases = groupWorkflowAgentsByPhase(workflow).filter((phase) => phase.index !== null);
  const lastStarted = phases.findLastIndex((phase) => phase.agents.length > 0);
  if (lastStarted === -1) {
    const counts = countWorkflowAgents(workflow);
    return counts.settled / (counts.total + 1);
  }
  let steps = 0;
  phases.forEach((phase, index) => {
    if (index > lastStarted) return;
    if (index === lastStarted) {
      steps += phase.settled / (phase.agents.length + 1);
    } else {
      steps += phase.agents.length === 0 ? 1 : phase.settled / phase.agents.length;
    }
  });
  return steps / phases.length;
}

function toolsLabel(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

export interface WorkflowRunTotals {
  readonly tokens: number | null;
  readonly toolCalls: number | null;
}

/**
 * The run's token and tool-call totals: what the coordinator reported, else the sum over its
 * agents. Null when unknown or 0, which Claude Code does not show either.
 */
export function workflowRunTotals(workflow: OrchestrationV2SubagentWorkflow): WorkflowRunTotals {
  const total = (reported: number | undefined, key: "totalTokens" | "toolCalls") => {
    const value = reported ?? workflow.agents.reduce((sum, agent) => sum + (agent[key] ?? 0), 0);
    return value > 0 ? value : null;
  };
  return {
    tokens: total(workflow.totalTokens, "totalTokens"),
    toolCalls: total(workflow.toolCalls, "toolCalls"),
  };
}

/** The run's totals line, e.g. "1.2M tok · 273 tools". Null when there is nothing to show. */
export function workflowRunStatsLabel(workflow: OrchestrationV2SubagentWorkflow): string | null {
  const { tokens, toolCalls } = workflowRunTotals(workflow);
  const parts: Array<string> = [];
  if (tokens !== null) parts.push(`${formatTokens(tokens)} tok`);
  if (toolCalls !== null) parts.push(toolsLabel(toolCalls));
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * An agent row's metrics line, e.g. "Claude Opus 4.6 · 18.3K tok · 23 tools ·
 * worktree". Null when the coordinator reported none of them.
 */
export function workflowAgentMetricsLabel(agent: OrchestrationV2WorkflowAgent): string | null {
  const parts: Array<string> = [];
  if (agent.model !== undefined) parts.push(formatModelSlugName(agent.model));
  if (agent.totalTokens !== undefined) parts.push(`${formatTokens(agent.totalTokens)} tok`);
  if (agent.toolCalls !== undefined) parts.push(toolsLabel(agent.toolCalls));
  if (agent.isolation !== undefined) parts.push(agent.isolation);
  if (agent.attempt !== undefined && agent.attempt > 1) parts.push(`attempt ${agent.attempt}`);
  if (agent.cached === true) parts.push("cached");
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * An agent row's activity line for its status: what a live agent is doing, why
 * a failed one failed, or what a completed one produced.
 */
export function workflowAgentActivityLine(agent: PresentedWorkflowAgent): string | null {
  switch (agent.status) {
    case "pending":
    case "running":
      return agent.activity ?? null;
    case "failed":
      // Upstream's producer reports a failed agent's error as its result.
      return agent.error ?? agent.result ?? null;
    case "completed":
      return agent.result ?? null;
    case "cancelled":
      return null;
  }
}

/** The script's file name, for labels; the full path stays the fetch key. */
export function workflowScriptFileName(scriptPath: string): string {
  return scriptPath.split(/[\\/]/).at(-1) || scriptPath;
}

/**
 * A thread's workflow runs split for the Workflows lists: live runs stay on
 * top, settled ones collect under Previous workflows. Order is kept, and a run
 * that becomes live again moves back.
 */
export function splitWorkflowRuns<Run extends Pick<OrchestrationV2Subagent, "status">>(
  runs: ReadonlyArray<Run>,
): { readonly active: ReadonlyArray<Run>; readonly previous: ReadonlyArray<Run> } {
  return {
    active: runs.filter((run) => isOrchestrationV2WorkActive(run.status)),
    previous: runs.filter((run) => !isOrchestrationV2WorkActive(run.status)),
  };
}
