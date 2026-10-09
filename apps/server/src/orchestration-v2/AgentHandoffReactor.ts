import { CommandId, type OrchestrationV2DomainEvent, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import {
  automaticContextCommand,
  BACKGROUND_TURN_ITEM_FILTER,
  contextMessageCommand,
} from "./AgentHandoff.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Events that end a turn, or can release the work or request a waiting
 * thread holds for. Other threads' tool calls never cost a read.
 */
function canChangeContextZone(event: OrchestrationV2DomainEvent, waiting: boolean): boolean {
  switch (event.type) {
    case "run.updated":
      return event.payload.status === "completed";
    case "provider-thread.updated":
      return waiting && event.payload.status !== "active";
    case "runtime-request.updated":
      return waiting && event.payload.status !== "pending";
    case "turn-item.updated":
      return waiting && turnItemUpdateCanEndBackgroundWork(event.payload);
    default:
      return false;
  }
}

/**
 * The automatic context policy (`contextHandoffAutoEnabled`), evaluated when a
 * root run completes and again when the work it waited on settles. It sends
 * `/handoff` or `/compact` as a system message; turn start re-checks the rest.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  // Threads whose completed turn is held by background work, a goal or a request.
  const waiting = new Set<ThreadId>();

  /** Returns whether the thread waits, so later background events re-check it. */
  const evaluate = Effect.fn("AgentHandoffReactor.evaluate")(function* (threadId: ThreadId) {
    const settings = yield* settingsService.getSettings;
    if (!settings.contextHandoffAutoEnabled) return false;
    const shell = yield* projections.getThreadShell(threadId);
    if (
      shell === null ||
      shell.archivedAt !== null ||
      // A delegated task ends with its run; its last answer is the parent's result.
      shell.lineage.relationshipToParent === "subagent" ||
      shell.activeRunId !== null
    ) {
      return false;
    }
    if (shell.pendingRuntimeRequest !== null) return true;
    const records = yield* projections.getThreadRecords(
      threadId,
      ["runs", "attempts", "providerThreads", "providerTurns", "messages"],
      { messageRoles: ["user"] },
    );
    const background = yield* projections.getThreadRecords(
      threadId,
      ["turnItems"],
      BACKGROUND_TURN_ITEM_FILTER,
    );
    const instanceId = records.providerThreads.find(
      (providerThread) => providerThread.id === shell.activeProviderThreadId,
    )?.providerInstanceId;
    const action = automaticContextCommand({
      records,
      activeProviderThreadId: shell.activeProviderThreadId,
      backgroundTurnItems: background.turnItems,
      handoffAtPercent: settings.contextHandoffAtPercent,
      compactAtPercent: settings.contextCompactAtPercent,
      // The same signal clients use to offer compaction.
      canCompact: (yield* providerRegistry.getProviders).some(
        (provider) =>
          provider.instanceId === instanceId &&
          provider.slashCommands.some((command) => command.name === "compact"),
      ),
    });
    if (action === null || action === "wait") return action === "wait";
    // One automatic action per completed run, however many events re-evaluate it.
    yield* orchestrator.dispatch(
      contextMessageCommand({
        command: action.command,
        commandId: CommandId.make(`context-auto:${threadId}:${action.runId}`),
        threadId,
        createdBy: "system",
        creationSource: "server",
      }),
    );
    return false;
  });

  const queued = new Set<ThreadId>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(
      Effect.andThen(evaluate(threadId)),
      Effect.map((wait) => {
        if (wait) waiting.add(threadId);
        else waiting.delete(threadId);
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic context handoff failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  // Coalesces a burst of events for one thread into one evaluation.
  const enqueue = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      queued.add(threadId);
      return worker.enqueue(threadId);
    });

  const start = Effect.fn("AgentHandoffReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        canChangeContextZone(event, waiting.has(event.threadId))
          ? enqueue(event.threadId)
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Automatic context handoff event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, drain: worker.drain };
});
