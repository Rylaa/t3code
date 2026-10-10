import {
  type NodeId,
  type OrchestrationV2Run,
  OrchestratorMcpFailure,
  type OrchestratorMcpWorkflowResult,
  type OrchestratorMcpWorkflowStatus,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  runWorkflowScript,
  type WorkflowAgentRequest,
  type WorkflowEngineEvent,
  type WorkflowEngineResult,
  type WorkflowSandboxCommand,
} from "./WorkflowEngine.ts";

/** Runs a calling thread's workflow scripts, one `agent()` call per delegated child task. */
export interface WorkflowRunnerShape {
  /** Starts a workflow and waits up to `waitMs` for it to finish. */
  readonly start: (
    scope: McpInvocationScope,
    input: {
      readonly script: string;
      readonly args: string | undefined;
      readonly title: string | undefined;
      readonly waitMs: number | undefined;
    },
  ) => Effect.Effect<OrchestratorMcpWorkflowResult, OrchestratorMcpFailure>;
  /** Waits up to `waitMs` more for a started workflow, and pages its result from `resultOffset`. */
  readonly wait: (
    scope: McpInvocationScope,
    input: {
      readonly runId: string;
      readonly waitMs: number | undefined;
      readonly resultOffset: number | undefined;
    },
  ) => Effect.Effect<OrchestratorMcpWorkflowResult, OrchestratorMcpFailure>;
}

export class WorkflowRunner extends Context.Service<WorkflowRunner, WorkflowRunnerShape>()(
  "t3/workflow/WorkflowRunner",
) {}

const DEFAULT_WAIT_MS = 45_000;
const MAX_WAIT_MS = 3_300_000;
const AGENT_TIMEOUT_MS = 60 * 60 * 1000;
const RESULT_SLICE_CHARS = 30_000;
const RECENT_LOG_LINES = 10;
const MAX_FINISHED_RUNS_PER_THREAD = 20;
const FINISHED_RUN_TTL_MS = 60 * 60 * 1000;
const TURN_ENDED = "The turn that started this workflow ended before it finished";
const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJsonText = Schema.encodeSync(JsonText);
const decodeJsonText = Schema.decodeEffect(JsonText);

/** One workflow in the in-memory registry; it does not survive a server restart. */
interface WorkflowRun {
  readonly runId: string;
  readonly threadId: ThreadId;
  /** The run of the turn that started the workflow; its children belong to it alone. */
  readonly parentRunId: RunId;
  readonly title: string | null;
  readonly startedAt: number;
  readonly done: Deferred.Deferred<void>;
  /** Aborted once the launching turn's run is no longer live; it stops the script. */
  readonly turnEnded: AbortController;
  /** Calls per agent index: a schema retry calls runAgent again with the same index. */
  readonly attempts: Map<number, number>;
  status: OrchestratorMcpWorkflowStatus;
  result: string | null;
  error: string | null;
  finishedAt: number | null;
  phase: string | null;
  readonly recentLog: Array<string>;
  readonly agents: { started: number; running: number; completed: number; failed: number };
}

/** A turn still at work; a completed turn stays "waiting" until its checkpoint is captured. */
const isLiveTurn = (run: OrchestrationV2Run) =>
  run.status === "preparing" || run.status === "starting" || run.status === "running";

const pushLog = (run: WorkflowRun, line: string) => {
  run.recentLog.push(line);
  if (run.recentLog.length > RECENT_LOG_LINES) run.recentLog.shift();
};

const recordEvent = (run: WorkflowRun, event: WorkflowEngineEvent) => {
  switch (event.type) {
    case "phase":
      run.phase = event.title;
      return;
    case "log":
      return pushLog(run, event.message);
    case "agent":
      if (event.status === "running") {
        run.agents.started++;
        run.agents.running++;
        return;
      }
      run.agents.running--;
      run.agents[event.status]++;
  }
};

const snapshot = (
  run: WorkflowRun,
  resultOffset: number,
  now: number,
): OrchestratorMcpWorkflowResult => {
  const resultChars = run.result?.length ?? 0;
  const offset = Math.min(resultOffset, resultChars);
  return {
    runId: run.runId,
    status: run.status,
    title: run.title,
    result: run.result?.slice(offset, offset + RESULT_SLICE_CHARS) ?? null,
    resultChars,
    resultOffset: offset,
    resultTruncated: offset + RESULT_SLICE_CHARS < resultChars,
    error: run.error,
    progress: { phase: run.phase, recentLog: [...run.recentLog], agents: { ...run.agents } },
    elapsedMs: (run.finishedAt ?? now) - run.startedAt,
  };
};

