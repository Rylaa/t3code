import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as AutomaticContextPolicy from "./AutomaticContextPolicy.ts";
import * as Orchestrator from "./Orchestrator.ts";

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
 * Runs the automatic context policy when a root run completes and again when
 * the work it waited on settles. The orchestrator asks the same policy itself
 * before queued messages start.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const policy = yield* AutomaticContextPolicy.AutomaticContextPolicy;

  // Threads whose completed turn is held by background work, a goal or a request.
  const waiting = new Set<ThreadId>();

  /** Returns whether the thread waits, so later background events re-check it. */
  const evaluate = Effect.fn("AgentHandoffReactor.evaluate")(function* (threadId: ThreadId) {
    const action = yield* policy.decide(threadId);
    if (action === null || action === "wait") return action === "wait";
    yield* orchestrator.dispatch(action);
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
