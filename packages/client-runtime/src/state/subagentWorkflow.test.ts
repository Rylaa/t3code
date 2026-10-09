import type { OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countWorkflowAgents,
  groupWorkflowAgentsByPhase,
  presentedWorkflow,
  splitWorkflowRuns,
  workflowAgentActivityLine,
  workflowAgentMetricsLabel,
  workflowProgressFraction,
  workflowScriptFileName,
} from "./subagentWorkflow.ts";

const workflow: OrchestrationV2SubagentWorkflow = {
  name: "review",
  scriptPath: "/home/user/.claude/projects/repo/workflows/review.js",
  phases: [
    { index: 1, title: "Review" },
    { index: 2, title: "Verify" },
    { index: 3, title: "Report" },
  ],
  agents: [
    { index: 1, label: "bugs", status: "completed", phaseIndex: 1 },
    { index: 2, label: "perf", status: "failed", phaseIndex: 1 },
    { index: 3, label: "verify bugs", status: "running", phaseIndex: 2 },
    { index: 4, label: "verify perf", status: "pending", phaseIndex: 2 },
    { index: 5, label: "late", status: "running", phaseIndex: 9 },
  ],
};

describe("groupWorkflowAgentsByPhase", () => {
  it("keeps announced phase order and derives each phase's state from its agents", () => {
    expect(
      groupWorkflowAgentsByPhase(workflow).map((group) => ({
        title: group.title,
        state: group.state,
        settled: group.settled,
        agents: group.agents.map((agent) => agent.label),
      })),
    ).toEqual([
      { title: "Review", state: "done", settled: 2, agents: ["bugs", "perf"] },
      { title: "Verify", state: "running", settled: 0, agents: ["verify bugs", "verify perf"] },
      { title: "Report", state: "pending", settled: 0, agents: [] },
      // An agent whose phase was never announced still shows.
      { title: null, state: "running", settled: 0, agents: ["late"] },
    ]);
  });
});

describe("countWorkflowAgents", () => {
  it("counts failed agents as settled", () => {
    expect(countWorkflowAgents(workflow)).toEqual({
      total: 5,
      settled: 2,
      running: 2,
      failed: 1,
    });
  });
});

