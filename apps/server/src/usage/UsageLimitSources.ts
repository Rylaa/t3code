/**
 * UsageLimitSources — quota from sources beside the environment's own
 * provider instances: a CLIProxyAPI hub pooling several subscription
 * accounts, and claude-swap (`cswap`) holding several Claude logins for this
 * machine.
 *
 * Each configured `settings.usageLimitSources` entry, plus claude-swap when
 * `claudeSwapUsageEnabled` is on, is polled on the provider health-check
 * interval and on every settings change, then published as one snapshot per
 * source over `subscribeServerConfig`. claude-swap has its own lock and
 * publish step: cswap can take a minute or more, and hub reads and
 * redemptions must not wait on it. A source that fails keeps its row with
 * `error` set so the user can see it is configured but unreachable. Nothing
 * is persisted: like provider status, this is live state that re-derives on
 * boot.
 *
 * claude-swap accounts can also be switched to, which changes the login every
 * default Claude instance on this machine runs turns on.
 *
 * @module usage/UsageLimitSources
 */
import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ServerSettings,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSwitchAccountInput,
  type UsageLimitSourceSwitchAccountResult,
  UsageLimitSourceId as UsageLimitSourceIdSchema,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { CLAUDE_SWAP_DEAD_STATUSES } from "@t3tools/shared/usageLimits";
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
import { claudeSwapStatusMessage, makeClaudeSwapCli } from "./claudeSwapCli.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";

/** The one snapshot claude-swap publishes; it is a setting, not a configured entry. */
export const CLAUDE_SWAP_SOURCE_ID = UsageLimitSourceIdSchema.make("claude-swap");

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    /** The current set followed by every change, with repeats dropped. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    /**
     * Re-read every hub now and start a claude-swap read without waiting for
     * it. Never fails; failures land on the snapshot.
     */
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
  }
>()("t3/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  try {
    return new URL(config.url).host;
  } catch {
    return id;
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
  const update = (
    next: (
      previous: ReadonlyArray<UsageLimitSourceSnapshot>,
    ) => ReadonlyArray<UsageLimitSourceSnapshot>,
  ) =>
    Effect.gen(function* () {
      const previous = yield* Ref.get(stateRef);
      const value = next(previous);
      if (Equal.equals(previous, value)) return;
      yield* Ref.set(stateRef, value);
      yield* PubSub.publish(changes, value);
    }).pipe(publishLock.withPermits(1));
  const isClaudeSwap = (source: UsageLimitSourceSnapshot) => source.kind === "claudeSwap";
  const publishHubs = (hubs: ReadonlyArray<UsageLimitSourceSnapshot>) =>
    update((previous) => [...hubs, ...previous.filter(isClaudeSwap)]);
  const publishClaudeSwap = (snapshot: UsageLimitSourceSnapshot | undefined) =>
    update((previous) => [
      ...previous.filter((source) => !isClaudeSwap(source)),
      ...(snapshot ? [snapshot] : []),
    ]);

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
  const consumeResetCredit = (input: UsageLimitSourceConsumeResetCreditInput) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          () => new UsageLimitSourceError({ detail: "Could not read hub settings." }),
        ),
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
    }).pipe(hubLock.withPermits(1));

  // Default Claude instances share the login cswap just changed; their probe
  // cache would show the old account for minutes. Instances with their own
  // CLAUDE_CONFIG_DIR keep their login and are left alone.
  const refreshDefaultClaudeInstances = Effect.gen(function* () {
    const instances = yield* instanceRegistry.listInstances;
    yield* Effect.forEach(
      instances.filter(
        (instance) =>
          instance.enabled &&
          instance.driverKind === "claudeAgent" &&
          instance.continuationIdentity.continuationKey === defaultClaudeKey,
      ),
      (instance) =>
        (instance.invalidateCaches ?? Effect.void).pipe(
          Effect.andThen(providerRegistry.refreshInstance(instance.instanceId)),
        ),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  const switchClaudeSwapAccount = <E, R>(
    input: UsageLimitSourceSwitchAccountInput,
    beforeSwitch: Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
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
      yield* publishClaudeSwap(yield* readClaudeSwap(binaryPath));
      return result;
    }).pipe(claudeSwapLock.withPermits(1));

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

  // Settings edits re-read straight away so a new source shows up without
  // waiting for the interval, and a removed one leaves the list.
  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => ({
      sources: settings.usageLimitSources,
      claudeSwapUsageEnabled: settings.claudeSwapUsageEnabled,
      claudeSwapBinaryPath: settings.claudeSwapBinaryPath,
    })),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) =>
        Effect.sleep(Duration.toMillis(Duration.fromInputUnsafe(wait)) <= 0 ? "60 seconds" : wait),
      ),
      Effect.andThen(backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    switchAccount,
    refresh,
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
