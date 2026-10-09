import {
  type CommandId,
  type ContextHandoffId,
  MessageId,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2CreationSource,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
  type RunId,
  type ServerProvider,
  type ServerProviderSlashCommand,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type TurnItemId,
} from "@t3tools/contracts";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { latestNativeContextUsage } from "@t3tools/provider-core/server/handoffBudget";
import type * as DateTime from "effect/DateTime";

/**
 * "Handoff & continue": the agent writes a handoff document on its current
 * session, then the thread continues in a fresh native session of the same
 * model whose next turn receives the document. Web, mobile, agents (MCP) and
 * the automatic policy all start it by sending this message.
 */
export const HANDOFF_COMMAND = "/handoff";

export function isHandoffCommand(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}): boolean {
  return message.attachments.length === 0 && message.text.trim().toLowerCase() === HANDOFF_COMMAND;
}

/** How the server starts a handoff (or compaction) for an agent or the automatic policy. */
export function contextMessageCommand(input: {
  readonly command: typeof HANDOFF_COMMAND | "/compact";
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}): OrchestrationV2Command {
  const { command, ...creation } = input;
  return {
    ...creation,
    type: "message.dispatch",
    messageId: MessageId.make(input.commandId),
    text: command,
    attachments: [],
    // Behind an active turn it waits; the agent calling it is usually that turn.
    dispatchMode: { type: "queue_after_active" },
  };
}

const HANDOFF_SLASH_COMMAND: ServerProviderSlashCommand = {
  name: "handoff",
  description: "Write a handoff document and continue in a fresh session",
};

/** T3 runs `/handoff` on any adapter, so every provider's slash menu offers it. */
export function withHandoffCommand(providers: ReadonlyArray<ServerProvider>): ServerProvider[] {
  const commands = (items: ReadonlyArray<ServerProviderSlashCommand>) => [
    ...items.filter((command) => command.name !== HANDOFF_SLASH_COMMAND.name),
    HANDOFF_SLASH_COMMAND,
  ];
  return providers.map((provider) => ({
    ...provider,
    slashCommands: commands(provider.slashCommands),
    ...(provider.workspaceSnapshots
      ? {
          workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
            ...snapshot,
            slashCommands: commands(snapshot.slashCommands),
          })),
        }
      : {}),
  }));
}

/** Sent to the provider in place of the `/handoff` text. */
export const HANDOFF_PROMPT = `Write a handoff document for a fresh session of yourself that will continue this work. That session will see only this document, not this conversation.

Use these Markdown sections, in this order:
## Goal: what the user wants overall, in their words where possible.
## Done: what was completed.
## Tested: what you verified and how, with the commands and their results. List only checks you actually ran.
## Not tested: what is unverified or only partly checked.
## Decisions: decisions made and why, including options you rejected.
## Open questions: anything that needs the user's decision or input.
## Next steps: the concrete next actions, in order.
## Files: files created or changed, one line each on what changed.

Be specific: name files, functions, commands and error messages. Keep it under 1,500 words. Do not change anything now; reply with the document only.`;

export const HANDOFF_BLOCKED_MESSAGE =
  "A workflow or background task is still running, and a fresh session would stop it. Wait for it to finish, press Stop, or use /compact.";

// An active goal also keeps the handoff turn working on the goal instead of writing the document.
export const HANDOFF_GOAL_MESSAGE =
  "A goal is active, and a fresh session would drop it. Clear it with /goal clear, or use /compact.";

export const HANDOFF_SUPERSEDED_MESSAGE =
  "A message started in this session before the handoff was recorded, so the thread stays in it. Send /handoff again.";

/** Narrows a turn-item read to the items that can hold background work. */
export const BACKGROUND_TURN_ITEM_FILTER = {
  turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
  turnItemStatuses: ["pending", "running", "waiting"],
} as const;

/**
 * Work a fresh native session would orphan or kill: the provider's live roster
 * (workflows, subagents, monitors, background shells) and running background
 * items, persistent monitors included. Unlike `backgroundWorkHoldsCompletion`, a
 * dev server counts: closing a Claude process kills its shells. Pull request
 * watches are T3's and survive.
 */
