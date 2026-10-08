/**
 * How web and mobile present a provider workflow carried on the subagent that
 * coordinates it: its agents grouped under their phases, and a compact count.
 */
import type {
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
} from "@t3tools/contracts";

export type WorkflowPhaseState = "pending" | "running" | "done";

export interface WorkflowPhaseGroup {
  /** null groups agents whose phase the coordinator never announced. */
  readonly index: number | null;
  readonly title: string | null;
  readonly state: WorkflowPhaseState;
  readonly agents: ReadonlyArray<OrchestrationV2WorkflowAgent>;
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
  const groups: Array<WorkflowPhaseGroup> = workflow.phases.map((phase) => {
    const agents = agentsByPhase.get(phase.index) ?? [];
    return { index: phase.index, title: phase.title, state: phaseState(agents), agents };
  });
  if (unphased.length > 0) {
    groups.push({ index: null, title: null, state: phaseState(unphased), agents: unphased });
  }
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
    const settled = phase.agents.filter((agent) => !isActiveWorkflowAgent(agent)).length;
    if (index === lastStarted) {
      steps += settled / (phase.agents.length + 1);
    } else {
      steps += phase.agents.length === 0 ? 1 : settled / phase.agents.length;
    }
  });
  return steps / phases.length;
}

/** The script's file name, for labels; the full path stays the fetch key. */
export function workflowScriptFileName(scriptPath: string): string {
  return scriptPath.split(/[\\/]/).at(-1) || scriptPath;
}
