import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ModelSelection,
  type ProviderInstanceId,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ServerProvider,
  type ServerSettings,
  type UsageLimitSourceAutoSwitch,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSwitchAccountInput,
  type UsageLimitSourceSwitchAccountResult,
  UsageLimitSourceId as UsageLimitSourceIdSchema,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { CLAUDE_SWAP_DEAD_STATUSES } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { makeClaudeContinuationGroupKey } from "../provider/Drivers/ClaudeHome.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import {
  antigravityFallbackTarget,
  CLAUDE_SWAP_AUTO_BACKOFF_MS,
  CLAUDE_SWAP_BACKGROUND_READ_MIN_MS,
  claudeSwapAllFull,
  type ClaudeSwapAutoSwitchDecision,
  claudeSwapLoginMovedAt,
  decideClaudeSwapAutoSwitch,
} from "./claudeSwapAutoSwitch.ts";
import { claudeSwapStatusMessage, makeClaudeSwapCli } from "./claudeSwapCli.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";

/** The one snapshot claude-swap publishes; it is a setting, not a configured entry. */
export const CLAUDE_SWAP_SOURCE_ID = UsageLimitSourceIdSchema.make("claude-swap");

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
    /**
     * Make a claude-swap account the machine's Claude login, or let claude-swap
     * pick the one with the most headroom. Running Claude sessions on default
     * instances move to the new account on their next request, or within
     * about 30 seconds on macOS. `beforeSwitch`
     * runs under the claude-swap lock right before the switch, so a caller
     * whose access changed while it waited can still stop it.
     */
    readonly switchAccount: <E = never, R = never>(
      input: UsageLimitSourceSwitchAccountInput,
      options?: { readonly beforeSwitch?: Effect.Effect<void, E, R> },
    ) => Effect.Effect<UsageLimitSourceSwitchAccountResult, UsageLimitSourceError | E, R>;
    /** Resolves once every queued automatic-switch check, and any tick it ran, has finished. */
    readonly drainAutoSwitch: Effect.Effect<void>;
    /**
     * The Antigravity Claude selection a thread on `instanceId` should continue
     * on after a usage limit, or null. Only default Claude instances qualify:
     * their login is the one claude-swap could not move.
     */
    readonly antigravityFallbackFor: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ModelSelection | null>;
    /** True only when a readable claude-swap account is below the switch threshold. */
    readonly claudeSwapHasRoom: Effect.Effect<boolean>;
    /**
     * When the login a thread on `instanceId` runs on moved to a claude-swap
     * account with room, or null. Only default Claude instances follow that
     * login; the switch time is kept in memory, so a restart forgets it.
     */
    readonly claudeLoginMovedAt: (instanceId: ProviderInstanceId) => Effect.Effect<number | null>;
  }