export function handoffBlockedByBackgroundWork(input: {
  readonly providerThread:
    | Pick<OrchestrationV2ProviderThread, "pendingBackgroundTasks">
    | undefined;
  readonly turnItems: Parameters<typeof pendingBackgroundTurnItems>[0]["turnItems"];
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>;
}): boolean {
  return (
    (input.providerThread?.pendingBackgroundTasks?.length ?? 0) > 0 ||
    pendingBackgroundTurnItems({
      turnItems: input.turnItems,
      runs: input.runs,
      includePersistent: true,
    }).length > 0
  );
}

export type ContextZone = "none" | "handoff" | "wait" | "compact";

/**
 * The automatic policy at a turn boundary. Below `handoffAtPercent` nothing
 * happens; up to `compactAtPercent` the thread hands off, or waits while
 * background work would be lost; at or above it the provider compacts natively,
 * which keeps that work alive. A provider that reports no window never acts.
 */
export function decideContextZone(input: {
  readonly usage: Pick<ThreadTokenUsageSnapshot, "usedTokens" | "maxTokens"> | null | undefined;
  readonly handoffAtPercent: number;
  readonly compactAtPercent: number;
  readonly backgroundWork: boolean;
}): ContextZone {
  const maxTokens = input.usage?.maxTokens;
  if (input.usage == null || maxTokens === undefined || maxTokens <= 0) return "none";
  const usedPercent = (input.usage.usedTokens / maxTokens) * 100;
  if (usedPercent >= input.compactAtPercent) return "compact";
  if (usedPercent < input.handoffAtPercent) return "none";
  return input.backgroundWork ? "wait" : "handoff";
}

/**
 * What the automatic policy sends once a root run completes, if anything:
 * only after an ordinary completed turn, never right after a /compact or
 * /handoff, so a compaction that leaves usage high cannot loop. `wait` means
 * background work or an active goal holds the handoff; check again when it settles.
 */
export function automaticContextCommand(input: {
  readonly records: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "providerThreads" | "providerTurns" | "messages"
  >;
  readonly activeProviderThreadId: ProviderThreadId | null;
  readonly backgroundTurnItems: Parameters<typeof pendingBackgroundTurnItems>[0]["turnItems"];
  readonly handoffAtPercent: number;
  readonly compactAtPercent: number;
  /** Whether the active provider advertises `/compact`; without it the compact zone does nothing. */
  readonly canCompact: boolean;
}):
  | { readonly command: typeof HANDOFF_COMMAND | "/compact"; readonly runId: RunId }
  | "wait"
  | null {
  const { records } = input;
  const latestRun = records.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
    undefined,
  );
  const message = records.messages.find((entry) => entry.id === latestRun?.userMessageId);
  const providerThread = records.providerThreads.find(
    (entry) => entry.id === input.activeProviderThreadId,
  );
  if (
    latestRun?.status !== "completed" ||
    message === undefined ||
    isHandoffCommand(message) ||
    (message.attachments.length === 0 && message.text.trim().toLowerCase() === "/compact") ||
    providerThread === undefined
  ) {
    return null;
  }
  const measured = latestNativeContextUsage(records, providerThread);
  const zone = decideContextZone({
    usage: measured
      ? { ...providerThread.contextUsage, ...measured.usage }
      : providerThread.contextUsage,
    handoffAtPercent: input.handoffAtPercent,
    compactAtPercent: input.compactAtPercent,
    backgroundWork:
      providerThread.goal?.status === "active" ||
      handoffBlockedByBackgroundWork({
        providerThread,
        turnItems: input.backgroundTurnItems,
        runs: records.runs,
      }),
  });
  if (zone === "handoff") return { command: HANDOFF_COMMAND, runId: latestRun.id };
  if (zone === "wait") return "wait";
  return zone === "compact" && input.canCompact
    ? { command: "/compact", runId: latestRun.id }
    : null;
}

