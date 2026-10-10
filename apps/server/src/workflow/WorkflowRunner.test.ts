import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WorkflowRunner from "./WorkflowRunner.ts";

// The engine caps concurrent agent() calls by CPU count; pin it so parallel children overlap on any host.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOS>();
  return { ...actual, availableParallelism: () => 10 };
});

type Service = OrchestratorMcpService.OrchestratorMcpServiceShape;
type DelegateInput = Parameters<Service["delegateChild"]>[1];
type Outcome = Effect.Success<ReturnType<Service["awaitTask"]>>;

interface Child {
  readonly taskId: NodeId;
  readonly input: DelegateInput;
  readonly outcome: Deferred.Deferred<Outcome>;
}

const PARENT = ThreadId.make("thread:workflow-parent");
const OTHER = ThreadId.make("thread:workflow-other");
const TURN = RunId.make("run:workflow-turn");
const NEXT_TURN = RunId.make("run:workflow-next-turn");
const TURN_ENDED = "The turn that started this workflow ended before it finished";

// The real `t3 workflow-sandbox`, run from source; Node strips the types.
const sandbox = {
  command: process.execPath,
  args: [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), "workflow-sandbox"],
};

/** The fields of a run that the runner reads. */
const turn = (id: RunId, status: OrchestrationV2Run["status"]) =>
  ({ id, ordinal: id === TURN ? 1 : 2, status }) as unknown as OrchestrationV2Run;

const runUpdated = (id: RunId, status: OrchestrationV2Run["status"], sequence = 1) =>
  ({
    sequence,
    commandId: null,
    event: { type: "run.updated", payload: turn(id, status) },
  }) as unknown as OrchestrationV2StoredEvent;

