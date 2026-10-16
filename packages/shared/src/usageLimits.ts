import {
  type EnvironmentId,
  type UsageLimitsReport,
  type ProviderInstanceId,
  type ProviderConsumeResetCreditInput,
  type ServerProviderSlashCommand,
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSnapshots,
  type UsageLimitSourceSwitchAccountInput,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";

export function usesChatGptSharing(provider: ServerProvider | null | undefined): boolean {
  return provider?.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;
}

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: "Overall",
    description: "Combined usage across both allowances, not a third quota.",
  },
  {
    id: "autoPercentUsed",
    label: "Cursor Models",
    description: "Grok and Composer use this first. Auto can use either pool.",
  },
  {
    id: "apiPercentUsed",
    label: "Other Models",
    description: "Claude, GPT, and Gemini use this pool. Grok and Composer fall back here.",
  },
] as const;

export function cursorUsageWindowDetails(id: string) {
  return CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
}

function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}

export type LimitPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: {
      readonly providers?: readonly ServerProvider[] | undefined;
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
    } | null;
  }
>;

export function collectExternalUsageLinks(presentations: LimitPresentations) {
  const links = new Map<
    string,
    {
      readonly label: string;
      readonly url: string;
      readonly message: string | undefined;
      readonly accounts: readonly string[];
    }
  >();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const external = provider.usageLimits?.externalUsage;
      if (external && provider.auth.status === "authenticated") {
        const account = `${provider.displayName ?? provider.instanceId} on ${presentation.entry.target.label}`;
        links.set(external.url, {
          ...external,
          message: provider.usageLimits?.unavailable?.message,
          accounts: [...new Set([...(links.get(external.url)?.accounts ?? []), account])],
        });
      }
    }
  }
  return [...links.values()];
}

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const nativeReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

/**
 * Pass every enabled login, read or not, so an unreadable workspace still
 * counts as one.
 */
function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) {
      workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
    }
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

export interface LimitAccount {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly accentColor: string | undefined;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly sourceLabel: string | null;
  readonly redeem: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderConsumeResetCreditInput;
  } | null;
  /** The kind of source that reported the account, null when only native instances do. */
  readonly sourceKind: UsageLimitSourceSnapshot["kind"] | null;
  /** The account a source reported, for its alias, status, staleness and pace. */
  readonly sourceAccount: UsageLimitSourceAccount | null;
  /** A switching source (claude-swap) has it as some environment's current login. */
  readonly active: boolean;
  /**
   * Where to make this account the machine's Claude login. Null for accounts
   * already active there, logins that cannot serve turns, and sources that
   * cannot switch.
   */
  readonly switchTo: {
    readonly environmentId: EnvironmentId;
    readonly input: UsageLimitSourceSwitchAccountInput;
  } | null;
  readonly limits: ServerProviderUsageLimits;
}

/**
 * claude-swap statuses whose login cannot serve turns; switching to one would
 * strand every Claude thread. The server refuses them and clients never offer them.
 */
export const CLAUDE_SWAP_DEAD_STATUSES: ReadonlySet<string> = new Set([
  "relogin_required",
  "no_credentials",
  "keychain_unavailable",
]);

/** What a switch does to running sessions, for every confirm that asks for one. */
export const CLAUDE_SWAP_SWITCH_EFFECT =
  "Running Claude sessions on that machine that use the default Claude login move to the new account on their next request, or within about 30 seconds on macOS. T3 Claude instances with a custom Claude home are not affected.";

/**
 * The server's last automatic claude-swap switch as one line, or null when
 * there is none. Accounts are named by alias or slot, never by email: the
 * line is not blurred. Clients add the age of `autoSwitch.at` themselves.
 */
export function claudeSwapAutoSwitchLine(source: UsageLimitSourceSnapshot): string | null {
  const status = source.autoSwitch;
  if (!status) return null;
  if (status.outcome === "blocked") return "No account had room for an automatic switch.";
  if (status.outcome === "failed") {
    return status.detail ? `Automatic switch failed: ${status.detail}` : "Automatic switch failed.";
  }
  const name = (id: string) =>
    source.accounts.find((account) => account.id === id)?.alias ?? `account #${id}`;
  const from = status.fromAccountId ? ` from ${name(status.fromAccountId)}` : "";
  const to = status.toAccountId ? ` to ${name(status.toAccountId)}` : "";
  const limit = status.window === "weekly" ? "weekly" : "5-hour";
  const at =
    status.usedPercent !== undefined && status.window !== undefined
      ? ` at ${Math.round(status.usedPercent)}% of the ${limit} limit`
      : "";
  return `Switched automatically${from}${to}${at}.`;
}

