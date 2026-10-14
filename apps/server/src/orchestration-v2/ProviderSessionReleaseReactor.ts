import { CommandId, type ProviderSessionId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export const SESSION_RELEASED_REASON = "The provider session ended before the run finished.";

/**
 * Interrupts a run that still shows running after its provider session was
 * released. Only the run's ingest fiber writes its terminal, so a fiber that
 * stalled or ended early leaves the run running forever. The interrupt takes
 * Stop's dead-session path and shows the reason in the thread.
 *
 * Server shutdown releases are not published, so restart recovery still owns
 * those runs.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const settle = Effect.fn("ProviderSessionReleaseReactor.settle")(function* (
    threadId: ThreadId,
    providerSessionId: ProviderSessionId,
  ) {
    const records = yield* orchestrator.getThreadRecords(threadId, ["runs", "providerThreads"]);
    // Checked after the read: a run that started on a replacement session with
    // the same id opened that session first, so it is never mistaken for stale.
    if (Option.isSome(yield* providerSessions.get(providerSessionId))) return;
    for (const run of records.runs) {
      if (run.status !== "running") continue;
      const providerThread = records.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      if (providerThread?.providerSessionId !== providerSessionId) continue;
      yield* Effect.logWarning("orchestration-v2.provider-session-released-under-running-run", {
        threadId,
        runId: run.id,
        providerSessionId,
      });
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`session-released:${providerSessionId}:${run.id}`),
        threadId,
        runId: run.id,
        reason: SESSION_RELEASED_REASON,
      });
    }
  });

  const start = Effect.fn("ProviderSessionReleaseReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(providerSessions.releases, (release) =>
        Effect.forEach(
          release.threadIds,
          (threadId) =>
            settle(threadId, release.providerSessionId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.provider-session-release-settle-failed", {
                  threadId,
                  providerSessionId: release.providerSessionId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        ),
      ),
    );
  });

  return { start };
});
