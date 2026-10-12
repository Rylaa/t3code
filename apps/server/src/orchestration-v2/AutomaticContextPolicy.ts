import {
  CommandId,
  type OrchestrationV2Command,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  automaticContextCommand,
  BACKGROUND_TURN_ITEM_FILTER,
  contextMessageCommand,
} from "./AgentHandoff.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * The automatic context policy (`contextHandoffAutoEnabled`) for a thread whose
 * turn just ended: the `/handoff` or `/compact` message to send, `"wait"` while
 * background work, a goal or a request holds it, or null. The orchestrator asks
 * before queued messages start; `AgentHandoffReactor` asks after every other
 * turn end and again when the work it waited on settles.
 */
export class AutomaticContextPolicy extends Context.Service<
  AutomaticContextPolicy,
  {
    readonly decide: (
      threadId: ThreadId,
    ) => Effect.Effect<
      OrchestrationV2Command | "wait" | null,
      ProjectionStore.ProjectionStoreV2Error | ServerSettingsError
    >;
  }
>()("t3/orchestration-v2/AutomaticContextPolicy") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  const decide = Effect.fn("AutomaticContextPolicy.decide")(function* (threadId: ThreadId) {
    const settings = yield* settingsService.getSettings;
    if (!settings.contextHandoffAutoEnabled) return null;
    const shell = yield* projections.getThreadShell(threadId);
    if (
      shell === null ||
      shell.archivedAt !== null ||
      // A delegated task ends with its run; its last answer is the parent's result.
      shell.lineage.relationshipToParent === "subagent" ||
      shell.activeRunId !== null
    ) {
      return null;
    }
    if (shell.pendingRuntimeRequest !== null) return "wait";
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
    if (action === null || action === "wait") return action;
    return contextMessageCommand({
      command: action.command,
      // One automatic action per completed run, however many times it is decided.
      commandId: CommandId.make(`context-auto:${threadId}:${action.runId}`),
      threadId,
      createdBy: "system",
      creationSource: "server",
    });
  });

  return AutomaticContextPolicy.of({ decide });
});

export const layer = Layer.effect(AutomaticContextPolicy, make);