>()("t3/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const claudeSwap = yield* makeClaudeSwapCli;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serviceScope = yield* Effect.scope;
  // Default Claude instances share the login cswap acts on (it runs without CLAUDE_CONFIG_DIR).
  const defaultClaudeKey = yield* makeClaudeContinuationGroupKey({ homePath: "" });
  const settingsService = yield* Settings.ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    if (config.managementKey.length === 0) {
      return { ...base, accounts: [], error: "No management key configured." };
    }
    const accounts = yield* api.readAccounts(config).pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
  });

  const readClaudeSwap = Effect.fn("UsageLimitSources.readClaudeSwap")(function* (
    binaryPath: string,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      id: CLAUDE_SWAP_SOURCE_ID,
      kind: "claudeSwap",
      label: "claude-swap",
      checkedAt,
    } as const;
    const accounts = yield* claudeSwap.readAccounts(binaryPath).pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("claude-swap read failed", { detail: accounts.failure.detail });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
  });

  // Hubs and claude-swap update their own part of the set; the lock keeps
  // each update and its publish together so subscribers end on the latest set.
  const publishLock = yield* Semaphore.make(1);
  const update = Effect.fn("UsageLimitSources.update")(
    function* (
      next: (
        previous: ReadonlyArray<UsageLimitSourceSnapshot>,
      ) => ReadonlyArray<UsageLimitSourceSnapshot>,
    ) {
      const previous = yield* Ref.get(stateRef);
      const value = next(previous);
      if (Equal.equals(previous, value)) return;
      yield* Ref.set(stateRef, value);
      yield* PubSub.publish(changes, value);
    },
    (effect) => effect.pipe(publishLock.withPermits(1)),
  );
  const isClaudeSwap = (source: UsageLimitSourceSnapshot) => source.kind === "claudeSwap";
  const publishHubs = (hubs: ReadonlyArray<UsageLimitSourceSnapshot>) =>
    update((previous) => [...hubs, ...previous.filter(isClaudeSwap)]);
  // The last automatic switch carries over to each fresh read until the next
  // one replaces it. Every publish queues an automatic-switch check.
  const publishClaudeSwap = (
    snapshot: UsageLimitSourceSnapshot | undefined,
    autoSwitch?: UsageLimitSourceAutoSwitch,
  ): Effect.Effect<void> =>
    update((previous) => {
      const status = autoSwitch ?? previous.find(isClaudeSwap)?.autoSwitch;
      return [
        ...previous.filter((source) => !isClaudeSwap(source)),
        ...(snapshot ? [status ? { ...snapshot, autoSwitch: status } : snapshot] : []),
      ];
    }).pipe(Effect.andThen(Effect.suspend(() => requestAutoSwitch)));

  // One hub refresh at a time: a slow hub read started before a settings
  // change must not publish after the change's own refresh and resurrect a
  // removed source. Callers queue behind the in-flight run and see current settings.
  const hubLock = yield* Semaphore.make(1);
  const refreshHubs = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publishHubs(snapshots);
  }).pipe(hubLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // cswap runs one command at a time, and a read never overwrites a switch's
  // post-switch list.
  const claudeSwapLock = yield* Semaphore.make(1);
  // cswap writes the Keychain and may be mid token refresh; killing it can
  // strand a half-switched login or lose a rotated token. Its work runs in the
  // service's scope, so a caller's interruption only stops the caller's wait.
  const detached = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.forkIn(serviceScope), Effect.flatMap(Fiber.join));

  const refreshClaudeSwap = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    yield* publishClaudeSwap(
      settings?.claudeSwapUsageEnabled
        ? yield* readClaudeSwap(settings.claudeSwapBinaryPath)
        : undefined,
    );
  });
  // At most one read runs and one waits: refreshes that arrive meanwhile join
  // the waiting read, which sees the settings current when it starts. Setting
  // the flag and forking are one step: an interruption between them would
  // leave the flag set with no read to clear it, and claude-swap would never
  // refresh again. The forked read itself stays interruptible.
  const claudeSwapQueued = yield* Ref.make(false);
  const startClaudeSwapRefresh = Ref.getAndSet(claudeSwapQueued, true).pipe(
    Effect.flatMap((queued) =>
      queued
        ? Effect.void
        : Ref.set(claudeSwapQueued, false).pipe(
            Effect.andThen(refreshClaudeSwap),
            claudeSwapLock.withPermits(1),
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(serviceScope),
            Effect.asVoid,
          ),
    ),
    Effect.uninterruptible,
  );

  const refresh = startClaudeSwapRefresh.pipe(Effect.andThen(refreshHubs));

  // Shares the hub lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled || !config.managementKey) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const result = yield* api.consume(config, input.accountId, input.creditId);
    const snapshot = yield* readSource(input.sourceId, config);
    yield* update((previous) =>
      previous.map((source) =>
        source.id === input.sourceId && !isClaudeSwap(source) ? snapshot : source,
      ),
    );
    return result;
  }, hubLock.withPermits(1));

  // Instances with their own CLAUDE_CONFIG_DIR keep their own login.
  const isDefaultClaudeInstance = (instance: ProviderInstance) =>
    instance.enabled &&
    instance.driverKind === "claudeAgent" &&
    instance.continuationIdentity.continuationKey === defaultClaudeKey;

  // Default Claude instances share the login cswap just changed; their probe
  // cache would show the old account for minutes.
  const refreshDefaultClaudeInstances = Effect.gen(function* () {
    const instances = yield* instanceRegistry.listInstances;
    yield* Effect.forEach(
      instances.filter(isDefaultClaudeInstance),
      (instance) =>
        (instance.invalidateCaches ?? Effect.void).pipe(
          Effect.andThen(providerRegistry.refreshInstance(instance.instanceId)),
        ),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  const autoSwitchClock = yield* Ref.make<{
    readonly lastSwitchAtMs: number | null;
    readonly backoffUntilMs: number | null;
  }>({ lastSwitchAtMs: null, backoffUntilMs: null });

  const switchClaudeSwapAccount = Effect.fn("UsageLimitSources.switchClaudeSwapAccount")(
    function* <E, R>(
      input: UsageLimitSourceSwitchAccountInput,
      beforeSwitch: Effect.Effect<void, E, R>,
    ) {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read settings." })),
      );
      if (input.sourceId !== CLAUDE_SWAP_SOURCE_ID || !settings.claudeSwapUsageEnabled) {
        return yield* new UsageLimitSourceError({
          detail: "This usage limit source cannot switch accounts.",
        });
      }
      const binaryPath = settings.claudeSwapBinaryPath;
      let target: { readonly accountId: string } | { readonly strategy: "best" };
      if ("strategy" in input) {
        target = { strategy: input.strategy };
      } else {
        // Slots can be renumbered between the client's read and this call;
        // the email pins the account the user actually picked.
        const accounts = yield* claudeSwap.readAccounts(binaryPath);
        const account = accounts.find((candidate) => candidate.id === input.accountId);
        if (account?.email?.toLowerCase() !== input.email.trim().toLowerCase()) {
          return yield* new UsageLimitSourceError({
            detail: "claude-swap's accounts changed since they were listed. Refresh and try again.",
          });
        }
        if (account.status !== undefined && CLAUDE_SWAP_DEAD_STATUSES.has(account.status)) {
          return yield* new UsageLimitSourceError({
            detail: claudeSwapStatusMessage(account.status),
          });
        }
        target = { accountId: account.id };
      }
      yield* beforeSwitch;
      const result = yield* claudeSwap.switchTo(binaryPath, target);
      if (result.switched) {
        // Manual switches too: the default instances' next readings may still be the old login's.
        const nowMs = yield* Clock.currentTimeMillis;
        yield* Ref.update(autoSwitchClock, (clock) => ({ ...clock, lastSwitchAtMs: nowMs }));
      }
      yield* publishClaudeSwap(yield* readClaudeSwap(binaryPath));
      return result;
    },

    (effect) => effect.pipe(claudeSwapLock.withPermits(1)),
  );

  const switchAccount = <E = never, R = never>(
    input: UsageLimitSourceSwitchAccountInput,
    options?: { readonly beforeSwitch?: Effect.Effect<void, E, R> },
  ) =>
    switchClaudeSwapAccount(input, options?.beforeSwitch ?? Effect.void).pipe(
      // Outside the lock: a Claude probe takes seconds, and the native row
      // updates over the provider stream.
      Effect.tap((result) =>
        result.switched
          ? refreshDefaultClaudeInstances.pipe(Effect.forkIn(serviceScope), Effect.asVoid)
          : Effect.void,
      ),
      detached,
    );

  const autoSwitchOn = (settings: ServerSettings | null): settings is ServerSettings =>
    settings?.claudeSwapUsageEnabled === true && settings.claudeSwapAutoSwitchEnabled;
  const defaultClaudeProviders = (providers: ReadonlyArray<ServerProvider>) =>
    instanceRegistry.listInstances.pipe(
      Effect.map((instances) => {
        const ids = new Set(instances.filter(isDefaultClaudeInstance).map((i) => i.instanceId));
        return providers.filter((provider) => ids.has(provider.instanceId));
      }),
    );

  // A switch waits for the claude-swap lock; switching may be turned off meanwhile.
  const autoSwitchStillOn = settingsService.getSettings.pipe(
    Effect.orElseSucceed(() => null),
    Effect.flatMap((settings) =>
      autoSwitchOn(settings) ? Effect.void : Effect.fail("turned-off" as const),
    ),
  );

  // Runs through `switchAccount`, which re-reads the slot under the claude-swap
  // lock and pins it to the email the decision saw. Null: switching was turned off.
  const attemptAutoSwitch = (
    decision: ClaudeSwapAutoSwitchDecision,
  ): Effect.Effect<Omit<UsageLimitSourceAutoSwitch, "at"> | null> => {
    if (decision.outcome === "blocked") return Effect.succeed({ outcome: "blocked" });
    const { fromAccountId, toAccountId, usedPercent, window } = decision;
    return switchAccount(
      { sourceId: CLAUDE_SWAP_SOURCE_ID, accountId: toAccountId, email: decision.email },
      { beforeSwitch: autoSwitchStillOn },
    ).pipe(
      Effect.match({
        onFailure: (error) =>
          error === "turned-off" ? null : { outcome: "failed" as const, detail: error.detail },
        onSuccess: (result) =>
          result.switched
            ? {
                outcome: "switched" as const,
                fromAccountId,
                toAccountId,
                ...(usedPercent !== undefined ? { usedPercent } : {}),
                ...(window !== undefined ? { window } : {}),
              }
            : { outcome: "failed" as const, detail: "claude-swap kept the current account." },
      }),
    );
  };

  const runAutoSwitch = (decision: ClaudeSwapAutoSwitchDecision) =>
    Effect.gen(function* () {
      const outcome = yield* attemptAutoSwitch(decision);
      if (outcome === null) return;
      const nowMs = yield* Clock.currentTimeMillis;
      if (outcome.outcome !== "switched") {
        yield* Ref.update(autoSwitchClock, (clock) => ({
          ...clock,
          backoffUntilMs: nowMs + CLAUDE_SWAP_AUTO_BACKOFF_MS,
        }));
      }
      const status = { at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)), ...outcome };
      yield* Effect.logInfo("claude-swap automatic switch", status);
      yield* update((previous) =>
        previous.map((source) =>
          isClaudeSwap(source) ? { ...source, autoSwitch: status } : source,
        ),
      );
    });

  // Checks run one at a time, so a switch is never doubled, and a burst of
  // triggers collapses into the one check still queued.
  const autoSwitchQueued = yield* Ref.make(false);
  const autoSwitchWorker = yield* makeDrainableWorker(() =>
    Effect.gen(function* () {
      yield* Ref.set(autoSwitchQueued, false);
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      const defaultProviders = yield* defaultClaudeProviders(yield* providerRegistry.getProviders);
      if (!autoSwitchOn(settings)) return;
      const decision = decideClaudeSwapAutoSwitch({
        source: (yield* Ref.get(stateRef)).find(isClaudeSwap),
        defaultProviders,
        atPercent: settings.claudeSwapAutoSwitchAtPercent,
        nowMs: yield* Clock.currentTimeMillis,
        ...(yield* Ref.get(autoSwitchClock)),
      });
      if (decision) yield* runAutoSwitch(decision);
    }),
  );
  // Uninterruptible for the reason startClaudeSwapRefresh is: a set flag with
  // nothing queued would stop every later check.
  const requestAutoSwitch = Ref.getAndSet(autoSwitchQueued, true).pipe(
    Effect.flatMap((queued) => (queued ? Effect.void : autoSwitchWorker.enqueue(undefined))),
    Effect.asVoid,
    Effect.uninterruptible,
  );

  // A turn's rate-limit update lands on the default Claude instance before
  // claude-swap's next read, so its readings trigger a check too.
  yield* providerRegistry.streamChanges.pipe(
    Stream.mapEffect(defaultClaudeProviders),
    Stream.map((providers) =>
      providers.map((provider) => [provider.auth.email, provider.usageLimits]),
    ),
    Stream.changes,
    Stream.runForEach(() => requestAutoSwitch),
    Effect.forkScoped,
  );

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => ({
      sources: settings.usageLimitSources,
      claudeSwapUsageEnabled: settings.claudeSwapUsageEnabled,
      claudeSwapBinaryPath: settings.claudeSwapBinaryPath,
      // A fresh read checks the new automatic-switch settings right away.
      claudeSwapAutoSwitchEnabled: settings.claudeSwapAutoSwitchEnabled,
      claudeSwapAutoSwitchAtPercent: settings.claudeSwapAutoSwitchAtPercent,
    })),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const timer = settingsService.getSettings.pipe(
    Effect.map((settings) => ({
      wait: resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
      autoSwitch: autoSwitchOn(settings),
    })),
    Effect.orElseSucceed(() => ({
      wait: DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
      autoSwitch: false,
    })),
  );
  // Automatic switching must also react with no client in the foreground, so
  // while it is on claude-swap is read even when the background policy says
  // no, at most every 3 minutes: cswap serves cached usage for about that long.
  // The floor limits only that read; the normal refresh keeps its interval.
  // Starts at boot: the startup refresh below counts as the first read.
  const lastBackgroundReadMs = yield* Ref.make(yield* Clock.currentTimeMillis);
  const backgroundClaudeSwapRead = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const lastMs = yield* Ref.get(lastBackgroundReadMs);
    if (nowMs - lastMs < CLAUDE_SWAP_BACKGROUND_READ_MIN_MS) return;
    yield* Ref.set(lastBackgroundReadMs, nowMs);
    yield* startClaudeSwapRefresh;
  });
  yield* Effect.forever(
    timer.pipe(
      Effect.flatMap(({ wait }) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(timer),
      // A non-positive interval turns hub polling off; automatic switching keeps its own read.
      Effect.flatMap(({ wait, autoSwitch }) =>
        (Duration.isPositive(wait)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false)
        ).pipe(
          Effect.flatMap((shouldRun) =>
            shouldRun ? refresh : autoSwitch ? backgroundClaudeSwapRead : Effect.void,
          ),
        ),
      ),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  const fallbackInputs = Effect.gen(function* () {
    const providers = yield* providerRegistry.getProviders;
    return {
      source: (yield* Ref.get(stateRef)).find(isClaudeSwap),
      providers,
      defaultProviders: yield* defaultClaudeProviders(providers),
      nowMs: yield* Clock.currentTimeMillis,
    };
  });

  const isDefaultClaudeInstanceId = (instanceId: ProviderInstanceId) =>
    instanceRegistry.listInstances.pipe(
      Effect.map((instances) =>
        instances.some(
          (instance) => instance.instanceId === instanceId && isDefaultClaudeInstance(instance),
        ),
      ),
    );

  const antigravityFallbackFor = Effect.fn("UsageLimitSources.antigravityFallbackFor")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings || !(yield* isDefaultClaudeInstanceId(instanceId))) return null;
    return antigravityFallbackTarget({ settings, ...(yield* fallbackInputs) });
  });

  const claudeLoginMovedAt = Effect.fn("UsageLimitSources.claudeLoginMovedAt")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings?.claudeSwapUsageEnabled || !(yield* isDefaultClaudeInstanceId(instanceId)))
      return null;
    return claudeSwapLoginMovedAt({
      ...(yield* fallbackInputs),
      atPercent: settings.claudeSwapAutoSwitchAtPercent,
      lastSwitchAtMs: (yield* Ref.get(autoSwitchClock)).lastSwitchAtMs,
    });
  });

  const claudeSwapHasRoom = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings) return false;
    return (
      claudeSwapAllFull({
        ...(yield* fallbackInputs),
        atPercent: settings.claudeSwapAutoSwitchAtPercent,
      }) === false
    );
  });

  return {
    antigravityFallbackFor,
    claudeSwapHasRoom,
    claudeLoginMovedAt,
    current: Ref.get(stateRef),
    consumeResetCredit,
    switchAccount,
    refresh,
    drainAutoSwitch: autoSwitchWorker.drain,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make);