/** Another claude-swap account, pinned by email, whose login can serve turns. */
export function canSwitchToClaudeSwapAccount(account: UsageLimitSourceAccount): boolean {
  return (
    account.active !== true &&
    Boolean(account.email) &&
    (account.status === undefined || !CLAUDE_SWAP_DEAD_STATUSES.has(account.status))
  );
}

/**
 * The claude-swap source managing the login a Claude instance reports, when
 * another of its accounts could take over after a usage limit. Instances with
 * their own Claude home report a different login and get none.
 */
export function claudeSwapSourceForProvider(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  provider: Pick<ServerProvider, "driver" | "auth"> | null | undefined,
): UsageLimitSourceSnapshot | null {
  const email = provider?.driver === "claudeAgent" ? provider.auth.email?.toLowerCase() : undefined;
  if (!email) return null;
  return (
    sources.find(
      (source) =>
        source.kind === "claudeSwap" &&
        source.error === undefined &&
        source.accounts.some(
          (account) => account.active === true && account.email?.toLowerCase() === email,
        ) &&
        source.accounts.some(canSwitchToClaudeSwapAccount),
    ) ?? null
  );
}

/** Antigravity's Claude quotas: the shared Claude & GPT buckets, or older accounts' Claude-only ones. */
const ANTIGRAVITY_CLAUDE_WINDOW_IDS: ReadonlySet<string> = new Set([
  "3p-5h",
  "3p-weekly",
  "claude-weekly",
  "claude-quota",
]);

export interface AntigravityClaudeFallback {
  readonly provider: ServerProvider;
  /** Its Claude windows that have not reset. */
  readonly windows: readonly ServerProviderUsageWindow[];
  /** The model a claude-swap fallback continues on; null when Antigravity lists no Claude model. */
  readonly model: ServerProviderModel | null;
}

/**
 * The Antigravity instance a claude-swap fallback would continue on, or null
 * when no enabled, available Antigravity instance exists.
 */
export function antigravityClaudeFallback(
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): AntigravityClaudeFallback | null {
  const provider = providers.find(
    (candidate) =>
      candidate.driver === "antigravity" && candidate.enabled && isProviderAvailable(candidate),
  );
  if (!provider) return null;
  const named = (pattern: RegExp) => {
    const matches = provider.models.filter(
      (model) => pattern.test(model.name) || pattern.test(model.slug),
    );
    // Antigravity lists each model per effort (`claude-opus-5-5-low|medium|high`): take the strongest.
    return (
      matches.find((model) => /high/i.test(model.slug)) ??
      matches.find((model) => /medium/i.test(model.slug)) ??
      matches[0]
    );
  };
  return {
    provider,
    windows: windowsNotYetReset(provider.usageLimits?.windows ?? [], now).filter((window) =>
      ANTIGRAVITY_CLAUDE_WINDOW_IDS.has(window.id),
    ),
    // shortcut: picked by name, Opus first; add a model setting if users need a specific variant.
    model: named(/opus/i) ?? named(/claude/i) ?? null,
  };
}

/**
 * Antigravity's Claude has room while it reports its quota and every Claude
 * window is below the claude-swap switch threshold.
 */
export function antigravityClaudeHasRoom(
  fallback: AntigravityClaudeFallback,
  atPercent: number,
): boolean {
  return (
    fallback.provider.usageLimits !== undefined &&
    fallback.provider.usageLimits.unavailable === undefined &&
    fallback.windows.length > 0 &&
    fallback.windows.every((window) => window.usedPercent < atPercent)
  );
}

function switchTarget(
  environmentId: EnvironmentId,
  source: UsageLimitSourceSnapshot,
  account: UsageLimitSourceAccount,
): LimitAccount["switchTo"] {
  if (source.kind !== "claudeSwap" || !account.email || !canSwitchToClaudeSwapAccount(account)) {
    return null;
  }
  return {
    environmentId,
    input: { sourceId: source.id, accountId: account.id, email: account.email },
  };
}

