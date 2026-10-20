import type { OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countWorkflowAgents,
  groupWorkflowAgentsByPhase,
  presentedWorkflow,
  splitWorkflowRuns,
  type PresentedWorkflow,
  workflowAgentActivityLine,
  workflowAgentMetricsLabel,
  workflowPhaseTokensLabel,
  workflowProgressFraction,
  workflowRunStatsLabel,
  workflowRunTotals,
  workflowScriptFileName,
} from "./subagentWorkflow.ts";

const workflow: OrchestrationV2SubagentWorkflow = {
  name: "review",
  runHandles: { scriptPath: "/home/user/.claude/projects/repo/workflows/review.js" },
  phases: [
    { index: 1, title: "Review" },
    { index: 2, title: "Verify" },
    { index: 3, title: "Report" },
  ],
  agents: [
    { index: 1, label: "bugs", state: "completed", phaseIndex: 1 },
    { index: 2, label: "perf", state: "failed", phaseIndex: 1 },
    { index: 3, label: "verify bugs", state: "running", phaseIndex: 2 },
    { index: 4, label: "verify perf", state: "queued", phaseIndex: 2 },
    { index: 5, label: "late", state: "running", phaseIndex: 9 },
  ],
};
const shown = presentedWorkflow(workflow, true);

describe("groupWorkflowAgentsByPhase", () => {
  it("keeps announced phase order and derives each phase's state from its agents", () => {
    expect(
      groupWorkflowAgentsByPhase(shown).map((group) => ({
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

  it("carries each phase's declared detail", () => {
    const planned = presentedWorkflow(
      {
        ...workflow,
        phases: [{ index: 1, title: "Review", detail: "three readers" }, workflow.phases[1]!],
      },
      true,
    );
    expect(groupWorkflowAgentsByPhase(planned).map((group) => group.detail)).toEqual([
      "three readers",
      null,
      null,
    ]);
  });
});

describe("countWorkflowAgents", () => {
  it("counts failed agents as settled", () => {
    expect(countWorkflowAgents(shown)).toEqual({
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

  it("keeps an active run's states, naming queued agents pending", () => {
    expect(shown.agents.map((agent) => agent.status)).toEqual([
      "completed",
      "failed",
      "running",
      "pending",
      "running",
    ]);
  });
});

describe("workflowProgressFraction", () => {
  it("credits phases behind the furthest one by their settled agents", () => {
    // Review settled (1); Verify is furthest, none settled, one slot open (0).
    expect(workflowProgressFraction(shown)).toBe(1 / 3);
    // One of Verify's two agents settles: 1/3 of its step.
    expect(
      workflowProgressFraction({
        ...shown,
        agents: shown.agents.map((agent) =>
          agent.index === 3 ? { ...agent, status: "completed" } : agent,
        ),
      }),
    ).toBe((1 + 1 / 3) / 3);
  });

  it("never reads complete while the furthest phase may launch more", () => {
    const settled = workflowProgressFraction({
      ...shown,
      phases: [{ index: 1, title: "Fix" }],
      agents: [{ index: 1, label: "fix", state: "completed", status: "completed", phaseIndex: 1 }],
    });
    expect(settled).toBe(1 / 2);
  });

  it("counts a phase without agents as done once a later phase starts", () => {
    expect(
      workflowProgressFraction({
        ...shown,
        agents: [
          { index: 1, label: "review", state: "completed", status: "completed", phaseIndex: 1 },
          { index: 2, label: "report", state: "running", status: "running", phaseIndex: 3 },
        ],
      }),
    ).toBe(2 / 3);
  });

  it("uses the settled share of agents when no announced phase has any", () => {
    const agents: PresentedWorkflow["agents"] = [
      { index: 1, label: "a", state: "completed", status: "completed" },
      { index: 2, label: "b", state: "completed", status: "completed", phaseIndex: 7 },
      { index: 3, label: "c", state: "running", status: "running" },
    ];
    expect(workflowProgressFraction({ ...shown, agents })).toBe(2 / 4);
    expect(workflowProgressFraction({ ...shown, phases: [], agents })).toBe(2 / 4);
    expect(workflowProgressFraction({ ...shown, phases: [], agents: [] })).toBe(0);
  });
});

describe("workflowProgressFraction with planned phases", () => {
  const planned = workflow.phases.map((phase) => ({ ...phase, detail: `${phase.title} detail` }));

  it("reads 0 before any agent starts", () => {
    expect(workflowProgressFraction({ ...shown, phases: planned, agents: [] })).toBe(0);
  });

  it("matches the fraction of the same phases announced without details", () => {
    const agents: PresentedWorkflow["agents"] = [
      { index: 1, label: "review", state: "completed", status: "completed", phaseIndex: 1 },
      { index: 2, label: "report", state: "running", status: "running", phaseIndex: 3 },
    ];
    expect(workflowProgressFraction({ ...shown, phases: planned, agents })).toBe(
      workflowProgressFraction({ ...shown, agents }),
    );
  });
});

describe("workflowRunTotals", () => {
  const agents: OrchestrationV2SubagentWorkflow["agents"] = [
    { index: 1, label: "a", state: "completed", totalTokens: 1_000, toolCalls: 3 },
    { index: 2, label: "b", state: "running", totalTokens: 500 },
    { index: 3, label: "c", state: "queued" },
  ];

  it("prefers the reported totals over the agents' sum", () => {
    expect(workflowRunTotals({ phases: [], agents, totalTokens: 9_000, toolCalls: 12 })).toEqual({
      tokens: 9_000,
      toolCalls: 12,
    });
  });

  it("sums the agents when the run reported nothing", () => {
    expect(workflowRunTotals({ phases: [], agents })).toEqual({ tokens: 1_500, toolCalls: 3 });
  });

  it("is null when nothing or 0 was reported", () => {
    expect(workflowRunTotals({ phases: [], agents: [] })).toEqual({
      tokens: null,
      toolCalls: null,
    });
    expect(workflowRunTotals({ phases: [], agents, totalTokens: 0, toolCalls: 0 })).toEqual({
      tokens: null,
      toolCalls: null,
    });
  });
});

describe("workflowPhaseTokensLabel", () => {
  it("sums the tokens each agent in the phase reported", () => {
    const [review, verify] = groupWorkflowAgentsByPhase(
      presentedWorkflow(
        {
          ...workflow,
          agents: [
            { index: 1, label: "bugs", state: "completed", phaseIndex: 1, totalTokens: 300_000 },
            { index: 2, label: "perf", state: "completed", phaseIndex: 1, totalTokens: 120_000 },
            { index: 3, label: "verify", state: "completed", phaseIndex: 2 },
          ],
        },
        false,
      ),
    );
    expect(workflowPhaseTokensLabel(review!)).toBe("420K tok");
    expect(workflowPhaseTokensLabel(verify!)).toBeNull();
  });
});

describe("workflowRunStatsLabel", () => {
  it("joins tokens and tools, naming a single tool", () => {
    expect(
      workflowRunStatsLabel({ phases: [], agents: [], totalTokens: 1_234_567, toolCalls: 273 }),
    ).toBe("1.23M tok · 273 tools");
    expect(workflowRunStatsLabel({ phases: [], agents: [], toolCalls: 1 })).toBe("1 tool");
  });

  it("is null for a run that reported nothing, as old servers send", () => {
    expect(workflowRunStatsLabel(workflow)).toBeNull();
  });
});

describe("workflowScriptFileName", () => {
  it("names script paths by their file", () => {
    expect(workflowScriptFileName("/a/b/review.js")).toBe("review.js");
  });
});

describe("workflowAgentMetricsLabel", () => {
  it("joins the reported metrics in a fixed order", () => {
    expect(
      workflowAgentMetricsLabel({
        index: 1,
        label: "bugs",
        state: "running",
        phaseIndex: 1,
        cached: true,
        attempt: 2,
        isolation: "worktree",
        toolCalls: 23,
        totalTokens: 18_250,
        model: "claude-opus-4-6",
      }),
    ).toBe("Claude Opus 4.6 · 18.3K tok · 23 tools · worktree · attempt 2 · cached");
    expect(
      workflowAgentMetricsLabel({
        index: 1,
        label: "bugs",
        state: "running",
        phaseIndex: 1,
        model: "opus",
        toolCalls: 1,
        // A first attempt is not a retry.
        attempt: 1,
      }),
    ).toBe("opus · 1 tool");
  });

  it("is null when nothing was reported", () => {
    expect(workflowAgentMetricsLabel(shown.agents[0]!)).toBeNull();
  });
});

describe("workflowAgentActivityLine", () => {
  const detail = {
    index: 1,
    label: "bugs",
    phaseIndex: 1,
    activity: "Reading src/app.ts",
    error: "Rate limited",
    result: "Found 2 bugs",
    state: "running",
  } as const;

  it("picks the line that matches the agent's status", () => {
    expect(workflowAgentActivityLine({ ...detail, status: "running" })).toBe("Reading src/app.ts");
    expect(workflowAgentActivityLine({ ...detail, status: "failed" })).toBe("Rate limited");
    expect(workflowAgentActivityLine({ ...detail, status: "completed" })).toBe("Found 2 bugs");
    expect(workflowAgentActivityLine({ ...detail, status: "cancelled" })).toBeNull();
  });

  it("falls back to the result for a failed agent without an error", () => {
    const { error: _error, ...failed } = detail;
    expect(workflowAgentActivityLine({ ...failed, status: "failed" })).toBe("Found 2 bugs");
  });

  it("does not fall back to another status's line", () => {
    expect(
      workflowAgentActivityLine({
        index: 1,
        label: "bugs",
        phaseIndex: 1,
        state: "completed",
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
