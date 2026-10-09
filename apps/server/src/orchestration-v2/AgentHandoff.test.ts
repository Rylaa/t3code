import { assert, describe, it } from "@effect/vitest";
import {
  ContextHandoffId,
  MessageId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  HANDOFF_BLOCKED_MESSAGE,
  HANDOFF_SUPERSEDED_MESSAGE,
  automaticContextCommand,
  decideContextZone,
  handoffBlockedByBackgroundWork,
  isHandoffCommand,
  planAgentHandoff,
  recordedActivityBlock,
  withHandoffCommand,
} from "./AgentHandoff.ts";

const usage = (usedTokens: number) => ({ usedTokens, maxTokens: 100 });
const zone = (usedTokens: number, backgroundWork = false) =>
  decideContextZone({
    usage: usage(usedTokens),
    handoffAtPercent: 80,
    compactAtPercent: 92,
    backgroundWork,
  });

describe("decideContextZone", () => {
  it("does nothing below the handoff threshold", () => {
    assert.equal(zone(79), "none");
  });

  it("hands off between the thresholds", () => {
    assert.equal(zone(80), "handoff");
    assert.equal(zone(91), "handoff");
  });

  it("waits in the handoff zone while background work would be lost", () => {
    assert.equal(zone(85, true), "wait");
  });

  it("compacts at or above the compact threshold, even with background work", () => {
    assert.equal(zone(92), "compact");
    assert.equal(zone(99, true), "compact");
  });

  it("never acts for a provider that reports no context window", () => {
    for (const reported of [null, undefined, { usedTokens: 95 }, { usedTokens: 95, maxTokens: 0 }])
      assert.equal(
        decideContextZone({
          usage: reported,
          handoffAtPercent: 80,
          compactAtPercent: 92,
          backgroundWork: false,
        }),
        "none",
      );
  });
});

const now = DateTime.makeUnsafe("2026-10-09T10:00:00.000Z");
const threadId = ThreadId.make("thread:handoff");
const oldRow = ProviderThreadId.make("provider-thread:old");

let itemCount = 0;
function item(
  fields: Record<string, unknown> & Pick<OrchestrationV2TurnItem, "type">,
): OrchestrationV2TurnItem {
  itemCount += 1;
  return {
    id: TurnItemId.make(`item:${itemCount}`),
    threadId,
    runId: RunId.make("run:2"),
    nodeId: "node:2",
    providerThreadId: oldRow,
    status: "completed",
    ordinal: 201,
    ...fields,
  } as OrchestrationV2TurnItem;
}

describe("recordedActivityBlock", () => {
  it("lists checks with their exit status apart from other commands, and changed files", () => {
    const block = recordedActivityBlock([
      item({ type: "command_execution", input: "vp test run src/a.test.ts", exitCode: 1 }),
      item({ type: "command_execution", input: "git status", exitCode: 0 }),
      item({ type: "command_execution", input: "vp run typecheck", status: "running" }),
      item({ type: "file_change", fileName: "src/a.ts" }),
      item({ type: "file_change", fileName: "src/a.ts" }),
    ]);
    assert.include(
      block,
      "Checks run (tests, type checks, lint):\n- `vp test run src/a.test.ts`: exit 1\n- `vp run typecheck`: still running",
    );
    assert.include(block, "Other commands:\n- `git status`: exit 0");
    assert.include(block, "Files changed:\n- src/a.ts");
    assert.notInclude(block, "No commands");
  });

  it("says so when nothing was recorded", () => {
    assert.include(recordedActivityBlock([]), "No commands or file changes were recorded.");
  });
});