const CHECK_COMMAND =
  /\b(test|tests|vitest|jest|pytest|mocha|rspec|phpunit|spec|typecheck|tsc|lint|check|clippy)\b/i;

function commandLine(item: Extract<OrchestrationV2TurnItem, { type: "command_execution" }>) {
  const line = item.input.trim().split("\n")[0] ?? "";
  const command = line.length > 160 ? `${line.slice(0, 157)}...` : line;
  const outcome =
    item.exitCode !== undefined
      ? `exit ${item.exitCode}`
      : item.status === "failed"
        ? "failed"
        : item.status === "interrupted" || item.status === "cancelled"
          ? "stopped"
          : item.status === "completed"
            ? "exit unknown"
            : "still running";
  return `- \`${command.replaceAll("`", "'")}\`: ${outcome}`;
}

/**
 * Activity T3 saw since the last handoff, appended to the agent's document so
 * its "Tested" section can be checked against what actually ran.
 */
export function recordedActivityBlock(items: ReadonlyArray<OrchestrationV2TurnItem>): string {
  const commands = items.filter(
    (item): item is Extract<OrchestrationV2TurnItem, { type: "command_execution" }> =>
      item.type === "command_execution" && item.input.trim() !== "",
  );
  const checks = commands.filter((item) => CHECK_COMMAND.test(item.input));
  const others = commands.filter((item) => !CHECK_COMMAND.test(item.input));
  const files = [
    ...new Set(items.flatMap((item) => (item.type === "file_change" ? [item.fileName] : []))),
  ];
  const sections = [
    ["Checks run (tests, type checks, lint)", checks.slice(-30).map(commandLine), checks.length],
    ["Other commands", others.slice(-15).map(commandLine), others.length],
    ["Files changed", files.slice(-40).map((file) => `- ${file}`), files.length],
  ] as const;
  const body = sections
    .filter(([, lines]) => lines.length > 0)
    .map(
      ([title, lines, total]) =>
        `${title}${total > lines.length ? ` (latest ${lines.length} of ${total})` : ""}:\n${lines.join("\n")}`,
    );
  return [
    "## Recorded by T3",
    "T3 recorded this from the thread itself; the agent did not write it.",
    ...(body.length === 0 ? ["No commands or file changes were recorded."] : body),
  ].join("\n\n");
}

/** Whether a message started after `run`; queued or cancelled ones never used its session. */
export function runStartedAfter(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status">>,
  run: Pick<OrchestrationV2Run, "ordinal">,
): boolean {
  return runs.some(
    (candidate) =>
      candidate.ordinal > run.ordinal &&
      candidate.status !== "queued" &&
      candidate.status !== "cancelled",
  );
}

/**
 * Records a completed `/handoff` run: a ready `manual_context` handoff holding
 * the agent's document plus T3's record, and a fresh provider thread on the
 * same instance, session and model that becomes the thread's active one. Its
 * next turn opens a new native session and receives the document. Messages
 * queued behind the handoff move to the fresh thread too. Background work
 * started during the handoff turn, or a message that already started on the
 * old session, leaves a notice instead. Returns null when the agent wrote no
 * document.
 */
