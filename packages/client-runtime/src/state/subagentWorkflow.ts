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

/** The script's file name, for labels; the full path stays the fetch key. */
export function workflowScriptFileName(scriptPath: string): string {
  return scriptPath.split(/[\\/]/).at(-1) || scriptPath;
}
