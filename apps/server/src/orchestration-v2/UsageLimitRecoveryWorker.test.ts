import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const nowMs = Date.parse("2026-10-16T12:00:00.000Z");
const now = DateTime.makeUnsafe(nowMs);
const resetAt = "2026-10-16T14:00:00.000Z";
const claude = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-4-7",
  options: [{ id: "effort", value: "high" }],
} satisfies ModelSelection;
const target = {
  instanceId: ProviderInstanceId.make("antigravity"),
  model: "claude-opus",
} satisfies ModelSelection;

const limited: ProjectionStore.ProjectionLimitRecoveryCandidate = {
  id: ThreadId.make("thread:limited"),
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: RunId.make("run:limited"),
  usageLimitResetAt: resetAt,
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  latestRunCompletedAt: now,
  updatedAt: now,
  limitRecovery: null,
  snoozedUntil: null,
  providerInstanceId: claude.instanceId,
};

const onFallback: ProjectionStore.ProjectionLimitFallbackReturnCandidate = {
  id: ThreadId.make("thread:fallback"),
  latestRunId: RunId.make("run:fallback"),
  modelSelection: target,
  updatedAt: now,
  limitFallback: { from: claude, to: target },
};

it("continues a usage-limited thread on the fallback once per failed run", () => {
  const command = UsageLimitRecoveryWorker.limitFallbackCommand(limited, target, nowMs);
  if (command?.type !== "message.dispatch") return assert.fail("expected a message dispatch");
  assert.equal(command.commandId, "limit-fallback:thread:limited:run:limited");
  assert.equal(command.manualContinuationOfRunId, limited.latestRunId);
  assert.deepEqual(command.modelSelection, target);
  assert.isTrue(command.limitFallback);
});

it.each([
  ["snoozed", { snoozedUntil: DateTime.makeUnsafe(nowMs + 1) }],
  ["archived", { archivedAt: now }],
  ["settled", { settledOverride: "settled" }],
  ["reset", { usageLimitResetAt: "2026-10-16T12:00:00.000Z" }],
  ["not usage-limited", { lastErrorClass: "provider_error" }],
  ["running", { status: "running" }],
  [
    "waiting-on-a-request",
    {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request:limited"),
        kind: "user_input",
        createdAt: now,
      },
    },
  ],
  // Reset no later than the run ended: a stale reading, even if this clock lags behind.
  ["stale-reset", { latestRunCompletedAt: DateTime.makeUnsafe(Date.parse(resetAt) + 1000) }],
] as const)("leaves a %s thread alone", (_, overrides) => {
  assert.isNull(
    UsageLimitRecoveryWorker.limitFallbackCommand({ ...limited, ...overrides }, target, nowMs),
  );
});

it("continues a thread whose snooze has already ended", () => {
  assert.isNotNull(
    UsageLimitRecoveryWorker.limitFallbackCommand(
      { ...limited, snoozedUntil: DateTime.makeUnsafe(nowMs - 1) },
      target,
      nowMs,
    ),
  );
});

const armed = {
  ...limited,
  limitRecovery: { runId: limited.latestRunId!, resetAt, autoResume: true },
} satisfies ProjectionStore.ProjectionLimitRecoveryCandidate;
const movedAtMs = nowMs - 1000;

it("continues a scheduled thread once its login moved after the run stopped", () => {
  const command = UsageLimitRecoveryWorker.limitLoginMovedCommand(
    { ...armed, latestRunCompletedAt: DateTime.makeUnsafe(movedAtMs - 1) },
    movedAtMs,
    nowMs,
  );
  if (command?.type !== "message.dispatch") return assert.fail("expected a message dispatch");
  assert.equal(command.commandId, "limit-login-moved:thread:limited:run:limited");
  assert.equal(command.manualContinuationOfRunId, limited.latestRunId);
  assert.isUndefined(command.modelSelection);
  assert.isUndefined(command.limitFallback);
});

it.each([
  ["unscheduled", { limitRecovery: null }],
  ["cancelled", { limitRecovery: { ...armed.limitRecovery, autoResume: false } }],
  [
    "armed for an earlier run",
    { limitRecovery: { ...armed.limitRecovery, runId: RunId.make("run:old") } },
  ],
  // It stopped on the account the login moved to.
  ["stopped after the move", { latestRunCompletedAt: DateTime.makeUnsafe(movedAtMs) }],
  ["snoozed", { snoozedUntil: DateTime.makeUnsafe(nowMs + 1) }],
  ["reset", { usageLimitResetAt: "2026-10-16T12:00:00.000Z" }],
] as const)("leaves a %s thread to its reset", (_, overrides) => {
  assert.isNull(
    UsageLimitRecoveryWorker.limitLoginMovedCommand(
      { ...armed, latestRunCompletedAt: DateTime.makeUnsafe(movedAtMs - 1), ...overrides },
      movedAtMs,
      nowMs,
    ),
  );
});

it("returns to the exact Claude selection, and never once the user picked another", () => {
  assert.deepEqual(UsageLimitRecoveryWorker.limitFallbackReturnCommand(onFallback), {
    type: "thread.model-selection.set",
    commandId: CommandId.make(`limit-fallback-return:thread:fallback:run:fallback:${nowMs}`),
    threadId: onFallback.id,
    modelSelection: claude,
    limitFallbackReturn: true,
  });
  assert.isNull(
    UsageLimitRecoveryWorker.limitFallbackReturnCommand({
      ...onFallback,
      modelSelection: { ...target, model: "gemini-3" },
    }),
  );
});