const make = Effect.fn("WorkflowRunner.make")(function* (sandbox: WorkflowSandboxCommand) {
  const crypto = yield* Crypto.Crypto;
  const orchestration = yield* OrchestratorMcpService.OrchestratorMcpService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // Runs outlive the tool call that starts them; closing the layer stops them.
  const layerScope = yield* Effect.scope;
  const runs = new Map<string, WorkflowRun>();

  const cancelChild = (scope: McpThreadInvocationScope, taskId: NodeId) =>
    orchestration.cancelTask(scope, { taskId }).pipe(Effect.ignore({ log: true }));

  /** One agent() call: a delegated child of the caller's run, cancelled if the call stops waiting for it. */
  const runAgent = (
    scope: McpThreadInvocationScope,
    run: WorkflowRun,
    request: WorkflowAgentRequest,
  ) =>
    Effect.suspend(() => {
      const attempt = run.attempts.get(request.index) ?? 0;
      run.attempts.set(request.index, attempt + 1);
      // Uninterruptible until the child's id is known, so an interrupted call still cancels it.
      return Effect.uninterruptibleMask((restore) =>
        orchestration
          .delegateChild(scope, {
            task: request.prompt,
            title: request.label ?? `Workflow agent ${request.index}`,
            model: request.model,
            clientRequestId: `workflow:${run.runId}:${request.index}:${attempt}`,
            parentRunId: run.parentRunId,
          })
          .pipe(
            Effect.flatMap(({ taskId }) =>
              restore(orchestration.awaitTask(scope, taskId, AGENT_TIMEOUT_MS)).pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit) && exit.value.status !== "timed_out"
                    ? Effect.void
                    : cancelChild(scope, taskId),
                ),
              ),
            ),
            Effect.map((outcome) => {
              if (outcome.status === "timed_out") {
                pushLog(run, `Agent ${request.index} timed out after 1 hour`);
              }
              return outcome.status === "completed" ? outcome.summary : null;
            }),
            Effect.catch((error) =>
              Effect.sync(() => {
                if (error.code === "parent_not_active") run.turnEnded.abort();
                else pushLog(run, `Agent ${request.index} failed: ${error.message}`);
                return null;
              }),
            ),
          ),
      );
    });

  const settle = (run: WorkflowRun, exit: Exit.Exit<WorkflowEngineResult>) =>
    Effect.gen(function* () {
      const outcome = Exit.isSuccess(exit) ? exit.value : undefined;
      if (outcome?.ok) {
        run.status = "completed";
        run.result = encodeJsonText(outcome.value);
      } else if (outcome !== undefined && !outcome.aborted) {
        run.status = "failed";
        run.error = outcome.error;
      } else {
        run.status = "interrupted";
        run.error = run.turnEnded.signal.aborted
          ? TURN_ENDED
          : "The workflow stopped before it finished.";
      }
      // The engine drops events once it settles, so agents still in flight never report back.
      run.agents.failed += run.agents.running;
      run.agents.running = 0;
      run.finishedAt = yield* Clock.currentTimeMillis;
      yield* Deferred.succeed(run.done, undefined);
    });

  /** Ends the run as interrupted once its launching turn's run stops, replaying from `afterSequence`. */
  const watchTurn = (run: WorkflowRun, afterSequence: number) =>
    threads
      .streamStoredEventsFrom({ threadId: run.threadId, afterSequence, eventType: "run.updated" })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" &&
            event.payload.id === run.parentRunId &&
            !isLiveTurn(event.payload),
        ),
        Stream.take(1),
        Stream.runForEach(() => Effect.sync(() => run.turnEnded.abort())),
        // Without the watcher, the next agent() call still finds the turn over.
        Effect.ignore({ log: true }),
      );

  const execute = (
    scope: McpThreadInvocationScope,
    run: WorkflowRun,
    script: string,
    args: unknown,
    afterSequence: number,
  ) =>
    FiberSet.makeRuntimePromise().pipe(
      Effect.tap(() => Effect.forkScoped(watchTurn(run, afterSequence))),
      Effect.flatMap((runPromise) =>
        Effect.promise((signal) =>
          runWorkflowScript(
            {
              script,
              args,
              sandbox,
              runAgent: (request) => runPromise(runAgent(scope, run, request)),
              onEvent: (event) => recordEvent(run, event),
            },
            AbortSignal.any([signal, run.turnEnded.signal]),
          ),
        ),
      ),
      // Closing the scope stops the watcher and interrupts agent() calls still waiting, and
      // each cancels its child.
      Effect.scoped,
      Effect.onExit((exit) => settle(run, exit)),
    );

  const awaitResult = (
    run: WorkflowRun,
    waitMs: number | undefined,
    resultOffset: number | undefined,
  ) =>
    Deferred.await(run.done).pipe(
      Effect.timeoutOption(Math.min(MAX_WAIT_MS, Math.max(0, waitMs ?? DEFAULT_WAIT_MS))),
      Effect.andThen(Clock.currentTimeMillis),
      Effect.map((now) => snapshot(run, resultOffset ?? 0, now)),
    );

  /** Drops finished runs over an hour old, and all but the newest finished runs of `threadId`. */
  const prune = (threadId: ThreadId, now: number) => {
    for (const run of runs.values()) {
      if (run.finishedAt !== null && now - run.finishedAt > FINISHED_RUN_TTL_MS) {
        runs.delete(run.runId);
      }
    }
    const finished = [...runs.values()].filter(
      (run) => run.threadId === threadId && run.finishedAt !== null,
    );
    for (const run of finished.slice(0, -MAX_FINISHED_RUNS_PER_THREAD)) runs.delete(run.runId);
  };

  const unreadable = () =>
    new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "Unable to read the calling thread.",
    });

  const parseArgs = (args: string | undefined) =>
    args === undefined
      ? Effect.succeed(null)
      : decodeJsonText(args).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `args must be JSON text: ${error.message}`,
              }),
          ),
        );

  return WorkflowRunner.of({
    start: (callerScope, input) =>
      Effect.gen(function* () {
        const scope = yield* requireThreadScope(callerScope, "workflow_run");
        const threadId = scope.thread.threadId;
        const thread = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unreadable));
        if (thread === null || thread.deletedAt !== null) {
          return yield* new OrchestratorMcpFailure({
            code: "thread_not_found",
            message: "The calling thread was not found.",
          });
        }
        // node:vm is not a security boundary, so the script runs with this machine's access.
        if (thread.runtimeMode !== "full-access") {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "Workflows run model-written scripts on this machine, so the thread needs Full access. Ask the user to switch this thread to Full access, or delegate the work with delegate_task instead.",
          });
        }
        if (thread.lineage.relationshipToParent === "subagent") {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "A subagent cannot start a workflow. Do this part of the work directly; the thread that delegated it can run workflows.",
          });
        }
        const args = yield* parseArgs(input.args);
        // The cursor comes before the read, so the watcher replays a turn that ends in between.
        const afterSequence = yield* threads
          .getThreadEventSequence(threadId)
          .pipe(Effect.mapError(unreadable));
        const parentRun = ThreadManagementService.latestActiveRun(
          yield* threads.getThreadRecords(threadId, ["runs"]).pipe(Effect.mapError(unreadable)),
        );
        if (parentRun === undefined || !isLiveTurn(parentRun)) {
          return yield* new OrchestratorMcpFailure({
            code: "parent_not_active",
            message: "A workflow runs within the turn that starts it, and this thread has none.",
          });
        }
        const runId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const now = yield* Clock.currentTimeMillis;
        const done = yield* Deferred.make<void>();
        // One uninterrupted step checks, registers and forks the run, so two starts cannot both
        // pass the check and an interrupted call cannot leave a registered run that never runs.
        const run = yield* Effect.uninterruptible(
          Effect.suspend(() => {
            const running = [...runs.values()].find(
              (run) => run.threadId === threadId && run.status === "running",
            );
            if (running !== undefined) {
              return Effect.fail(
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `Workflow ${running.runId} is still running in this thread. Call workflow_wait with runId ${running.runId} until it finishes before starting another.`,
                }),
              );
            }
            prune(threadId, now);
            const run: WorkflowRun = {
              runId,
              threadId,
              parentRunId: parentRun.id,
              title: input.title ?? null,
              startedAt: now,
              done,
              turnEnded: new AbortController(),
              attempts: new Map(),
              status: "running",
              result: null,
              error: null,
              finishedAt: null,
              phase: null,
              recentLog: [],
              agents: { started: 0, running: 0, completed: 0, failed: 0 },
            };
            runs.set(runId, run);
            return Effect.as(
              Effect.forkIn(execute(scope, run, input.script, args, afterSequence), layerScope),
              run,
            );
          }),
        );
        return yield* awaitResult(run, input.waitMs, undefined);
      }),
    wait: (callerScope, input) =>
      Effect.gen(function* () {
        const scope = yield* requireThreadScope(callerScope, "workflow_wait");
        const run = runs.get(input.runId);
        if (run === undefined || run.threadId !== scope.thread.threadId) {
          return yield* new OrchestratorMcpFailure({
            code: "run_not_found",
            message: `Workflow ${input.runId} was not found in this thread. Finished workflows are kept for an hour, and none survive a server restart.`,
          });
        }
        return yield* awaitResult(run, input.waitMs, input.resultOffset);
      }),
  });
});

/** Runs scripts through `sandbox`; tests point it at the source entrypoint. */
export const layerWithSandbox = (sandbox: WorkflowSandboxCommand) =>
  Layer.effect(WorkflowRunner, make(sandbox));

export const layer = Layer.effect(
  WorkflowRunner,
  Effect.gen(function* () {
    const self = yield* resolveSelfInvocation();
    return yield* make({
      command: self.command,
      args: selfInvocationArgs(self, ["workflow-sandbox"]),
    });
  }),
);
