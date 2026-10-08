import type { OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countWorkflowAgents,
  groupWorkflowAgentsByPhase,
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
        agents: group.agents.map((agent) => agent.label),
      })),
    ).toEqual([
      { title: "Review", state: "done", agents: ["bugs", "perf"] },
      { title: "Verify", state: "running", agents: ["verify bugs", "verify perf"] },
      { title: "Report", state: "pending", agents: [] },
      // An agent whose phase was never announced still shows.
      { title: null, state: "running", agents: ["late"] },
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

describe("workflowScriptFileName", () => {
  it("names POSIX and Windows script paths by their file", () => {
    expect(workflowScriptFileName("/a/b/review.js")).toBe("review.js");
    expect(workflowScriptFileName("C:\\Users\\me\\review.js")).toBe("review.js");
  });
});