describe("planAgentHandoff", () => {
  const run = {
    id: RunId.make("run:2"),
    threadId,
    ordinal: 2,
    status: "completed",
    rootNodeId: "node:2",
    providerThreadId: oldRow,
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus" },
  } as unknown as OrchestrationV2Run;
  const providerThread = {
    id: oldRow,
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    providerSessionId: "session:claude",
  } as unknown as OrchestrationV2ProviderThread;
  const plan = (
    items: ReadonlyArray<OrchestrationV2TurnItem>,
    backgroundWork = false,
    runs: ReadonlyArray<OrchestrationV2Run> = [run],
  ) =>
    planAgentHandoff({
      run,
      runs,
      attempts: [],
      nodes: [],
      providerThread,
      items,
      backgroundWork,
      ids: {
        handoffId: ContextHandoffId.make("handoff:1"),
        providerThreadId: ProviderThreadId.make("provider-thread:fresh"),
        turnItemId: TurnItemId.make("item:handoff"),
      },
      now,
    });
  const document = item({ type: "assistant_message", text: "## Goal\nShip it" });

  it("leaves a notice instead of handing off when background work started", () => {
    const events = plan([document], true);
    assert.lengthOf(events!, 1);
    assert.deepInclude(events![0]!.payload, {
      type: "system_notice",
      message: HANDOFF_BLOCKED_MESSAGE,
    });
  });

  it("leaves a notice when a message already started on the old session", () => {
    const later = { ...run, id: RunId.make("run:3"), ordinal: 3, status: "running" } as const;
    const events = plan([document], false, [run, later]);
    assert.lengthOf(events!, 1);
    assert.deepInclude(events![0]!.payload, {
      type: "system_notice",
      message: HANDOFF_SUPERSEDED_MESSAGE,
    });
    // Queued and cancelled messages never used it, so the handoff still records.
    const records = plan([document], false, [
      run,
      { ...later, status: "queued" },
      { ...run, id: RunId.make("run:4"), ordinal: 4, status: "cancelled" },
    ]);
    assert.isTrue(records!.some((event) => event.type === "context-handoff.updated"));
  });

  it("does nothing when the agent wrote no document", () => {
    assert.isNull(plan([item({ type: "assistant_message", text: "  " })]));
  });
});

describe("handoff gates", () => {
  it("matches only a bare /handoff", () => {
    assert.isTrue(isHandoffCommand({ text: " /HANDOFF ", attachments: [] }));
    assert.isFalse(isHandoffCommand({ text: "/handoff", attachments: [{}] }));
    assert.isFalse(isHandoffCommand({ text: "/handoff now", attachments: [] }));
  });

  it("treats the live roster and running background items as blocking", () => {
    const runs = [{ id: RunId.make("run:1"), ordinal: 1, status: "completed" as const }];
    assert.isFalse(
      handoffBlockedByBackgroundWork({
        providerThread: { pendingBackgroundTasks: [] },
        turnItems: [],
        runs,
      }),
    );
    assert.isTrue(
      handoffBlockedByBackgroundWork({
        providerThread: { pendingBackgroundTasks: [{ taskId: "dev", kind: "command" }] },
        turnItems: [],
        runs,
      }),
    );
    assert.isTrue(
      handoffBlockedByBackgroundWork({
        providerThread: undefined,
        turnItems: [
          {
            id: "item:1",
            type: "command_execution",
            status: "running",
            title: null,
            runId: "run:1",
          },
        ],
        runs,
      }),
    );
  });

  it("counts a persistent monitor, which the old session's end would kill", () => {
    const runs = [{ id: RunId.make("run:1"), ordinal: 1, status: "completed" as const }];
    const monitor = (persistent: boolean) =>
      handoffBlockedByBackgroundWork({
        providerThread: undefined,
        turnItems: [
          {
            id: "item:monitor",
            type: "dynamic_tool",
            status: "running",
            title: null,
            runId: "run:1",
            input: { persistent },
          },
        ],
        runs,
      });
    assert.isTrue(monitor(true));
    assert.isTrue(monitor(false));
  });
});