export function planAgentHandoff(input: {
  readonly run: OrchestrationV2Run;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly providerThread: OrchestrationV2ProviderThread;
  /** Items of the runs on `providerThread`: everything since the last handoff. */
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly backgroundWork: boolean;
  readonly ids: {
    readonly handoffId: ContextHandoffId;
    readonly providerThreadId: ProviderThreadId;
    readonly turnItemId: TurnItemId;
  };
  readonly now: DateTime.Utc;
}): ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> | null {
  const { run, providerThread, now } = input;
  const document = input.items
    .findLast(
      (item): item is Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> =>
        item.type === "assistant_message" &&
        item.runId === run.id &&
        item.nodeId === run.rootNodeId,
    )
    ?.text.trim();
  if (!document) return null;
  const base = { threadId: run.threadId, occurredAt: now } as const;
  const itemFields = {
    id: input.ids.turnItemId,
    threadId: run.threadId,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: providerThread.id,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal:
      Math.max(
        0,
        ...input.items.filter((item) => item.runId === run.id).map((item) => item.ordinal),
      ) + 1,
    status: "completed",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  } as const;
  const itemEvent = (payload: OrchestrationV2TurnItem) =>
    ({
      ...base,
      type: "turn-item.updated",
      runId: run.id,
      ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
      providerInstanceId: run.providerInstanceId,
      payload,
    }) as const;
  const startedLater = runStartedAfter(input.runs, run);
  if (input.backgroundWork || startedLater) {
    return [
      itemEvent({
        ...itemFields,
        title: "Handoff not applied",
        type: "system_notice",
        message: startedLater ? HANDOFF_SUPERSEDED_MESSAGE : HANDOFF_BLOCKED_MESSAGE,
      }),
    ];
  }
  const coveredOrdinals = input.runs
    .filter((candidate) => candidate.providerThreadId === providerThread.id)
    .map((candidate) => candidate.ordinal);
  const handoff: OrchestrationV2ContextHandoff = {
    id: input.ids.handoffId,
    threadId: run.threadId,
    targetRunId: run.id,
    fromProviderThreadIds: [providerThread.id],
    toProviderThreadId: input.ids.providerThreadId,
    coveredRunOrdinals: { from: Math.min(run.ordinal, ...coveredOrdinals), to: run.ordinal },
    strategy: "manual_context",
    status: "ready",
    summaryMessageId: null,
    summaryText: `${document}\n\n${recordedActivityBlock(input.items)}`,
    createdByProviderInstanceId: run.providerInstanceId,
    createdAt: now,
    updatedAt: now,
  };
  // Keeps the session id; recording detaches the old runtime, so the next turn
  // opens a new one with no native session to resume.
  const fresh: OrchestrationV2ProviderThread = {
    id: input.ids.providerThreadId,
    driver: providerThread.driver,
    providerInstanceId: providerThread.providerInstanceId,
    providerSessionId: providerThread.providerSessionId,
    appThreadId: run.threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [handoff.id],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: now,
    updatedAt: now,
  };
  const item: OrchestrationV2TurnItem = {
    ...itemFields,
    title: "Handoff & continue",
    type: "handoff",
    contextHandoffId: handoff.id,
    fromProviderThreadIds: [providerThread.id],
    toProviderThreadId: fresh.id,
    fromProviderInstanceIds: [run.providerInstanceId],
    toProviderInstanceId: run.providerInstanceId,
    fromModelSelections: [run.modelSelection],
    toModel: run.modelSelection.model,
    strategy: "manual_context",
    summary: handoff.summaryText,
  };
  const queued = input.runs.filter(
    (candidate) =>
      candidate.status === "queued" &&
      candidate.providerThreadId === providerThread.id &&
      candidate.providerInstanceId === run.providerInstanceId,
  );
  return [
    {
      ...base,
      type: "context-handoff.updated",
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      payload: handoff,
    },
    itemEvent(item),
    // Queued messages were pinned to the old provider thread when they queued.
    ...queued.flatMap((queuedRun) => {
      const at = { ...base, runId: queuedRun.id, providerInstanceId: queuedRun.providerInstanceId };
      const attempt = input.attempts.find((entry) => entry.id === queuedRun.activeAttemptId);
      const node = input.nodes.find((entry) => entry.id === queuedRun.rootNodeId);
      return [
        { ...at, type: "run.updated", payload: { ...queuedRun, providerThreadId: fresh.id } },
        ...(attempt === undefined
          ? []
          : [
              {
                ...at,
                type: "run-attempt.updated",
                payload: { ...attempt, providerThreadId: fresh.id },
              },
            ]),
        ...(node === undefined
          ? []
          : [{ ...at, type: "node.updated", payload: { ...node, providerThreadId: fresh.id } }]),
      ] as ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>;
    }),
    // Last: the projection makes the latest updated root provider thread the active one.
    {
      ...base,
      type: "provider-thread.updated",
      providerInstanceId: providerThread.providerInstanceId,
      payload: fresh,
    },
  ];
}
