import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderSessionReleaseReactor from "./ProviderSessionReleaseReactor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const providerSessionId = ProviderSessionId.make("session:released-under-run");
const makeAdapter = (
  providerEvents: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>,
) =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(providerEvents),
          backgroundTasksEndWithProcess: true,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: the run has no ingest fiber, as when that fiber stalled.
const layerTest = (
  providerEvents: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>,
) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: "session-release-reactor" },
    ProviderAdapterRegistry.layerFromAdapters([makeAdapter(providerEvents)]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(TestClock.layer()),
  );

it.effect("interrupts a still-running run when its provider session idles out", () =>
  Effect.gen(function* () {
    const providerEvents = yield* Queue.unbounded<
      ProviderAdapter.ProviderAdapterV2Event,
      Cause.Done
    >();
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:session-release");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:session-release"),
        title: "Session release",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send"),
        threadId,
        messageId: MessageId.make("message:session-release"),
        text: "run the tests",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const attempt = before.attempts.find((candidate) => candidate.id === run.activeAttemptId)!;
      const providerThread = before.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      )!;
      const providerTurnId = ProviderTurnId.make("turn:session-release");
      const now = yield* DateTime.now;
      yield* Effect.forEach(
        [
          {
            id: EventId.make("event:session-release:run"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "running", startedAt: now },
          },
          {
            id: EventId.make("event:session-release:attempt"),
            type: "run-attempt.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...attempt, status: "running", startedAt: now },
          },
          {
            id: EventId.make("event:session-release:provider-thread"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: { ...providerThread, status: "active", providerSessionId },
          },
          {
            id: EventId.make("event:session-release:provider-turn"),
            type: "provider-turn.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerTurnId,
              providerThreadId: providerThread.id,
              nodeId: run.rootNodeId!,
              runAttemptId: attempt.id,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        ] as const,
        (event) => projections.apply(event),
      );

      const reactor = yield* ProviderSessionReleaseReactor.make;
      yield* reactor.start();
      const runtime = yield* sessions.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        },
      });
      // The run's subscriber never drains; a second one marks the terminal delivered.
      yield* runtime.subscribeEvents!;
      const observer = yield* runtime.subscribeEvents!;
      yield* Queue.offer(providerEvents, {
        type: "turn.terminal",
        driver,
        providerThreadId: providerThread.id,
        providerTurnId,
        runOrdinal: run.ordinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* observer.events.pipe(Stream.take(1), Stream.runDrain);

      const afterSequence = yield* eventSink.latestSequence();
      const interrupted = yield* eventSink.stream({ afterSequence }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" &&
            event.payload.id === run.id &&
            event.payload.status === "interrupted",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* TestClock.adjust("31 minutes");
      yield* Fiber.join(interrupted);

      const settled = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(settled.runs[0]?.status, "interrupted");
      assert.isTrue(
        settled.turnItems.some(
          (item) =>
            item.type === "run_interrupt_request" &&
            item.message === ProviderSessionReleaseReactor.SESSION_RELEASED_REASON,
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest(providerEvents)));
  }),
);
