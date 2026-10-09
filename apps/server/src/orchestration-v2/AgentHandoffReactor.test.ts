import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentHandoffReactor from "./AgentHandoffReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const threadId = ThreadId.make("thread:auto-handoff");
const row = ProviderThreadId.make("provider-thread:auto");
const runId = RunId.make("run:1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const runCompleted = {
  type: "run.updated",
  threadId,
  payload: { status: "completed" },
} as unknown as OrchestrationV2DomainEvent;

/** A background item ending: what releases a thread that waits. */
const backgroundEnded = (thread = threadId) =>
  ({
    type: "turn-item.updated",
    threadId: thread,
    payload: { type: "subagent", status: "completed" },
  }) as unknown as OrchestrationV2DomainEvent;

/**
 * Runs the reactor over `stream` (by default `events` completed-run events),
 * then `body`, and returns what it dispatched and which threads it read.
 */
const dispatchedFor = (
  input: {
    readonly usedTokens: number;
    readonly autoEnabled?: boolean;
    readonly shell?: Partial<OrchestrationV2ThreadShell>;
    readonly canCompact?: boolean;
    readonly events?: number;
    /** Running background items the policy sees; a test may clear them mid-stream. */
    readonly background?: Ref.Ref<ReadonlyArray<unknown>>;
    readonly stream?: Stream.Stream<OrchestrationV2DomainEvent>;
  },
  body: (reactor: { readonly drain: Effect.Effect<void> }) => Effect.Effect<void> = () =>
    Effect.void,
) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const shellReads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const streamed = yield* Deferred.make<void>();
    const records = {
      runs: [{ id: runId, ordinal: 1, status: "completed", userMessageId: MessageId.make("m:1") }],
      attempts: [],
      providerTurns: [],
      providerThreads: [
        {
          id: row,
          providerInstanceId: instanceId,
          nativeThreadRef: null,
          pendingBackgroundTasks: [],
          contextUsage: { usedTokens: input.usedTokens, maxTokens: 100 },
        },
      ],
      messages: [{ id: MessageId.make("m:1"), text: "Keep going", attachments: [] }],
    };
    const layer = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.concat(
          input.stream ??
            Stream.fromIterable(Array.from({ length: input.events ?? 1 }, () => runCompleted)),
          Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.drain),
        ),
        dispatch: (command) =>
          Ref.update(dispatched, (all) => [...all, command]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (thread) =>
          Ref.update(shellReads, (all) => [...all, thread]).pipe(
            Effect.as({
              id: threadId,
              archivedAt: null,
              lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
              pendingRuntimeRequest: null,
              activeRunId: null,
              activeProviderThreadId: row,
              ...input.shell,
            } as OrchestrationV2ThreadShell),
          ),
        getThreadRecords: ((_threadId: ThreadId, fields: ReadonlyArray<string>) =>
          fields.includes("turnItems")
            ? Effect.map(
                input.background ? Ref.get(input.background) : Effect.succeed([]),
                (turnItems) => ({
                  turnItems,
                }),
              )
            : Effect.succeed(records)) as never,
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          contextHandoffAutoEnabled: input.autoEnabled ?? true,
        }),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([
          {
            instanceId,
            slashCommands: input.canCompact === false ? [] : [{ name: "compact" }],
          } as unknown as ServerProvider,
        ]),
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* AgentHandoffReactor.make;
        yield* reactor.start();
        yield* body(reactor);
        yield* Deferred.await(streamed);
        yield* reactor.drain;
      }),
    ).pipe(Effect.provide(layer));
    return { dispatched: yield* Ref.get(dispatched), shellReads: yield* Ref.get(shellReads) };
  });

describe("AgentHandoffReactor", () => {
  it.effect("sends one system /handoff per completed run in the handoff zone", () =>
    Effect.gen(function* () {
      const { dispatched } = yield* dispatchedFor({ usedTokens: 85, events: 3 });
      assert.lengthOf(dispatched, 1);
      assert.deepInclude(dispatched[0] as object, {
        type: "message.dispatch",
        commandId: `context-auto:${threadId}:${runId}`,
        threadId,
        text: "/handoff",
        attachments: [],
        createdBy: "system",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      });
      assert.notProperty(dispatched[0] as object, "modelSelection");
    }),
  );

  it.effect("compacts past the compact point only where the provider can", () =>
    Effect.gen(function* () {
      const [compact] = (yield* dispatchedFor({ usedTokens: 95 })).dispatched;
      assert.deepInclude(compact as object, { text: "/compact" });
      assert.lengthOf((yield* dispatchedFor({ usedTokens: 95, canCompact: false })).dispatched, 0);
    }),
  );

  it.effect("does nothing while off, waiting on the user, busy, or in a delegated task", () =>
    Effect.gen(function* () {
      for (const input of [
        { usedTokens: 85, autoEnabled: false },
        { usedTokens: 85, shell: { pendingRuntimeRequest: {} } },
        { usedTokens: 85, shell: { activeRunId: RunId.make("run:2") } },
        { usedTokens: 85, shell: { archivedAt: DateTime.makeUnsafe("2026-10-09T10:00:00.000Z") } },
        {
          usedTokens: 85,
          shell: {
            lineage: {
              rootThreadId: ThreadId.make("thread:parent"),
              parentThreadId: ThreadId.make("thread:parent"),
              relationshipToParent: "subagent" as const,
            },
          },
        },
      ] as const) {
        assert.lengthOf(
          (yield* dispatchedFor(input as never)).dispatched,
          0,
          JSON.stringify(input),
        );
      }
    }),
  );

  it.effect("waits while background work runs, then hands off once it ends", () =>
    Effect.gen(function* () {
      const background = yield* Ref.make<ReadonlyArray<unknown>>([
        { id: "item:workflow", type: "subagent", status: "running", title: null, runId },
      ]);
      const evaluated = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const { dispatched } = yield* dispatchedFor(
        {
          usedTokens: 85,
          background,
          stream: Stream.concat(
            Stream.make(runCompleted),
            Stream.fromEffect(
              Deferred.succeed(evaluated, undefined).pipe(
                Effect.andThen(Deferred.await(released)),
                Effect.as(backgroundEnded()),
              ),
            ),
          ),
        },
        (reactor) =>
          Effect.gen(function* () {
            yield* Deferred.await(evaluated);
            yield* reactor.drain;
            yield* Ref.set(background, []);
            yield* Deferred.succeed(released, undefined);
          }),
      );
      assert.lengthOf(dispatched, 1);
      assert.deepInclude(dispatched[0] as object, { text: "/handoff" });
    }),
  );

  it.effect("ignores tool calls ending on threads that are not waiting", () =>
    Effect.gen(function* () {
      const { shellReads } = yield* dispatchedFor({
        usedTokens: 85,
        stream: Stream.make(backgroundEnded(ThreadId.make("thread:busy"))),
      });
      assert.lengthOf(shellReads, 0);
    }),
  );
});