const callerScope = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:workflow"),
  requestNamespace: `provider-session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const startInput = (
  script: string,
  input: { readonly args?: string | undefined; readonly waitMs?: number } = {},
) => ({ script, args: input.args, title: undefined, waitMs: input.waitMs });

const completed = (summary: string): Outcome => ({ status: "completed", summary });

/**
 * The real runner and engine over a scripted OrchestratorMcpService: every
 * delegated child waits on its own Deferred, settled by `respond` or by the test.
 * Every thread is in turn TURN; each watcher of its run updates replays the stored
 * events after its cursor, then gets its own queue. With `endTurnOnRead`, the turn
 * ends just after the next runs read, as one more stored event.
 */
const makeHarness = (
  options: {
    readonly respond?: (input: DelegateInput) => Outcome | undefined;
    readonly refuse?: (input: DelegateInput) => Effect.Effect<OrchestratorMcpFailure | undefined>;
    readonly shell?: (threadId: ThreadId) => OrchestrationV2ThreadShell;
  } = {},
) =>
  Effect.gen(function* () {
    const children: Array<Child> = [];
    const cancelled: Array<NodeId> = [];
    const started = yield* Queue.unbounded<Child>();
    const watchers = yield* Queue.unbounded<Queue.Queue<OrchestrationV2StoredEvent>>();
    const state = {
      runs: [turn(TURN, "running")],
      watching: 0,
      sequence: 0,
      stored: [] as Array<OrchestrationV2StoredEvent>,
      cursors: [] as Array<number | undefined>,
      endTurnOnRead: false,
    };
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(options.shell?.(threadId) ?? liveThreadShell(threadId)),
        getThreadEventSequence: () => Effect.sync(() => state.sequence),
        getThreadRecords: () =>
          Effect.sync(() => {
            const runs = state.runs;
            if (state.endTurnOnRead) {
              state.endTurnOnRead = false;
              state.runs = [turn(TURN, "completed")];
              state.stored.push(runUpdated(TURN, "completed", ++state.sequence));
            }
            return { runs } as unknown as OrchestrationV2ThreadProjection;
          }),
        // Like the event store, a stream without a cursor replays from the first event.
        streamStoredEventsFrom: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
              state.cursors.push(input?.afterSequence);
              state.watching++;
              yield* Effect.addFinalizer(() => Effect.sync(() => state.watching--));
              yield* Queue.offer(watchers, events);
              const replayed = state.stored.filter(
                ({ sequence }) => sequence > (input?.afterSequence ?? 0),
              );
              return Stream.concat(Stream.fromIterable(replayed), Stream.fromQueue(events));
            }),
          ),
      }),
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        delegateChild: (_scope, input) =>
          Effect.gen(function* () {
            const refusal = options.refuse ? yield* options.refuse(input) : undefined;
            if (refusal !== undefined) return yield* refusal;
            const child: Child = {
              taskId: NodeId.make(`node:workflow-child-${children.length}`),
              input,
              outcome: yield* Deferred.make<Outcome>(),
            };
            children.push(child);
            const reply = options.respond?.(input);
            if (reply !== undefined) yield* Deferred.succeed(child.outcome, reply);
            yield* Queue.offer(started, child);
            return { taskId: child.taskId, childThreadId: ThreadId.make(`thread:${child.taskId}`) };
          }),
        awaitTask: (_scope, taskId) =>
          Deferred.await(children.find((child) => child.taskId === taskId)!.outcome),
        cancelTask: (_scope, input) =>
          Effect.sync(() => {
            cancelled.push(input.taskId);
            return { taskId: input.taskId, status: "cancel_requested" as const };
          }),
      }),
    );
    return {
      children,
      cancelled,
      started,
      watchers,
      state,
      layer: WorkflowRunner.layerWithSandbox(sandbox).pipe(Layer.provide(dependencies)),
    };
  });

describe("WorkflowRunner", () => {
  it.effect("returns the script's value with phase, recent log and agents counted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: (input) => completed(`answer:${input.task}`),
      });
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const result = yield* runner.start(callerScope(PARENT), {
          script: `
            phase("Research");
            for (let line = 1; line <= 12; line++) log("line " + line);
            const [a, b] = await parallel([
              () => agent("alpha", { label: "First" }),
              () => agent("beta", { model: "gpt-5.5" }),
            ]);
            return { a, b, topic: args.topic };
          `,
          args: `{"topic":"tides"}`,
          title: "Survey",
          waitMs: undefined,
        });

        assert.equal(result.status, "completed");
        assert.equal(result.title, "Survey");
        assert.deepEqual(JSON.parse(result.result ?? ""), {
          a: "answer:alpha",
          b: "answer:beta",
          topic: "tides",
        });
        assert.equal(result.resultTruncated, false);
        assert.equal(result.error, null);
        assert.deepEqual(result.progress, {
          phase: "Research",
          recentLog: Array.from({ length: 10 }, (_, index) => `line ${index + 3}`),
          agents: { started: 2, running: 0, completed: 2, failed: 0 },
        });
        assert.deepEqual(
          harness.children.map(({ input }) => [input.task, input.title, input.model]).toSorted(),
          [
            ["alpha", "First", undefined],
            ["beta", "Workflow agent 1", "gpt-5.5"],
          ],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("returns running after waitMs, then workflow_wait returns the finished run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const starting = yield* runner
          .start(callerScope(PARENT), startInput(`return await agent("slow");`, { waitMs: 1_000 }))
          .pipe(Effect.forkChild);
        const child = yield* Queue.take(harness.started);
        yield* TestClock.adjust(1_000);
        const pending = yield* Fiber.join(starting);

        assert.equal(pending.status, "running");
        assert.equal(pending.result, null);
        assert.deepEqual(pending.progress.agents, {
          started: 1,
          running: 1,
          completed: 0,
          failed: 0,
        });

        yield* Deferred.succeed(child.outcome, completed("done"));
        const finished = yield* runner.wait(callerScope(PARENT), {
          runId: pending.runId,
          waitMs: undefined,
          resultOffset: undefined,
        });
        assert.equal(finished.status, "completed");
        assert.equal(finished.result, `"done"`);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("pages a long result in 30,000-character slices from resultOffset", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const first = yield* runner.start(
          callerScope(PARENT),
          startInput(`return "ab".repeat(35000);`),
        );
        const page = (resultOffset: number) =>
          runner.wait(callerScope(PARENT), { runId: first.runId, waitMs: 0, resultOffset });
        const second = yield* page(30_000);
        const third = yield* page(60_000);

        const full = JSON.stringify("ab".repeat(35_000));
        assert.deepEqual(
          [first, second, third].map((slice) => [
            slice.resultOffset,
            slice.result?.length,
            slice.resultChars,
            slice.resultTruncated,
          ]),
          [
            [0, 30_000, full.length, true],
            [30_000, 30_000, full.length, true],
            [60_000, full.length - 60_000, full.length, false],
          ],
        );
        assert.equal(`${first.result}${second.result}${third.result}`, full);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses non-thread callers, threads without Full access, and subagents", () =>
    Effect.gen(function* () {
      const SUBAGENT = ThreadId.make("thread:workflow-subagent");
      const ASKING = ThreadId.make("thread:workflow-asking");
      const harness = yield* makeHarness({
        shell: (threadId) => {
          const shell = liveThreadShell(threadId, {
            runtimeMode: threadId === ASKING ? "approval-required" : "full-access",
          });
          return threadId === SUBAGENT
            ? {
                ...shell,
                lineage: {
                  rootThreadId: PARENT,
                  parentThreadId: PARENT,
                  relationshipToParent: "subagent",
                },
              }
            : shell;
        },
      });
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const refuse = (scope: McpInvocationScope, args?: string) =>
          runner.start(scope, startInput(`return 1;`, { args })).pipe(Effect.flip);

        const client = yield* refuse({ ...callerScope(PARENT), thread: undefined });
        assert.equal(client.code, "thread_credential_required");

        const asking = yield* refuse(callerScope(ASKING));
        assert.equal(asking.code, "capability_denied");
        assert.include(asking.message, "needs Full access");

        const subagent = yield* refuse(callerScope(SUBAGENT));
        assert.equal(subagent.code, "capability_denied");
        assert.include(subagent.message, "subagent cannot start a workflow");

        const badArgs = yield* refuse(callerScope(PARENT), "{not json");
        assert.equal(badArgs.code, "invalid_request");
        assert.include(badArgs.message, "args must be JSON text");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("allows one running workflow per thread until it finishes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const first = yield* runner.start(
          callerScope(PARENT),
          startInput(`return await agent("slow");`, { waitMs: 0 }),
        );
        assert.equal(first.status, "running");

        const second = yield* runner
          .start(callerScope(PARENT), startInput(`return 2;`))
          .pipe(Effect.flip);
        assert.equal(second.code, "invalid_request");
        assert.include(second.message, `Call workflow_wait with runId ${first.runId}`);

        const elsewhere = yield* runner.start(callerScope(OTHER), startInput(`return 3;`));
        assert.equal(elsewhere.status, "completed");

        const child = yield* Queue.take(harness.started);
        yield* Deferred.succeed(child.outcome, completed("done"));
        yield* runner.wait(callerScope(PARENT), {
          runId: first.runId,
          waitMs: undefined,
          resultOffset: undefined,
        });
        const after = yield* runner.start(callerScope(PARENT), startInput(`return 4;`));
        assert.equal(after.result, "4");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("interrupts the run when the turn ended, cancelling children still in flight", () =>
    Effect.gen(function* () {
      const slowDelegated = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        refuse: (input) =>
          input.task === "refused"
            ? Deferred.await(slowDelegated).pipe(
                Effect.as(
                  new OrchestratorMcpFailure({
                    code: "parent_not_active",
                    message: "The calling thread has no active run.",
                  }),
                ),
              )
            : Effect.undefined,
      });
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const running = yield* runner
          .start(
            callerScope(PARENT),
            startInput(`return await parallel([() => agent("slow"), () => agent("refused")]);`),
          )
          .pipe(Effect.forkChild);
        const slow = yield* Queue.take(harness.started);
        yield* Deferred.succeed(slowDelegated, undefined);
        const result = yield* Fiber.join(running);

        assert.equal(result.status, "interrupted");
        assert.equal(result.error, "The turn that started this workflow ended before it finished");
        assert.equal(result.result, null);
        assert.deepEqual(harness.cancelled, [slow.taskId]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("interrupts the run as soon as its turn ends, with no further agent() call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const running = yield* runner
          .start(callerScope(PARENT), startInput(`return await agent("last");`))
          .pipe(Effect.forkChild);
        const watcher = yield* Queue.take(harness.watchers);
        const child = yield* Queue.take(harness.started);
        harness.state.runs = [turn(TURN, "completed")];
        yield* Queue.offer(watcher, runUpdated(TURN, "completed"));
        const result = yield* Fiber.join(running);

        assert.equal(result.status, "interrupted");
        assert.equal(result.error, TURN_ENDED);
        assert.deepEqual(harness.cancelled, [child.taskId]);
        // The agent cut off in flight counts as failed, not as still running.
        assert.deepEqual(result.progress.agents, {
          started: 1,
          running: 0,
          completed: 0,
          failed: 1,
        });

        const idle = yield* runner
          .start(callerScope(PARENT), startInput(`return 1;`))
          .pipe(Effect.flip);
        assert.equal(idle.code, "parent_not_active");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("ends the run once its turn waits on its checkpoint, and starts none in it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const running = yield* runner
          .start(callerScope(PARENT), startInput(`return await agent("last");`))
          .pipe(Effect.forkChild);
        const watcher = yield* Queue.take(harness.watchers);
        const child = yield* Queue.take(harness.started);
        // A completed turn stays "waiting" until its checkpoint is captured.
        harness.state.runs = [turn(TURN, "waiting")];
        yield* Queue.offer(watcher, runUpdated(TURN, "waiting"));
        const result = yield* Fiber.join(running);

        assert.equal(result.status, "interrupted");
        assert.equal(result.error, TURN_ENDED);
        assert.deepEqual(harness.cancelled, [child.taskId]);

        const draining = yield* runner
          .start(callerScope(PARENT), startInput(`return 1;`))
          .pipe(Effect.flip);
        assert.equal(draining.code, "parent_not_active");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("ends the run when its turn ends between the cursor and the runs read", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.state.sequence = 7;
      harness.state.endTurnOnRead = true;
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        // The read still sees the turn running; only the replay from the cursor shows it ended.
        const result = yield* runner.start(
          callerScope(PARENT),
          startInput(`return await agent("last");`),
        );

        assert.equal(result.status, "interrupted");
        assert.equal(result.error, TURN_ENDED);
        assert.deepEqual(harness.state.cursors, [7]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("never gives a child to the turn that follows the one that started the run", () =>
    Effect.gen(function* () {
      let activeRun = TURN;
      const harness = yield* makeHarness({
        // The service's rule: a child pinned to a run joins it only while it is the active run.
        refuse: (input) =>
          Effect.sync(() =>
            (input.parentRunId ?? activeRun) === activeRun
              ? undefined
              : new OrchestratorMcpFailure({
                  code: "parent_not_active",
                  message: "The workflow's turn has ended.",
                }),
          ),
        respond: (input) => (input.task === "second" ? completed("two") : undefined),
      });
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const running = yield* runner
          .start(
            callerScope(PARENT),
            startInput(`await agent("first"); return await agent("second");`),
          )
          .pipe(Effect.forkChild);
        const first = yield* Queue.take(harness.started);
        // The user's follow-up turn started before the watcher saw this one end.
        activeRun = NEXT_TURN;
        yield* Deferred.succeed(first.outcome, completed("one"));
        const result = yield* Fiber.join(running);

        assert.equal(result.status, "interrupted");
        assert.equal(result.error, TURN_ENDED);
        assert.deepEqual(
          harness.children.map(({ input }) => [input.task, input.parentRunId]),
          [["first", TURN]],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("stops watching the turn once the run finishes, ignoring other run updates", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ respond: () => completed("done") });
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const running = yield* runner
          .start(callerScope(PARENT), startInput(`return await agent("work");`))
          .pipe(Effect.forkChild);
        const watcher = yield* Queue.take(harness.watchers);
        yield* Queue.offer(watcher, runUpdated(TURN, "running"));
        yield* Queue.offer(watcher, runUpdated(NEXT_TURN, "completed"));
        const result = yield* Fiber.join(running);

        assert.equal(result.status, "completed");
        assert.equal(harness.state.watching, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("cancels in-flight children when the layer shuts down", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const layerScope = yield* Scope.make();
      const runner = Context.get(
        yield* Layer.buildWithScope(harness.layer, layerScope),
        WorkflowRunner.WorkflowRunner,
      );
      const started = yield* runner.start(
        callerScope(PARENT),
        startInput(`return await agent("forever");`, { waitMs: 0 }),
      );
      const child = yield* Queue.take(harness.started);
      assert.deepEqual(harness.cancelled, []);

      yield* Scope.close(layerScope, Exit.void);

      assert.deepEqual(harness.cancelled, [child.taskId]);
      const stopped = yield* runner.wait(callerScope(PARENT), {
        runId: started.runId,
        waitMs: 0,
        resultOffset: undefined,
      });
      assert.equal(stopped.status, "interrupted");
    }),
  );

  it.effect("fails an unknown runId and another thread's runId the same way", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const run = yield* runner.start(callerScope(PARENT), startInput(`return 1;`));
        const missing = (scope: McpInvocationScope, runId: string) =>
          runner.wait(scope, { runId, waitMs: 0, resultOffset: undefined }).pipe(
            Effect.flip,
            Effect.map((failure) => failure.code),
          );

        assert.deepEqual(
          [
            yield* missing(callerScope(PARENT), "workflow-unknown"),
            yield* missing(callerScope(OTHER), run.runId),
          ],
          ["run_not_found", "run_not_found"],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "logs a refused child and cancels a timed-out one, and both agent() calls yield null",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          refuse: (input) =>
            Effect.succeed(
              input.task === "refused"
                ? new OrchestratorMcpFailure({
                    code: "model_unavailable",
                    message: "Model nope is not available.",
                  })
                : undefined,
            ),
          respond: () => ({ status: "timed_out", summary: null }),
        });
        yield* Effect.gen(function* () {
          const runner = yield* WorkflowRunner.WorkflowRunner;
          const result = yield* runner.start(
            callerScope(PARENT),
            startInput(`return [await agent("refused"), await agent("stuck")];`),
          );

          assert.equal(result.status, "completed");
          assert.equal(result.result, "[null,null]");
          assert.deepEqual(result.progress.recentLog, [
            "Agent 0 failed: Model nope is not available.",
            "Agent 1 timed out after 1 hour",
          ]);
          assert.deepEqual(result.progress.agents, {
            started: 2,
            running: 0,
            completed: 0,
            failed: 2,
          });
          assert.deepEqual(harness.cancelled, [harness.children[0]!.taskId]);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("gives each schema retry of one agent() call its own clientRequestId", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: (input) =>
          completed(input.task.includes("was rejected") ? `{"name":"Ada"}` : "not json"),
      });
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const result = yield* runner.start(
          callerScope(PARENT),
          startInput(`
            return await agent("Name a person.", {
              schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            });
          `),
        );

        assert.equal(result.result, `{"name":"Ada"}`);
        assert.deepEqual(
          harness.children.map(({ input }) => input.clientRequestId),
          [`workflow:${result.runId}:0:0`, `workflow:${result.runId}:0:1`],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps 20 finished runs per thread and drops finished runs after an hour", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const status = (threadId: ThreadId, runId: string) =>
          runner.wait(callerScope(threadId), { runId, waitMs: 0, resultOffset: undefined }).pipe(
            Effect.map((result) => result.status),
            Effect.catch((failure) => Effect.succeed(failure.code)),
          );
        const other = yield* runner.start(callerScope(OTHER), startInput(`return 0;`));
        const runIds: Array<string> = [];
        for (let index = 0; index < 22; index++) {
          runIds.push((yield* runner.start(callerScope(PARENT), startInput(`return 1;`))).runId);
        }
        // Starting the 22nd run left 21 finished runs; the oldest went.
        assert.deepEqual(
          [
            yield* status(PARENT, runIds[0]!),
            yield* status(PARENT, runIds[1]!),
            yield* status(OTHER, other.runId),
          ],
          ["run_not_found", "completed", "completed"],
        );

        const blocked = yield* runner.start(
          callerScope(OTHER),
          startInput(`return await agent("slow");`, { waitMs: 0 }),
        );
        yield* TestClock.adjust("61 minutes");
        yield* runner.start(callerScope(PARENT), startInput(`return 2;`));
        assert.deepEqual(
          [
            yield* status(PARENT, runIds[21]!),
            yield* status(OTHER, other.runId),
            yield* status(OTHER, blocked.runId),
          ],
          ["run_not_found", "run_not_found", "running"],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
