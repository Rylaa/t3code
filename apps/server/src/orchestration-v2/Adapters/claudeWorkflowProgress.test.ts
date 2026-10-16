import { describe, expect, it } from "vite-plus/test";

import {
  mergeClaudeWorkflowProgress,
  parseClaudeWorkflowMetaPhases,
  parseClaudeWorkflowRunHandles,
} from "./claudeWorkflowProgress.ts";

const startFrame = {
  type: "system",
  subtype: "task_started",
  task_id: "w1",
  task_type: "local_workflow",
  workflow_name: "probe-wf",
};

const snapshotFrame = (
  entries: ReadonlyArray<Record<string, unknown>>,
  usage?: Record<string, number>,
) => ({
  type: "system",
  subtype: "task_progress",
  task_id: "w1",
  description: "Alpha: alpha:one",
  workflow_progress: entries,
  ...(usage === undefined ? {} : { usage }),
});

const phase = (index: number, title: string) => ({ type: "workflow_phase", index, title });

const agent = (overrides: Record<string, unknown>) => ({
  type: "workflow_agent",
  index: 1,
  label: "alpha:one",
  state: "start",
  phaseIndex: 1,
  phaseTitle: "Alpha",
  ...overrides,
});

describe("mergeClaudeWorkflowProgress", () => {
  it("marks a coordinator as a workflow before any member exists", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      name: "probe-wf",
      message: startFrame,
    });
    expect(workflow).toEqual({ name: "probe-wf", phases: [], agents: [] });
  });

  it("leaves an ordinary subagent's frames alone", () => {
    expect(
      mergeClaudeWorkflowProgress({
        previous: undefined,
        message: {
          type: "system",
          subtype: "task_progress",
          task_id: "t1",
          description: "reading files",
          usage: { total_tokens: 500, tool_uses: 2, duration_ms: 90 },
        },
      }),
    ).toBeUndefined();
  });

  it("maps provider agent states and per-member metrics", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        phase(1, "Alpha"),
        agent({
          state: "done",
          agentId: "a1",
          model: "claude-opus-5[1m]",
          attempt: 2,
          tokens: 71_141,
          toolCalls: 3,
          durationMs: 1277,
          startedAt: 1_700_000_000_000,
          queuedAt: 1_699_999_999_000,
          promptPreview: "Reply with exactly: A1",
          resultPreview: "A1",
        }),
        // Claude Code reports a queued agent as started without a start time.
        agent({ index: 2, label: "alpha:two", state: "start", queuedAt: 1_700_000_000_500 }),
      ]),
    });
    expect(workflow?.phases).toEqual([{ index: 1, title: "Alpha" }]);
    expect(workflow?.agents[0]).toEqual({
      index: 1,
      label: "alpha:one",
      agentId: "a1",
      state: "completed",
      phaseIndex: 1,
      phaseTitle: "Alpha",
      model: "claude-opus-5[1m]",
      attempt: 2,
      totalTokens: 71_141,
      toolCalls: 3,
      durationMs: 1277,
      queuedAt: 1_699_999_999_000,
      startedAt: 1_700_000_000_000,
      prompt: "Reply with exactly: A1",
      result: "A1",
    });
    expect(workflow?.agents[1]?.state).toBe("queued");
  });

  it.each(["something-new", "toString", "constructor", "__proto__"])(
    "treats unrecognised state %s as still running rather than settled",
    (state) => {
      const workflow = mergeClaudeWorkflowProgress({
        previous: undefined,
        message: snapshotFrame([agent({ state })]),
      });
      expect(workflow?.agents[0]?.state).toBe("running");
    },
  );

  it("keeps the roster through a usage-only frame", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      name: "probe-wf",
      message: snapshotFrame([phase(1, "Alpha"), agent({})], {
        total_tokens: 100,
        tool_uses: 1,
        duration_ms: 40,
      }),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([], { total_tokens: 250, tool_uses: 2, duration_ms: 900 }),
    });
    expect(second?.agents).toHaveLength(1);
    expect(second?.phases).toHaveLength(1);
    expect(second?.name).toBe("probe-wf");
    expect(second?.totalTokens).toBe(250);
  });

  it("harvests run handles from the launch acknowledgement", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      runHandles: parseClaudeWorkflowRunHandles({
        status: "async_launched",
        taskType: "local_workflow",
        runId: "wf_abc",
        transcriptDir: "/root/.claude/projects/p/s/subagents/workflows/wf_abc",
        scriptPath: "/root/.claude/projects/p/s/workflows/scripts/x.js",
      }),
      message: startFrame,
    });
    expect(workflow?.runHandles?.transcriptDir).toBe(
      "/root/.claude/projects/p/s/subagents/workflows/wf_abc",
    );
    expect(workflow?.runHandles?.runId).toBe("wf_abc");
  });

  it("ignores a non-workflow tool acknowledgement", () => {
    expect(
      parseClaudeWorkflowRunHandles({ status: "async_launched", taskType: "local_agent" }),
    ).toBeUndefined();
  });

  it("keeps a phase the plan reached at runtime even if a later frame omits it", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([phase(1, "Alpha"), phase(2, "Beta"), phase(3, "Gamma")]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([phase(1, "Alpha")]),
    });
    expect(second?.phases.map((entry) => entry.title)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("keeps other members and phase links when a sparse frame starts a new attempt", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        phase(1, "Alpha"),
        agent({
          state: "error",
          attempt: 1,
          promptPreview: "First prompt",
          resultPreview: "First result",
          tokens: 100,
          toolCalls: 2,
          durationMs: 50,
          queuedAt: 1000,
          startedAt: 1010,
        }),
        agent({ index: 2, state: "done" }),
      ]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([
        { type: "workflow_agent", index: 1, label: "alpha:one", state: "start", attempt: 2 },
      ]),
    });
    expect(second?.agents).toEqual([
      {
        index: 1,
        label: "alpha:one",
        state: "running",
        attempt: 2,
        phaseIndex: 1,
        phaseTitle: "Alpha",
      },
      first?.agents[1],
    ]);
    expect(second?.phases).toEqual(first?.phases);
  });

  it("ignores an older attempt after a retry completes", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([agent({ state: "done", attempt: 2, resultPreview: "New result" })]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([agent({ state: "error", attempt: 1, resultPreview: "Old result" })]),
    });
    expect(second?.agents).toEqual(first?.agents);
  });

  it.each([
    ["done", "start"],
    ["done", "queued"],
    ["error", "start"],
    ["error", "queued"],
    ["start", "queued"],
  ])("keeps member state when the same attempt regresses from %s to %s", (state, staleState) => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([agent({ state, attempt: 2, resultPreview: "Current result" })]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([
        agent({ state: staleState, attempt: 2, resultPreview: "Old result" }),
      ]),
    });
    expect(second?.agents).toEqual(first?.agents);
  });

  it("retains member fields omitted by a later frame in the same attempt", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([agent({ attempt: 2, promptPreview: "Current prompt", tokens: 100 })]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([agent({ state: "done", resultPreview: "Current result" })]),
    });
    expect(second?.agents[0]).toMatchObject({
      state: "completed",
      attempt: 2,
      prompt: "Current prompt",
      result: "Current result",
      totalTokens: 100,
    });
  });

  it("keeps existing run handles when a later acknowledgement supplies only a script path", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      runHandles: { runId: "wf_abc", transcriptDir: "/workflows/wf_abc" },
      message: startFrame,
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      runHandles: { scriptPath: "/scripts/workflow.js" },
      message: startFrame,
    });
    expect(second?.runHandles).toEqual({
      runId: "wf_abc",
      transcriptDir: "/workflows/wf_abc",
      scriptPath: "/scripts/workflow.js",
    });
  });

  it("preserves prompt and result whitespace", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        agent({ promptPreview: "  indented\n", resultPreview: "\n  answer\n" }),
      ]),
    });
    expect(workflow?.agents[0]?.prompt).toBe("  indented\n");
    expect(workflow?.agents[0]?.result).toBe("\n  answer\n");
  });

  it("drops timestamps outside the DateTime range", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        agent({ startedAt: 8_640_000_000_000_001, queuedAt: Number.MAX_SAFE_INTEGER }),
        agent({ index: 2, startedAt: 8_640_000_000_000_000, queuedAt: 0 }),
      ]),
    });
    expect(workflow?.agents[0]).not.toHaveProperty("startedAt");
    expect(workflow?.agents[0]).not.toHaveProperty("queuedAt");
    expect(workflow?.agents[1]?.startedAt).toBe(8_640_000_000_000_000);
    expect(workflow?.agents[1]?.queuedAt).toBe(0);
  });

  it("drops malformed entries instead of failing the frame", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        { type: "workflow_phase", title: "No index" },
        { type: "workflow_agent", index: 4 },
        { type: "something_else", index: 1, title: "Ignored" },
        phase(1, "Alpha"),
      ]),
    });
    expect(workflow).toEqual({ phases: [{ index: 1, title: "Alpha" }], agents: [] });
  });

  describe("planned phases from the script", () => {
    const script = [
      "export const meta = {",
      "  name: 'review',",
      "  phases: [",
      "    { title: 'Review', detail: 'three readers in parallel' },",
      "    { title: 'Verify', detail: 'check each finding' },",
      "    { title: 'Report' },",
      "  ],",
      "}",
      "export default async function run() {}",
    ].join("\n");
    const launch = (prompt: string) => ({ ...startFrame, prompt });
    const seeded = mergeClaudeWorkflowProgress({
      previous: undefined,
      name: "review",
      message: launch(script),
    });

    it("seeds the declared phases at launch, numbered from 1", () => {
      expect(seeded).toEqual({
        name: "review",
        phases: [
          { index: 1, title: "Review", detail: "three readers in parallel" },
          { index: 2, title: "Verify", detail: "check each finding" },
          { index: 3, title: "Report" },
        ],
        agents: [],
      });
    });

    it("seeds nothing when the script is withheld or the frame is not the launch", () => {
      expect(
        mergeClaudeWorkflowProgress({ previous: undefined, name: "review", message: launch("") }),
      ).toEqual({ name: "review", phases: [], agents: [] });
      expect(
        mergeClaudeWorkflowProgress({
          previous: undefined,
          message: { ...snapshotFrame([agent({})]), prompt: script },
        })?.phases,
      ).toEqual([]);
    });

    it("keeps each detail when the frames announce the same phases, adding none", () => {
      const announced = mergeClaudeWorkflowProgress({
        previous: seeded,
        message: snapshotFrame([phase(1, "Review"), phase(2, "Verify"), phase(3, "Report")]),
      });
      expect(announced?.phases).toEqual(seeded?.phases);
    });

    it("drops a detail when a frame names the phase differently", () => {
      const announced = mergeClaudeWorkflowProgress({
        previous: seeded,
        message: snapshotFrame([phase(1, "phase 1"), phase(2, "verify")]),
      });
      expect(announced?.phases).toEqual([
        { index: 1, title: "phase 1" },
        { index: 2, title: "verify", detail: "check each finding" },
        { index: 3, title: "Report" },
      ]);
    });

    it("keeps phases, details and agents when a resume restarts the task", () => {
      const running = mergeClaudeWorkflowProgress({
        previous: seeded,
        message: snapshotFrame([phase(1, "Review"), agent({ phaseTitle: "Review" })]),
      });
      for (const prompt of ["Please also check the tests.", script]) {
        expect(mergeClaudeWorkflowProgress({ previous: running, message: launch(prompt) })).toEqual(
          running,
        );
      }
    });

    it("never replaces a phase the run already has", () => {
      const first = mergeClaudeWorkflowProgress({
        previous: undefined,
        message: snapshotFrame([phase(1, "Alpha")]),
      });
      expect(
        mergeClaudeWorkflowProgress({ previous: first, message: launch(script) })?.phases,
      ).toEqual([
        { index: 1, title: "Alpha" },
        { index: 2, title: "Verify", detail: "check each finding" },
        { index: 3, title: "Report" },
      ]);
    });
  });

  it("moves a queued agent to running once it reports a start time, and not back", () => {
    const queued = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([agent({ queuedAt: 1000 })]),
    });
    expect(queued?.agents[0]?.state).toBe("queued");
    const running = mergeClaudeWorkflowProgress({
      previous: queued,
      message: snapshotFrame([agent({ queuedAt: 1000, startedAt: 1010 })]),
    });
    expect(running?.agents[0]).toMatchObject({ state: "running", queuedAt: 1000, startedAt: 1010 });
    const stale = mergeClaudeWorkflowProgress({
      previous: running,
      message: snapshotFrame([agent({ queuedAt: 1000 })]),
    });
    expect(stale?.agents).toEqual(running?.agents);
  });
});

