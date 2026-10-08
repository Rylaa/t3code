/**
 * How web and mobile present a provider workflow carried on the subagent that
 * coordinates it: its agents grouped under their phases, and a compact count.
 */
import type {
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { formatTokens } from "@t3tools/shared/usageFormat";

export type WorkflowPhaseState = "pending" | "running" | "done";

export const WORKFLOW_PHASE_STATE_LABEL: Record<WorkflowPhaseState, string> = {
  pending: "Not started",
  running: "Running",
  done: "Done",
};

export interface WorkflowPhaseGroup {
  /** null groups agents whose phase the coordinator never announced. */
  readonly index: number | null;
  readonly title: string | null;
  readonly state: WorkflowPhaseState;
  readonly agents: ReadonlyArray<OrchestrationV2WorkflowAgent>;
  /** How many of its agents are no longer at work. */
  readonly settled: number;
}

export interface WorkflowAgentCounts {
  readonly total: number;
  readonly settled: number;
  readonly running: number;
  readonly failed: number;
}

function isActiveWorkflowAgent(agent: OrchestrationV2WorkflowAgent): boolean {
  return agent.status === "pending" || agent.status === "running";
}

function phaseState(agents: ReadonlyArray<OrchestrationV2WorkflowAgent>): WorkflowPhaseState {
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
): OrchestrationV2SubagentWorkflow {
  if (runActive || !workflow.agents.some(isActiveWorkflowAgent)) return workflow;
  return {
    ...workflow,
    agents: workflow.agents.map((agent) => {
      if (!isActiveWorkflowAgent(agent)) return agent;
      const { activity: _activity, ...rest } = agent;
      return { ...rest, status: "cancelled" };
    }),
  };
}

function phaseGroup(
  index: number | null,
  title: string | null,
  agents: ReadonlyArray<OrchestrationV2WorkflowAgent>,
): WorkflowPhaseGroup {
  const settled = agents.filter((agent) => !isActiveWorkflowAgent(agent)).length;
  return { index, title, state: phaseState(agents), agents, settled };
}

/** Phases in the order the workflow announced them, each with its agents. */
export function groupWorkflowAgentsByPhase(
  workflow: OrchestrationV2SubagentWorkflow,
): ReadonlyArray<WorkflowPhaseGroup> {
  const phaseIndexes = new Set(workflow.phases.map((phase) => phase.index));
  const agentsByPhase = new Map<number, Array<OrchestrationV2WorkflowAgent>>();
  const unphased: Array<OrchestrationV2WorkflowAgent> = [];
  for (const agent of workflow.agents) {
    if (agent.phaseIndex === null || !phaseIndexes.has(agent.phaseIndex)) {
      unphased.push(agent);
      continue;
    }
    const agents = agentsByPhase.get(agent.phaseIndex) ?? [];
    agents.push(agent);
    agentsByPhase.set(agent.phaseIndex, agents);
  }
  const groups: Array<WorkflowPhaseGroup> = workflow.phases.map((phase) =>
    phaseGroup(phase.index, phase.title, agentsByPhase.get(phase.index) ?? []),
  );
  if (unphased.length > 0) groups.push(phaseGroup(null, null, unphased));
  return groups;
}

export function countWorkflowAgents(
  workflow: OrchestrationV2SubagentWorkflow,
): WorkflowAgentCounts {
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
export function workflowProgressFraction(workflow: OrchestrationV2SubagentWorkflow): number {
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

/**
 * An agent row's metrics line, e.g. "Claude Opus 4.6 · 18.3K tok · 23 tools ·
 * worktree". Null when the coordinator reported none of them.
 */
export function workflowAgentMetricsLabel(agent: OrchestrationV2WorkflowAgent): string | null {
  const parts: Array<string> = [];
  if (agent.model !== undefined) parts.push(formatModelSlugName(agent.model));
  if (agent.tokens !== undefined) parts.push(`${formatTokens(agent.tokens)} tok`);
  if (agent.toolCalls !== undefined) {
    parts.push(`${agent.toolCalls} ${agent.toolCalls === 1 ? "tool" : "tools"}`);
  }
  if (agent.isolation !== undefined) parts.push(agent.isolation);
  if (agent.attempt !== undefined) parts.push(`attempt ${agent.attempt}`);
  if (agent.cached === true) parts.push("cached");
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * An agent row's activity line for its status: what a live agent is doing, why
 * a failed one failed, or what a completed one produced.
 */
export function workflowAgentActivityLine(agent: OrchestrationV2WorkflowAgent): string | null {
  switch (agent.status) {
    case "pending":
    case "running":
      return agent.activity ?? null;
    case "failed":
      return agent.error ?? null;
    case "completed":
      return agent.resultPreview ?? null;
    case "cancelled":
      return null;
  }
}

/** The script's file name, for labels; the full path stays the fetch key. */
export function workflowScriptFileName(scriptPath: string): string {
  return scriptPath.split(/[\\/]/).at(-1) || scriptPath;
}