/** Runs one sweep against fakes and returns what it dispatched. */
const sweepOnce = (input: {
  readonly fallbackEnabled: boolean;
  readonly target?: ModelSelection | null;
  readonly hasRoom?: boolean;
  readonly candidates?: ReadonlyArray<ProjectionStore.ProjectionLimitRecoveryCandidate>;
  /** Turns claude-swap on; the login's move time for the default Claude instance. */
  readonly loginMovedAtMs?: number | null;
}) =>
  Effect.gen(function* () {
    // Command ids, whether dispatched or armed straight on the orchestrator.
    const dispatched: Array<string> = [];
    const queries: Array<{ readonly beforeReset?: boolean }> = [];
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Scheduler.Scheduler)({
            // Runs the one sweep right away instead of on a timer.
            register: (_name, work) => Effect.orDie(work),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: (options) =>
              Effect.sync(() => {
                queries.push(options);
                return input.candidates ?? [limited];
              }),
            getLimitFallbackReturnCandidates: () => Effect.succeed([onFallback]),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            autoArmLimitRecovery: (command) =>
              Effect.sync(() => {
                dispatched.push(command.commandId);
              }),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command.commandId ?? "");
                return { sequence: dispatched.length, storedEvents: [] };
              }),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              autoResumeLimitedThreads: true,
              claudeSwapUsageEnabled: input.loginMovedAtMs !== undefined,
              claudeSwapAntigravityFallbackEnabled: input.fallbackEnabled,
            }),
          }),
          Layer.mock(UsageLimitSources.UsageLimitSources)({
            antigravityFallbackFor: (instanceId) =>
              input.fallbackEnabled
                ? Effect.succeed(instanceId === claude.instanceId ? (input.target ?? null) : null)
                : Effect.die("the fallback is looked up only while it is on"),
            claudeSwapHasRoom: Effect.succeed(input.hasRoom ?? false),
            claudeLoginMovedAt: (instanceId) =>
              input.loginMovedAtMs === undefined
                ? Effect.die("the login is looked up only while claude-swap is on")
                : Effect.succeed(instanceId === claude.instanceId ? input.loginMovedAtMs : null),
          }),
        ),
      ),
    );
    yield* Layer.build(layer);
    return { dispatched, queries };
  }).pipe(Effect.scoped);

it.effect("leaves today's recovery untouched while the fallback is off", () =>
  Effect.gen(function* () {
    const { dispatched, queries } = yield* sweepOnce({ fallbackEnabled: false });
    // claude-swap has no room here, so only the arm is dispatched.
    assert.deepEqual(
      queries.map((query) => query.beforeReset),
      [false],
    );
    assert.lengthOf(dispatched, 1);
    assert.match(dispatched[0]!, /^limit-arm:/);
  }),
);

it.effect("falls back ahead of arming the reset, and arms when there is no target", () =>
  Effect.gen(function* () {
    const fallback = yield* sweepOnce({ fallbackEnabled: true, target });
    assert.deepEqual(
      fallback.queries.map((query) => query.beforeReset),
      [true],
    );
    assert.deepEqual(fallback.dispatched, ["limit-fallback:thread:limited:run:limited"]);
    const none = yield* sweepOnce({ fallbackEnabled: true, target: null });
    assert.lengthOf(none.dispatched, 1);
    assert.match(none.dispatched[0]!, /^limit-arm:/);
  }),
);

it.effect("looks up the fallback by each thread's own Claude instance", () =>
  Effect.gen(function* () {
    const isolated = {
      ...limited,
      id: ThreadId.make("thread:isolated"),
      providerInstanceId: ProviderInstanceId.make("claude-work"),
    };
    const { dispatched } = yield* sweepOnce({
      fallbackEnabled: true,
      target,
      candidates: [isolated],
    });
    assert.lengthOf(dispatched, 1);
    assert.match(dispatched[0]!, /^limit-arm:thread:isolated:/);
  }),
);

it.effect("returns fallback threads only once a claude-swap account has room", () =>
  Effect.gen(function* () {
    const full = yield* sweepOnce({ fallbackEnabled: true, target: null, hasRoom: false });
    assert.notInclude(
      full.dispatched,
      `limit-fallback-return:thread:fallback:run:fallback:${nowMs}`,
    );
    const room = yield* sweepOnce({ fallbackEnabled: true, target: null, hasRoom: true });
    assert.include(room.dispatched, `limit-fallback-return:thread:fallback:run:fallback:${nowMs}`);
    // Turning the fallback off still brings back the threads it already moved.
    const off = yield* sweepOnce({ fallbackEnabled: false, hasRoom: true });
    assert.include(off.dispatched, `limit-fallback-return:thread:fallback:run:fallback:${nowMs}`);
  }),
);

it.effect("continues a scheduled thread early only after its login moved", () =>
  Effect.gen(function* () {
    const stopped = { ...armed, latestRunCompletedAt: DateTime.makeUnsafe(movedAtMs - 1) };
    const moved = yield* sweepOnce({
      fallbackEnabled: false,
      candidates: [stopped],
      loginMovedAtMs: movedAtMs,
    });
    assert.deepEqual(
      moved.queries.map((query) => query.beforeReset),
      [true],
    );
    assert.deepEqual(moved.dispatched, ["limit-login-moved:thread:limited:run:limited"]);
    const unmoved = yield* sweepOnce({
      fallbackEnabled: false,
      candidates: [stopped],
      loginMovedAtMs: null,
    });
    assert.deepEqual(unmoved.dispatched, []);
  }),
);

it("retries a rejected return once the thread changes", () => {
  const first = UsageLimitRecoveryWorker.limitFallbackReturnCommand(onFallback);
  const later = UsageLimitRecoveryWorker.limitFallbackReturnCommand({
    ...onFallback,
    updatedAt: DateTime.makeUnsafe(nowMs + 1000),
  });
  assert.notEqual(first?.commandId, later?.commandId);
});