describe("parseClaudeWorkflowMetaPhases", () => {
  const meta = (phases: string, before = "") =>
    `${before}export const meta = {\n  name: "wf",\n  phases: ${phases},\n}\nconst x = 1\n`;

  it("reads every quote kind, escapes and comments, skipping other meta values", () => {
    const script = [
      "// leading comment with export const metaphor",
      "export const meta = {",
      "  name: 'wf', // name",
      "  description: \"phases: [{ title: 'Fake' }], and } braces\",",
      "  args: { schema: { type: 'object', required: ['a', 'b'] } },",
      "  budget: Math.max(1, 2),",
      "  /* phases: [] */",
      "  phases: [",
      '    { title: \'It\\\'s "one"\', detail: "a \\"quoted\\" \\u2014 line\\n" },',
      "    { 'title': `Two`, model: 'opus', detail: `back\\`tick` },",
      "  ],",
      "}",
    ].join("\n");
    expect(parseClaudeWorkflowMetaPhases(script)).toEqual([
      { title: `It's "one"`, detail: 'a "quoted" — line' },
      { title: "Two", detail: "back`tick" },
    ]);
  });

  it("leaves out a detail that is missing, blank, or computed", () => {
    expect(
      parseClaudeWorkflowMetaPhases(
        meta(
          "[{ title: 'A' }, { title: 'B', detail: '  ' }, { title: 'C', detail: `n=${count({ a: '}' })}` }, { title: 'D', detail: 'x' + y }]",
        ),
      ),
    ).toEqual([{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }]);
  });

  it.each([
    ["no meta", "const meta = { phases: [{ title: 'A' }] }"],
    ["no phases", meta("undefined").replace("phases: undefined,", "")],
    ["computed phases", meta("PHASES")],
    ["a computed title", meta("[{ title: `${name}` }]")],
    ["a phase that is not an object", meta("['A']")],
    // Seeding the rest would number them wrong.
    ["a spread before a literal phase", meta("[...BASE, { title: 'A' }]")],
    ["a computed title after a literal one", meta("[{ title: 'A' }, { title: NAME }]")],
    ["a string broken by a newline", meta("[{ title: 'A\n' }]")],
    ["a missing comma between phases", meta("[{ title: 'A' } { title: 'B' }]")],
    ["a missing comma between fields", meta("[{ title: 'A', model: {} detail: 'x' }]")],
    ["a duplicate title", meta("[{ title: 'Review' }, { title: ' review ' }]")],
    ["a cut-off meta", meta("[{ title: 'A' }, { title: 'B'").slice(0, -20)],
    ["an unterminated string", "export const meta = { phases: [{ title: 'A }] }"],
  ])("returns nothing for %s", (_case, script) => {
    expect(parseClaudeWorkflowMetaPhases(script)).toEqual([]);
  });

  it("only scans the first 64 KB", () => {
    const phases = "[{ title: 'A' }]";
    expect(parseClaudeWorkflowMetaPhases(meta(phases, `//${"x".repeat(60_000)}\n`))).toEqual([
      { title: "A" },
    ]);
    expect(parseClaudeWorkflowMetaPhases(meta(phases, `//${"x".repeat(64 * 1024)}\n`))).toEqual([]);
  });
});