export function collectLimitAccounts(presentations: LimitPresentations): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const merge = (key: string, next: LimitAccount) => {
    // Redeeming through a hub also clears the routing cooldown that hub holds
    // for the account. Redeeming natively against the same subscription resets
    // it upstream but leaves the hub refusing to route to the account until
    // its own cooldown expires, so a hub target wins the redemption outright
    // while the displayed balance still follows the freshest read.
    const previousHub = hubRedeems.get(key);
    if (
      next.redeem &&
      "sourceId" in next.redeem.input &&
      (!previousHub || Date.parse(next.limits.checkedAt) > Date.parse(previousHub.limits.checkedAt))
    ) {
      hubRedeems.set(key, next);
    }
    const previousCredit = creditSources.get(key);
    if (
      next.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
    ) {
      creditSources.set(key, next);
    }
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const fresher = Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    const [sourceOwner, sourceOther] =
      next.sourceKind === "claudeSwap" && previous.sourceKind !== "claudeSwap"
        ? [next, previous]
        : [previous, next];
    const creditSource = creditSources.get(key);
    accounts.set(key, {
      ...previous,
      displayName: previous.displayName ?? next.displayName,
      plan: previous.plan ?? next.plan,
      accentColor: previous.accentColor ?? next.accentColor,
      environments,
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      redeem:
        hubRedeems.get(key)?.redeem ??
        (creditSource ? creditSource.redeem : (winner.redeem ?? previous.redeem ?? next.redeem)),
      // claude-swap's report owns the source details whichever order the
      // reports merged in: it alone knows the login's status and can switch.
      sourceKind: sourceOwner.sourceKind ?? sourceOther.sourceKind,
      sourceAccount: sourceOwner.sourceAccount ?? sourceOther.sourceAccount,
      active: previous.active || next.active,
      switchTo: sourceOwner.switchTo ?? sourceOther.switchTo,
      limits: {
        ...winner.limits,
        ...(creditSource?.limits.resetCredits
          ? { resetCredits: creditSource.limits.resetCredits }
          : { resetCredits: undefined }),
      },
    });
  };
  const resolveKey = accountKeyResolver(
    [...presentations.values()].flatMap((presentation) => [
      ...(presentation.serverConfig?.providers ?? [])
        .filter((provider) => provider.enabled)
        .map(nativeReport),
      ...(presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) => source.accounts),
    ]),
  );
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (!provider.usageLimits || limitsNotice(provider.usageLimits) !== null) continue;
      merge(resolveKey(nativeReport(provider)) ?? `${environmentId}:${provider.instanceId}`, {
        key: `${environmentId}:${provider.instanceId}`,
        driver: provider.driver,
        displayName: provider.displayName?.trim() || null,
        email: provider.auth.email,
        plan: provider.auth.label,
        accentColor: provider.accentColor,
        environments: [{ environmentId, label }],
        sourceLabel: null,
        redeem: { environmentId, input: { instanceId: provider.instanceId } },
        sourceKind: null,
        sourceAccount: null,
        active: false,
        switchTo: null,
        limits: provider.usageLimits,
      });
    }
  }
  const labelEnvironment = presentations.size > 1;
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = labelEnvironment
        ? `${presentation.entry.target.label} · ${source.label}`
        : source.label;
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) !== null) continue;
        const key = `${source.id}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;
        merge(resolveKey(account) ?? key, {
          key,
          driver: account.driver,
          displayName: account.email
            ? (account.alias ?? null)
            : (account.alias ?? account.id.replace(/\.json$/i, "")),
          email: account.email,
          plan: account.plan,
          accentColor: undefined,
          environments: [],
          sourceLabel,
          redeem: account.usageLimits.resetCredits?.nextCreditId
            ? {
                environmentId,
                input: {
                  sourceId: source.id,
                  accountId: account.id,
                  creditId: account.usageLimits.resetCredits.nextCreditId,
                },
              }
            : null,
          sourceKind: source.kind,
          sourceAccount: account,
          active: account.active === true,
          switchTo: switchTarget(environmentId, source, account),
          limits: account.usageLimits,
        });
      }
    }
  }
  return [...accounts.values()];
}

export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const notices: string[] = [];
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.usageLimits?.unavailable?.reason === "unsupported") continue;
      const notice = provider.usageLimits ? limitsNotice(provider.usageLimits) : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.push(`${label(environmentLabel, name)}: ${notice}`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.push(`${label(environmentLabel, source.label)}: ${source.error}`);
      } else if (source.accounts.length === 0) {
        notices.push(`${label(environmentLabel, source.label)}: No accounts reported.`);
      }
      // claude-swap holds the user's own logins, so one that cannot report is
      // worth a line. It is named by alias or slot: notices are not blurred.
      if (source.kind !== "claudeSwap") continue;
      for (const account of source.accounts) {
        if (account.usageLimits.unavailable?.reason !== "probeFailed") continue;
        const notice = limitsNotice(account.usageLimits);
        const name = account.alias ?? `account ${account.id}`;
        if (notice) notices.push(`${label(environmentLabel, source.label)} · ${name}: ${notice}`);
      }
    }
  }
  return notices;
}

/**
 * The presentations without claude-swap sources, for the shared notices where
 * a Claude accounts section already shows each source's error and every
 * account that cannot report.
 */
export function withoutClaudeSwapSources(presentations: LimitPresentations): LimitPresentations {
  return new Map(
    [...presentations].map(([environmentId, presentation]) => [
      environmentId,
      presentation.serverConfig?.usageLimitSources?.some((source) => source.kind === "claudeSwap")
        ? {
            ...presentation,
            serverConfig: {
              ...presentation.serverConfig,
              usageLimitSources: presentation.serverConfig.usageLimitSources.filter(
                (source) => source.kind !== "claudeSwap",
              ),
            },
          }
        : presentation,
    ]),
  );
}

/**
 * The account's bars are a source's last good reading rather than a current
 * one. A fresher report merged over it (say the native instance) is not stale.
 */
export function isStaleLimitAccount(account: LimitAccount): boolean {
  const source = account.sourceAccount;
  return source?.stale === true && source.usageLimits.checkedAt === account.limits.checkedAt;
}

/** `3h 12m old`, for a reading taken at `checkedAt`. */
export function readingAge(checkedAt: string, now: number): string {
  const at = Date.parse(checkedAt);
  return Number.isFinite(at) ? `${formatDuration(now - at)} old` : "old reading";
}

/**
 * The windows an account contributes to pools. A stale reading's window whose
 * reset has already passed says nothing about now, so it counts as unknown
 * rather than as still used.
 */
function poolableWindows(account: LimitAccount, now: number) {
  if (!isStaleLimitAccount(account)) return account.limits.windows;
  return windowsNotYetReset(account.limits.windows, now);
}

/** Windows whose reset has not passed; a window with no reset time is kept. */
export function windowsNotYetReset(windows: readonly ServerProviderUsageWindow[], now: number) {
  return windows.filter((window) => {
    const at = resetMillis(window);
    return at === null || at > now;
  });
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
}

export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  readonly columns: ReadonlyArray<{
    readonly account: LimitAccount;
    readonly window: ServerProviderUsageWindow | null;
  }>;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver === "antigravity") {
    return [...pool.windows].sort(
      (left, right) =>
        Number(!left.id.startsWith("gemini-")) - Number(!right.id.startsWith("gemini-")) ||
        left.id
          .replace(/-(5h|weekly|quota)$/, "")
          .localeCompare(right.id.replace(/-(5h|weekly|quota)$/, "")) ||
        WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind],
    );
  }
  if (pool.driver !== "cursor") return pool.windows;
  const hasAuto = pool.windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = pool.windows.some((window) => window.id === "apiPercentUsed");
  const hasBothPools = hasAuto && hasApi;
  return pool.windows
    .filter((window) => !hasBothPools || window.id !== "totalPercentUsed")
    .sort((left, right) => cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id));
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ServerProvider["driver"], LimitAccount[]>();
  for (const account of accounts) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members
      .flatMap((account) => poolableWindows(account, now))
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = poolableWindows(account, now).find(
        (window) => orderWindow && poolKey(driver, window) === poolKey(driver, orderWindow),
      );
      return (window ? resetMillis(window) : null) ?? Number.POSITIVE_INFINITY;
    };
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    );
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

/**
 * Codex ids are slots, not allowances: a weekly-only plan reports its weekly
 * window as `primary`, other plans as `secondary`. Its windows pool by kind;
 * other drivers' ids name distinct allowances.
 */
function poolKey(driver: ServerProvider["driver"], window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const window of poolableWindows(account, now)) {
      const pooled = poolKey(account.driver, window);
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push({ account, window });
      else byKey.set(key, [{ account, window }]);
    }
  }
  const pools = [...byKey].map(([key, members]): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    const usedPercent = members.reduce((sum, m) => sum + m.window.usedPercent, 0) / members.length;
    // Pace compares spend against the clock, so it is judged only over the
    // members that have a clock; a window with no reset would otherwise
    // count as spend with no time elapsed and skew the verdict.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null ? [] : [{ used: m.window.usedPercent, elapsed: share }];
    });
    const timedUsed = timed.reduce((sum, t) => sum + t.used, 0) / timed.length;
    const meanElapsed =
      timed.length > 0 ? timed.reduce((sum, t) => sum + t.elapsed, 0) / timed.length : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(member.window.usedPercent / members.length),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return "resets now";
  if (resetsAt - now < MINUTE) return "Resets momentarily";
  return `resets in ${formatDuration(resetsAt - now)}`;
}

export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

/** The driver an unreadable source (failed, no accounts) may cover: claude-swap only serves Claude, a hub any driver. */
function unreadableSourceDriver(source: UsageLimitSourceSnapshot): string | null {
  if (source.error === undefined || source.accounts.length > 0) return null;
  return source.kind === "claudeSwap" ? "claudeAgent" : "*";
}

export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  return (
    providersWithLimits(providers).some((provider) => provider.driver === driver) ||
    sources.some((source) => {
      const unreadable = unreadableSourceDriver(source);
      return (
        unreadable === "*" ||
        unreadable === driver ||
        source.accounts.some((account) => account.driver === driver)
      );
    })
  );
}

export function sameUsageLimitCommandCoverage(
  previous: UsageLimitSourceSnapshots,
  next: UsageLimitSourceSnapshots,
): boolean {
  const coverage = (sources: UsageLimitSourceSnapshots) =>
    new Set(
      sources.flatMap((source) => {
        const unreadable = unreadableSourceDriver(source);
        return unreadable !== null
          ? [unreadable]
          : source.accounts.map((account) => String(account.driver));
      }),
    );
  const before = coverage(previous);
  const after = coverage(next);
  return before.size === after.size && [...before].every((driver) => after.has(driver));
}

/** Advertise on workspace catalogs too, which replace the global command list. */
export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  return providers.map((provider) => {
    if (!hasProviderUsageLimits(provider.driver, providers, sources)) return provider;
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ];
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    };
  });
}

export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected || !hasProviderUsageLimits(selected.driver, providers, sources)) return null;
  const native = providersWithLimits(providers).filter(
    (provider) => provider.driver === selected.driver,
  );
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...sources.flatMap((source) => source.accounts),
  ]);
  const nativeAccounts = new Set(
    native.flatMap((provider) => {
      const key = resolveKey(nativeReport(provider));
      return key && provider.usageLimits?.windows.length && !provider.usageLimits.unavailable
        ? [key]
        : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const provider of native) {
    if (!provider.usageLimits) continue;
    const key = resolveKey(nativeReport(provider));
    const hubCredits = sources
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          resolveKey(account) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      )
      .sort(
        (a, b) =>
          Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
      )[0];
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!provider.usageLimits.resetCredits ||
        Date.parse(hubCredits.account.usageLimits.checkedAt) >
          Date.parse(provider.usageLimits.checkedAt));
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(provider.auth.label ? { plan: provider.auth.label } : {}),
      instanceId: provider.instanceId,
      resetCreditInput:
        hubCreditId && hubCredits
          ? {
              sourceId: hubCredits.source.id,
              accountId: hubCredits.account.id,
              creditId: hubCreditId,
            }
          : { instanceId: provider.instanceId },
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: showHubCredits
        ? { ...provider.usageLimits, resetCredits: hubCredits.account.usageLimits.resetCredits }
        : provider.usageLimits,
    });
  }
  for (const source of sources) {
    const matching = source.accounts.filter((account) => account.driver === selected.driver);
    const claudeSwap = source.kind === "claudeSwap";
    for (const account of matching) {
      const key = resolveKey(account);
      if (key && nativeAccounts.has(key)) continue;
      // A claude-swap login that cannot serve turns has no limits to report;
      // it is named in the notices instead, as Limits does.
      if (
        claudeSwap &&
        account.status !== undefined &&
        CLAUDE_SWAP_DEAD_STATUSES.has(account.status)
      ) {
        const notice = limitsNotice(account.usageLimits);
        if (notice)
          notices.push(`${source.label} · ${account.alias ?? `account ${account.id}`}: ${notice}`);
        continue;
      }
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: `${source.label} · ${account.alias ?? account.id}`,
        sourceLabel: source.label,
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        // A stale claude-swap reading's window whose reset has passed says
        // nothing about now, the same rule pooling uses.
        limits:
          claudeSwap && account.stale
            ? {
                ...account.usageLimits,
                windows: windowsNotYetReset(account.usageLimits.windows, now),
              }
            : account.usageLimits,
      });
    }
    const unreadable = unreadableSourceDriver(source);
    if (
      source.error &&
      (matching.length > 0 || unreadable === "*" || unreadable === selected.driver)
    ) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}
