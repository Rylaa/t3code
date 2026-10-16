/**
 * When T3 asks claude-swap for an automatic switch. claude-swap's own engine
 * (`cswap auto --once`) decides whether to switch and to which account, with
 * its own cooldown and hysteresis; this only decides when a cswap run is worth
 * starting.
 *
 * @module usage/claudeSwapAutoSwitch
 */
import type {
  ModelSelection,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerSettings,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import {
  antigravityClaudeFallback,
  antigravityClaudeHasRoom,
  CLAUDE_SWAP_DEAD_STATUSES,
  windowsNotYetReset,
} from "@t3tools/shared/usageLimits";

/** T3's readings lag claude-swap's, and cswap re-fetches near the line itself. */
const NEAR_BAND_PERCENT = 5;
const THROTTLE_MS = 60_000;
/** After a failed or blocked tick, so a broken cswap or full accounts are not retried every event. */
export const CLAUDE_SWAP_AUTO_BACKOFF_MS = 5 * 60_000;
/** Least gap between claude-swap reads made with no client connected: cswap serves cached usage for about this long. */
export const CLAUDE_SWAP_BACKGROUND_READ_MIN_MS = 3 * 60_000;

/** The account-wide windows cswap switches on; model-scoped weeklies do not count. */
const BINDING_WINDOW_IDS: ReadonlySet<string> = new Set(["five_hour", "seven_day"]);

function bindingPercent(limits: ServerProviderUsageLimits, nowMs: number): number | null {
  const used = windowsNotYetReset(limits.windows, nowMs)
    .filter((window) => BINDING_WINDOW_IDS.has(window.id))
    .map((window) => window.usedPercent);
  return used.length > 0 ? Math.max(...used) : null;
}

/**
 * The active claude-swap account's fuller 5-hour or weekly window, read from
 * the freshest of claude-swap's own row and the default Claude instances
 * signed in to the same account (mid-turn rate-limit updates land there).
 * Null when nothing current is known: T3 never drives cswap's failover.
 */
export function claudeSwapActiveBindingPercent(input: {
  readonly source: UsageLimitSourceSnapshot | undefined;
  readonly defaultProviders: ReadonlyArray<Pick<ServerProvider, "auth" | "usageLimits">>;
  readonly nowMs: number;
}): number | null {
  const active = input.source?.accounts.find((account) => account.active === true);
  if (!active) return null;
  const email = active.email?.toLowerCase();
  const readings = [
    ...(active.stale !== true ? [active.usageLimits] : []),
    ...input.defaultProviders.flatMap((provider) =>
      email !== undefined && provider.auth.email?.toLowerCase() === email && provider.usageLimits
        ? [provider.usageLimits]
        : [],
    ),
  ]
    .filter((limits) => limits.unavailable === undefined)
    .flatMap((limits) => {
      const percent = bindingPercent(limits, input.nowMs);
      return percent === null ? [] : [{ at: Date.parse(limits.checkedAt), percent }];
    })
    .toSorted((left, right) => right.at - left.at);
  return readings[0]?.percent ?? null;
}

/**
 * Whether to run one `cswap auto --once` now: the binding window is within a
 * few points of the threshold, no tick ran in the last minute, and the last
 * failed or blocked tick's back-off is over.
 */
export function decideClaudeSwapAutoTick(input: {
  readonly enabled: boolean;
  readonly atPercent: number;
  readonly bindingPercent: number | null;
  readonly nowMs: number;
  readonly lastTickAtMs: number | null;
  readonly backoffUntilMs: number | null;
}): "tick" | "skip" {
  if (!input.enabled || input.bindingPercent === null) return "skip";
  if (input.bindingPercent < input.atPercent - NEAR_BAND_PERCENT) return "skip";
  if (input.backoffUntilMs !== null && input.nowMs < input.backoffUntilMs) return "skip";
  if (input.lastTickAtMs !== null && input.nowMs - input.lastTickAtMs < THROTTLE_MS) return "skip";
  return "tick";
}

/**
 * Whether every claude-swap account cswap could move the login to is at or
 * above the threshold. The active account uses the freshest reading, as the
 * automatic switch does. Null when T3 cannot tell: no snapshot, a failed read,
 * or no readable account. Unknown never counts as full.
 */
export function claudeSwapAllFull(input: {
  readonly source: UsageLimitSourceSnapshot | undefined;
  readonly defaultProviders: ReadonlyArray<Pick<ServerProvider, "auth" | "usageLimits">>;
  readonly atPercent: number;
  readonly nowMs: number;
}): boolean | null {
  if (!input.source || input.source.error !== undefined) return null;
  const activePercent = claudeSwapActiveBindingPercent(input);
  const percents = input.source.accounts.flatMap((account) => {
    if (
      account.disabled === true ||
      (account.status !== undefined && CLAUDE_SWAP_DEAD_STATUSES.has(account.status))
    )
      return [];
    const percent =
      account.active === true && activePercent !== null
        ? activePercent
        : account.stale === true || account.usageLimits.unavailable !== undefined
          ? null
          : (bindingPercent(account.usageLimits, input.nowMs) ??
            // Every binding window it reported has reset since: it has room.
            (account.usageLimits.windows.some((window) => BINDING_WINDOW_IDS.has(window.id))
              ? 0
              : null));
    return percent === null ? [] : [percent];
  });
  if (percents.length === 0) return null;
  return percents.every((percent) => percent >= input.atPercent);
}

/**
 * Where a default-home Claude thread stopped by a usage limit continues: the
 * Antigravity Claude model, only as the last resort. Null unless the fallback
 * and automatic switching are on, every claude-swap account is full, and
 * Antigravity's Claude windows are all below the same threshold.
 */
export function antigravityFallbackTarget(input: {
  readonly settings: Pick<
    ServerSettings,
    | "claudeSwapUsageEnabled"
    | "claudeSwapAutoSwitchEnabled"
    | "claudeSwapAutoSwitchAtPercent"
    | "claudeSwapAntigravityFallbackEnabled"
  >;
  readonly source: UsageLimitSourceSnapshot | undefined;
  readonly defaultProviders: ReadonlyArray<Pick<ServerProvider, "auth" | "usageLimits">>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
}): ModelSelection | null {
  const { settings } = input;
  if (
    !settings.claudeSwapUsageEnabled ||
    !settings.claudeSwapAutoSwitchEnabled ||
    !settings.claudeSwapAntigravityFallbackEnabled
  )
    return null;
  const atPercent = settings.claudeSwapAutoSwitchAtPercent;
  if (claudeSwapAllFull({ ...input, atPercent }) !== true) return null;
  const fallback = antigravityClaudeFallback(input.providers, input.nowMs);
  if (!fallback?.model || !antigravityClaudeHasRoom(fallback, atPercent)) return null;
  return { instanceId: fallback.provider.instanceId, model: fallback.model.slug };
}
