/**
 * The skills, MCP servers and named agents a whole thread used, and what its
 * active provider session loaded. Clients hold only a window of a long
 * thread, so this reads the projection store. Kept apart from thread
 * management because it reads the provider registry, which the core
 * orchestration runtime does not depend on.
 *
 * @module orchestration-v2/ThreadExtensionsService
 */
import {
  type OrchestrationV2ThreadExtensions,
  ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderInventoryStore from "./ProviderInventoryStore.ts";
import { deriveThreadExtensionUsage, providerSkillNames } from "./ThreadExtensionUsage.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ThreadExtensionsService extends Context.Service<
  ThreadExtensionsService,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationV2ThreadExtensions, Orchestrator.OrchestratorV2Error>;
  }
>()("t3/orchestration-v2/ThreadExtensionsService") {}

/** The one driver that reports its session's loaded skills, plugins, MCP servers and agents. */
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const inventories = yield* ProviderInventoryStore.ProviderInventoryStore;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  const get = Effect.fn("ThreadExtensionsService.get")(function* (threadId: ThreadId) {
    // Reading records through thread management imports a legacy transcript first.
    const records = yield* threadManagement.getThreadRecords(threadId, [
      "providerThreads",
      "providerSessions",
    ]);
    const [items, providers] = yield* Effect.all([
      orchestrator.getExtensionUsageItems(threadId),
      providerRegistry.getProviders,
    ]);
    const activeProviderThread = records.providerThreads.find(
      (providerThread) => providerThread.id === records.thread.activeProviderThreadId,
    );
    // A thread whose session has not started yet, such as a new thread or a
    // fork, runs on its configured provider instance.
    const provider = providers.find(
      (candidate) =>
        candidate.instanceId ===
        (activeProviderThread?.providerInstanceId ?? records.thread.providerInstanceId),
    );
    // Only Claude reports what its session loaded. Before its first turn it
    // has loaded nothing so far, so it reads as pending.
    const reportsInventory = (activeProviderThread?.driver ?? provider?.driver) === CLAUDE_DRIVER;
    const inventory =
      activeProviderThread === undefined || !reportsInventory
        ? null
        : yield* inventories.get(activeProviderThread.id).pipe(
            // The panel still lists usage when the inventory can't be read.
            Effect.catchTags({
              ProviderInventoryStoreError: (cause) =>
                Effect.logWarning("orchestration-v2.provider-inventory.read-failed", {
                  threadId,
                  cause,
                }).pipe(Effect.as(null)),
            }),
          );
    // Without an inventory, the skills the provider discovered tell a `$skill`
    // mention from a shell variable.
    const sessionCwd = records.providerSessions.find(
      (session) => session.id === activeProviderThread?.providerSessionId,
    )?.cwd;
    const providerSkills =
      inventory !== null || provider === undefined
        ? []
        : providerSkillNames(provider, sessionCwd ?? records.thread.worktreePath);
    return {
      used: deriveThreadExtensionUsage(items, inventory, providerSkills),
      inventoryStatus: !reportsInventory
        ? ("unsupported" as const)
        : inventory === null
          ? ("pending" as const)
          : ("available" as const),
      inventory,
    };
  });

  return ThreadExtensionsService.of({ get });
});

export const layer = Layer.effect(ThreadExtensionsService, make);
