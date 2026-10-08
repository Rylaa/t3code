import {
  isOrchestrationV2WorkActive,
  OrchestrationStopSubagentError,
  type OrchestrationV2StopSubagentInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * Controls one provider-native subagent through the live provider session that
 * runs it. Stopping is a request: the provider reports the task's end, which
 * reaches the projection like any other subagent update. A stopped session is
 * reported, never started.
 */
export class SubagentControl extends Context.Service<
  SubagentControl,
  {
    readonly stop: (
      input: OrchestrationV2StopSubagentInput,
    ) => Effect.Effect<void, OrchestrationStopSubagentError>;
  }
>()("t3/orchestration-v2/SubagentControl") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const stop = Effect.fn("SubagentControl.stop")(function* (
    input: OrchestrationV2StopSubagentInput,
  ) {
    const fail = (reason: OrchestrationStopSubagentError["reason"], cause?: unknown) =>
      new OrchestrationStopSubagentError({
        threadId: input.threadId,
        subagentId: input.subagentId,
        reason,
        ...(cause === undefined ? {} : { cause }),
      });
    const projection = yield* threadManagement
      .getThreadRecords(input.threadId, ["subagents", "providerThreads"])
      .pipe(Effect.mapError((cause) => fail("request-failed", cause)));
    const subagent = projection.subagents.find((candidate) => candidate.id === input.subagentId);
    if (subagent === undefined) return yield* fail("not-found");
    if (!isOrchestrationV2WorkActive(subagent.status)) return yield* fail("not-running");
    const nativeTaskId = subagent.nativeTaskRef?.nativeId ?? null;
    if (subagent.origin !== "provider_native" || nativeTaskId === null) {
      return yield* fail("provider-unsupported");
    }
    const providerThreadId =
      subagent.providerThreadId ?? projection.thread.activeProviderThreadId ?? null;
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === providerThreadId,
    );
    if (providerThread?.providerSessionId == null) return yield* fail("session-stopped");
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.mapError((cause) => fail("request-failed", cause))),
    );
    if (runtime === undefined) return yield* fail("session-stopped");
    if (runtime.stopSubagent === undefined) return yield* fail("provider-unsupported");
    yield* runtime
      .stopSubagent({ providerThread, nativeTaskId })
      .pipe(Effect.mapError((cause) => fail("request-failed", cause)));
  });

  return SubagentControl.of({ stop });
});

export const layer = Layer.effect(SubagentControl, make);
