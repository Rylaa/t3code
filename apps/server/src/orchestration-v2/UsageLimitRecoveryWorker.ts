import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * Continues a usage-limited thread on the claude-swap fallback's model, the
 * way the manual Continue does. Only while its limit has not reset and the
 * thread is neither snoozed, archived, settled nor waiting on a request.
 */
export function limitFallbackCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  target: ModelSelection,
  nowMs: number,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= nowMs ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `limit-fallback:${thread.id}:${thread.latestRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: thread.id,
    manualContinuationOfRunId: thread.latestRunId,
    modelSelection: target,
    limitFallback: true,
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * Switches an idle fallback thread back to the exact Claude selection it left.
 * Null once the thread is on any other model: that choice is the user's.
 */
export function limitFallbackReturnCommand(
  thread: ProjectionStore.ProjectionLimitFallbackReturnCandidate,
): OrchestrationV2Command | null {
  if (!modelSelectionsEqual(thread.limitFallback.to, thread.modelSelection)) return null;
  return {
    type: "thread.model-selection.set",
    // A return rejected because the thread turned busy retries once the thread changes again.
    commandId: CommandId.make(
      `limit-fallback-return:${thread.id}:${thread.latestRunId ?? "none"}:${DateTime.toEpochMillis(thread.updatedAt)}`,
    ),
    threadId: thread.id,
    modelSelection: thread.limitFallback.from,
    limitFallbackReturn: true,
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
  const dispatch = (thread: { readonly id: string }, command: OrchestrationV2Command) =>
    threads.dispatch(command).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
          threadId: thread.id,
          cause,
        }),
      ),
    );
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const fallbackEnabled = preferences.claudeSwapAntigravityFallbackEnabled;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      fallback: fallbackEnabled,
    });
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of candidates) {
      // The fallback is the last resort, so it wins over waiting for the reset.
      const target = fallbackEnabled
        ? yield* usageLimitSources.antigravityFallbackFor(thread.providerInstanceId)
        : null;
      const command =
        (target === null ? null : limitFallbackCommand(thread, target, nowMs)) ??
        limitRecoveryCommand(
          thread,
          preferences.autoResumeLimitedThreads,
          nowMs,
          preferences.snoozeLimitedThreads,
        );
      if (command === null) continue;
      yield* dispatch(thread, command);
    }
    // Runs even with the fallback turned off, so threads it already moved still come back.
    const returns = yield* projections.getLimitFallbackReturnCandidates();
    if (returns.length === 0 || !(yield* usageLimitSources.claudeSwapHasRoom)) return;
    for (const thread of returns) {
      const command = limitFallbackReturnCommand(thread);
      if (command !== null) yield* dispatch(thread, command);
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