describe("automaticContextCommand", () => {
  const row = ProviderThreadId.make("provider-thread:active");
  const decide = (input: {
    readonly usedTokens: number;
    /** Usage the latest provider turn reported, which providerThread.contextUsage lags behind. */
    readonly reportedTokens?: number;
    readonly text?: string;
    readonly status?: OrchestrationV2Run["status"];
    readonly running?: boolean;
    readonly canCompact?: boolean;
    readonly goal?: "active" | "paused";
  }) => {
    const action = automaticContextCommand({
      records: {
        runs: [
          {
            id: RunId.make("run:1"),
            ordinal: 1,
            status: input.status ?? "completed",
            userMessageId: MessageId.make("message:1"),
          } as OrchestrationV2Run,
        ],
        attempts: [
          {
            id: "attempt:1",
            runId: RunId.make("run:1"),
            nativeThreadId: "native:1",
            providerThreadId: row,
            rootNodeId: "node:1",
          } as unknown as OrchestrationV2RunAttempt,
        ],
        providerTurns:
          input.reportedTokens === undefined
            ? []
            : [
                {
                  providerThreadId: row,
                  runAttemptId: "attempt:1",
                  nodeId: "node:1",
                  tokenUsage: {
                    usedTokens: input.reportedTokens,
                    maxTokens: 100,
                    updatedAt: "2026-10-09T10:00:00.000Z",
                  },
                } as unknown as OrchestrationV2ProviderTurn,
              ],
        providerThreads: [
          {
            id: row,
            nativeThreadRef: { driver: "claudeAgent", nativeId: "native:1", strength: "strong" },
            pendingBackgroundTasks: [],
            contextUsage: { usedTokens: input.usedTokens, maxTokens: 100 },
            goal: input.goal === undefined ? null : { objective: "Ship", status: input.goal },
          } as unknown as OrchestrationV2ProviderThread,
        ],
        messages: [
          {
            id: MessageId.make("message:1"),
            text: input.text ?? "Keep going",
            attachments: [],
          } as unknown as OrchestrationV2ConversationMessage,
        ],
      },
      activeProviderThreadId: row,
      backgroundTurnItems: input.running
        ? [{ id: "item:bg", type: "subagent", status: "running", title: null, runId: "run:1" }]
        : [],
      handoffAtPercent: 80,
      compactAtPercent: 92,
      canCompact: input.canCompact ?? true,
    });
    return action === "wait" ? action : (action?.command ?? null);
  };

  it("hands off or compacts after an ordinary completed turn", () => {
    assert.equal(decide({ usedTokens: 50 }), null);
    assert.equal(decide({ usedTokens: 85 }), "/handoff");
    assert.equal(decide({ usedTokens: 95 }), "/compact");
  });

  it("measures the turn that just ended, not the usage recorded at its start", () => {
    assert.equal(decide({ usedTokens: 50, reportedTokens: 85 }), "/handoff");
    assert.equal(decide({ usedTokens: 50, reportedTokens: 95 }), "/compact");
  });

  it("never compacts on a provider that cannot", () => {
    assert.equal(decide({ usedTokens: 95, canCompact: false }), null);
    assert.equal(decide({ usedTokens: 85, canCompact: false }), "/handoff");
  });

  it("waits while a workflow or other background work is running", () => {
    assert.equal(decide({ usedTokens: 85, running: true }), "wait");
  });

  it("waits while a goal is active, whose turn would not write the document", () => {
    assert.equal(decide({ usedTokens: 85, goal: "active" }), "wait");
    assert.equal(decide({ usedTokens: 95, goal: "active" }), "/compact");
    assert.equal(decide({ usedTokens: 85, goal: "paused" }), "/handoff");
  });

  it("never follows its own /compact or /handoff, so high usage cannot loop", () => {
    assert.equal(decide({ usedTokens: 95, text: "/compact" }), null);
    assert.equal(decide({ usedTokens: 85, text: "/handoff" }), null);
  });

  it("acts only when the latest run completed", () => {
    assert.equal(decide({ usedTokens: 85, status: "queued" }), null);
    assert.equal(decide({ usedTokens: 85, status: "failed" }), null);
  });
});

describe("withHandoffCommand", () => {
  it("offers T3's /handoff on every provider and workspace catalog, in place of a native one", () => {
    const [provider] = withHandoffCommand([
      {
        slashCommands: [{ name: "compact" }, { name: "handoff", description: "native" }],
        workspaceSnapshots: [{ slashCommands: [] }],
      } as unknown as ServerProvider,
    ]);
    const names = (commands: ReadonlyArray<{ readonly name: string }>) =>
      commands.map((command) => command.name);
    assert.deepEqual(names(provider!.slashCommands), ["compact", "handoff"]);
    assert.notEqual(provider!.slashCommands[1]?.description, "native");
    assert.deepEqual(names(provider!.workspaceSnapshots![0]!.slashCommands), ["handoff"]);
  });
});
