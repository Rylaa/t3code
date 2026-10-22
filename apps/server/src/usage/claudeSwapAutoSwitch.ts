/**
 * T3's automatic claude-swap switch: when to move the machine's Claude login
 * and to which account. T3 decides because its readings are fresher than
 * cswap's: a turn's rate-limit update lands on the default Claude instance
 * with every response, while cswap polls each account every few minutes, so
 * `cswap auto` kept seeing an account under the line until it was spent.
 * cswap only performs the switch.
 *
 * @module usage/claudeSwapAutoSwitch
 */
import type {
  ModelSelection,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  ServerSettings,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import {
  antigravityClaudeFallback,
  antigravityClaudeHasRoom,
  canSwitchToClaudeSwapAccount,
  CLAUDE_SWAP_DEAD_STATUSES,
  windowsNotYetReset,
} from "@t3tools/shared/usageLimits";

/** After a failed or blocked switch, so a broken cswap or full accounts are not retried every event. */
export const CLAUDE_SWAP_AUTO_BACKOFF_MS = 5 * 60_000;
/** Least gap between claude-swap reads made with no client connected: cswap serves cached usage for about this long. */
export const CLAUDE_SWAP_BACKGROUND_READ_MIN_MS = 3 * 60_000;
/**
 * After a switch, running sessions take up to about 30 seconds to move to the
 * new login, and their rate-limit updates until then describe the old account.
 */
export const CLAUDE_SWAP_SWITCH_SETTLE_MS = 60_000;
/** A move below the threshold needs quota that runs out at least this much sooner. */
const PRIORITY_MARGIN_MS = 10 * 60_000;
const FIVE_HOURS_MS = 5 * 60 * 60_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

/** The account-wide windows that stop Claude; model-scoped weeklies do not count. */
const BINDING_WINDOW_IDS: ReadonlySet<string> = new Set(["five_hour", "seven_day"]);

function bindingWindow(
  limits: ServerProviderUsageLimits,
  nowMs: number,
): ServerProviderUsageWindow | undefined {
  return windowsNotYetReset(limits.windows, nowMs)
    .filter((window) => BINDING_WINDOW_IDS.has(window.id))
    .reduce<ServerProviderUsageWindow | undefined>(
      (fullest, window) =>
        fullest === undefined || window.usedPercent > fullest.usedPercent ? window : fullest,
      undefined,
    );
}

/** A non-active row's binding usage, or null when claude-swap's reading says nothing about now. */
function rowPercent(account: UsageLimitSourceAccount, nowMs: number): number | null {
  if (account.stale === true || account.usageLimits.unavailable !== undefined) return null;
  return (
    bindingWindow(account.usageLimits, nowMs)?.usedPercent ??
    // Every binding window it reported has reset since: it has room.
    (account.usageLimits.windows.some((window) => BINDING_WINDOW_IDS.has(window.id)) ? 0 : null)
  );
}

/**
 * When an account's unused quota is lost: its weekly reset when it has a
 * weekly limit, else its 5-hour reset (Team seats have no weekly limit). A
 * window that has reset or not started yet runs a full period from first use.
 */
function quotaExpiresAtMs(limits: ServerProviderUsageLimits, nowMs: number): number {
  const weekly = limits.windows.some((window) => window.id === "seven_day");
  const id = weekly ? "seven_day" : "five_hour";
  const resetsAt = windowsNotYetReset(limits.windows, nowMs).find(
    (window) => window.id === id,
  )?.resetsAt;
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return Number.isFinite(at) ? at : nowMs + (weekly ? SEVEN_DAYS_MS : FIVE_HOURS_MS);
}

interface ActiveReadingInput {
  readonly source: UsageLimitSourceSnapshot | undefined;
  readonly defaultProviders: ReadonlyArray<Pick<ServerProvider, "auth" | "usageLimits">>;
  readonly nowMs: number;
  /** Default-instance readings from before this may still be the previous login's. */
  readonly instanceReadingsSinceMs?: number | null;
}

/**
 * The active account's fuller 5-hour or weekly window, read from the freshest
 * of claude-swap's own row and the default Claude instances signed in to the
 * same account (mid-turn rate-limit updates land there). An instance window
 * the row lacks is the previous login's: a Team seat has no weekly limit.
 */
function activeBindingWindow(input: ActiveReadingInput): ServerProviderUsageWindow | undefined {
  const active = input.source?.accounts.find((account) => account.active === true);
  if (!active) return undefined;
  const email = active.email?.toLowerCase();
  const rowWindowIds = new Set(active.usageLimits.windows.map((window) => window.id));
  const since = input.instanceReadingsSinceMs ?? Number.NEGATIVE_INFINITY;
  const instanceReadings = input.defaultProviders.flatMap((provider) => {
    const limits = provider.usageLimits;
    if (email === undefined || provider.auth.email?.toLowerCase() !== email || !limits) return [];
    if (Date.parse(limits.checkedAt) < since) return [];
    return rowWindowIds.size === 0
      ? [limits]
      : [{ ...limits, windows: limits.windows.filter((window) => rowWindowIds.has(window.id)) }];
  });
  return [...(active.stale !== true ? [active.usageLimits] : []), ...instanceReadings]
    .filter((limits) => limits.unavailable === undefined)
    .flatMap((limits) => {
      const window = bindingWindow(limits, input.nowMs);
      return window === undefined ? [] : [{ at: Date.parse(limits.checkedAt), window }];
    })
    .toSorted((left, right) => right.at - left.at)[0]?.window;
}

/** The active account's binding usage; null when nothing current is known. */
export function claudeSwapActiveBindingPercent(input: ActiveReadingInput): number | null {
  return activeBindingWindow(input)?.usedPercent ?? null;
}

export type ClaudeSwapAutoSwitchDecision =
  | {
      readonly outcome: "switch";
      readonly fromAccountId: string;
      readonly toAccountId: string;
      readonly email: string;
      /** Set when the active account reached the threshold; absent for a move to quota that runs out sooner. */
      readonly usedPercent?: number;
      readonly window?: "session" | "weekly";
    }
  | { readonly outcome: "blocked" };

/**
 * Where the login should go now, or null to stay. Accounts with room are
 * ranked by when their unused quota is lost, soonest first, so perishable
 * quota is spent before quota that keeps. At the threshold the login moves
 * to the first of them; below it, only to one whose quota runs out
 * meaningfully sooner than the active account's. Nothing happens while the
 * active reading is unknown, inside the back-off, or while a switch settles.
 */
export function decideClaudeSwapAutoSwitch(input: {
  readonly source: UsageLimitSourceSnapshot | undefined;
  readonly defaultProviders: ReadonlyArray<Pick<ServerProvider, "auth" | "usageLimits">>;
  readonly atPercent: number;
  readonly nowMs: number;
  readonly lastSwitchAtMs: number | null;
  readonly backoffUntilMs: number | null;
}): ClaudeSwapAutoSwitchDecision | null {
  const { source, nowMs, lastSwitchAtMs } = input;
  if (!source || source.error !== undefined) return null;
  if (input.backoffUntilMs !== null && nowMs < input.backoffUntilMs) return null;
  if (lastSwitchAtMs !== null && nowMs - lastSwitchAtMs < CLAUDE_SWAP_SWITCH_SETTLE_MS) return null;
  const active = source.accounts.find((account) => account.active === true);
  const binding = activeBindingWindow({
    ...input,
    instanceReadingsSinceMs:
      lastSwitchAtMs === null ? null : lastSwitchAtMs + CLAUDE_SWAP_SWITCH_SETTLE_MS,
  });
  if (!active || !binding) return null;
  const first = source.accounts
    .flatMap((account) => {
      const email = account.email;
      const percent = rowPercent(account, nowMs);
      return email &&
        account.disabled !== true &&
        canSwitchToClaudeSwapAccount(account) &&
        percent !== null &&
        percent < input.atPercent
        ? [
            {
              id: account.id,
              email,
              percent,
              expiresAtMs: quotaExpiresAtMs(account.usageLimits, nowMs),
            },
          ]
        : [];
    })
    .toSorted(
      (left, right) => left.expiresAtMs - right.expiresAtMs || left.percent - right.percent,
    )[0];
  if (!first) return binding.usedPercent >= input.atPercent ? { outcome: "blocked" } : null;
  const move = {
    outcome: "switch",
    fromAccountId: active.id,
    toAccountId: first.id,
    email: first.email,
  } as const;
  if (binding.usedPercent >= input.atPercent) {
    return {
      ...move,
      usedPercent: binding.usedPercent,
      window: binding.id === "seven_day" ? "weekly" : "session",
    };
  }
  return first.expiresAtMs <= quotaExpiresAtMs(active.usageLimits, nowMs) - PRIORITY_MARGIN_MS
    ? move
    : null;
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
        : rowPercent(account, input.nowMs);
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