describe("presentedWorkflow", () => {
  it("cancels agents a run that is no longer active left at work", () => {
    expect(presentedWorkflow(workflow, false).agents.map((agent) => agent.status)).toEqual([
      "completed",
      "failed",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
  });

  it("drops the activity of the agents it cancels", () => {
    const working = {
      ...workflow,
      agents: workflow.agents.map((agent) => ({ ...agent, activity: "Grep(TODO)" })),
    };
    expect(presentedWorkflow(working, false).agents.map((agent) => agent.activity)).toEqual([
      "Grep(TODO)",
      "Grep(TODO)",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("keeps an active run as reported", () => {
    expect(presentedWorkflow(workflow, true)).toBe(workflow);
  });
});

describe("workflowProgressFraction", () => {
  it("credits phases behind the furthest one by their settled agents", () => {
    // Review settled (1); Verify is furthest, none settled, one slot open (0).
    expect(workflowProgressFraction(workflow)).toBe(1 / 3);
    // One of Verify's two agents settles: 1/3 of its step.
    expect(
      workflowProgressFraction({
        ...workflow,
        agents: workflow.agents.map((agent) =>
          agent.index === 3 ? { ...agent, status: "completed" } : agent,
        ),
      }),
    ).toBe((1 + 1 / 3) / 3);
  });

  it("never reads complete while the furthest phase may launch more", () => {
    const settled = workflowProgressFraction({
      ...workflow,
      phases: [{ index: 1, title: "Fix" }],
      agents: [{ index: 1, label: "fix", status: "completed", phaseIndex: 1 }],
    });
    expect(settled).toBe(1 / 2);
  });

  it("counts a phase without agents as done once a later phase starts", () => {
    expect(
      workflowProgressFraction({
        ...workflow,
        agents: [
          { index: 1, label: "review", status: "completed", phaseIndex: 1 },
          { index: 2, label: "report", status: "running", phaseIndex: 3 },
        ],
      }),
    ).toBe(2 / 3);
  });

  it("uses the settled share of agents when no announced phase has any", () => {
    const agents = [
      { index: 1, label: "a", status: "completed", phaseIndex: null },
      { index: 2, label: "b", status: "completed", phaseIndex: 7 },
      { index: 3, label: "c", status: "running", phaseIndex: null },
    ] as const;
    expect(workflowProgressFraction({ ...workflow, agents })).toBe(2 / 4);
    expect(workflowProgressFraction({ ...workflow, phases: [], agents })).toBe(2 / 4);
    expect(workflowProgressFraction({ ...workflow, phases: [], agents: [] })).toBe(0);
  });
});

describe("workflowScriptFileName", () => {
  it("names POSIX and Windows script paths by their file", () => {
    expect(workflowScriptFileName("/a/b/review.js")).toBe("review.js");
    expect(workflowScriptFileName("C:\\Users\\me\\review.js")).toBe("review.js");
  });
});

describe("workflowAgentMetricsLabel", () => {
  it("joins the reported metrics in a fixed order", () => {
    expect(
      workflowAgentMetricsLabel({
        index: 1,
        label: "bugs",
        status: "running",
        phaseIndex: 1,
        cached: true,
        attempt: 2,
        isolation: "worktree",
        toolCalls: 23,
        tokens: 18_250,
        model: "claude-opus-4-6",
      }),
    ).toBe("Claude Opus 4.6 · 18.3K tok · 23 tools · worktree · attempt 2 · cached");
    expect(
      workflowAgentMetricsLabel({
        index: 1,
        label: "bugs",
        status: "running",
        phaseIndex: 1,
        model: "opus",
        toolCalls: 1,
      }),
    ).toBe("opus · 1 tool");
  });

  it("is null when nothing was reported", () => {
    expect(workflowAgentMetricsLabel(workflow.agents[0]!)).toBeNull();
  });
});

describe("workflowAgentActivityLine", () => {
  const detail = {
    index: 1,
    label: "bugs",
    phaseIndex: 1,
    activity: "Reading src/app.ts",
    error: "Rate limited",
    resultPreview: "Found 2 bugs",
  } as const;

  it("picks the line that matches the agent's status", () => {
    expect(workflowAgentActivityLine({ ...detail, status: "running" })).toBe("Reading src/app.ts");
    expect(workflowAgentActivityLine({ ...detail, status: "failed" })).toBe("Rate limited");
    expect(workflowAgentActivityLine({ ...detail, status: "completed" })).toBe("Found 2 bugs");
    expect(workflowAgentActivityLine({ ...detail, status: "cancelled" })).toBeNull();
  });

  it("does not fall back to another status's line", () => {
    expect(
      workflowAgentActivityLine({
        index: 1,
        label: "bugs",
        phaseIndex: 1,
        status: "completed",
        activity: "Grep",
      }),
    ).toBeNull();
  });
});

describe("splitWorkflowRuns", () => {
  it("keeps live runs on top and settled runs under previous, in order", () => {
    const runs = [
      { id: "a", status: "completed" },
      { id: "b", status: "running" },
      { id: "c", status: "failed" },
      { id: "d", status: "waiting" },
      { id: "e", status: "cancelled" },
      { id: "f", status: "pending" },
      { id: "g", status: "interrupted" },
      { id: "h", status: "idle" },
    ] as const;
    const { active, previous } = splitWorkflowRuns(runs);
    expect(active.map((run) => run.id)).toEqual(["b", "d", "f"]);
    expect(previous.map((run) => run.id)).toEqual(["a", "c", "e", "g", "h"]);
  });
});
