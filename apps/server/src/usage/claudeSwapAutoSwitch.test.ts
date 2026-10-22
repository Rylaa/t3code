import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";

import {
  antigravityFallbackTarget,
  claudeSwapActiveBindingPercent,
  claudeSwapAllFull,
  claudeSwapLoginMovedAt,
  decideClaudeSwapAutoSwitch,
} from "./claudeSwapAutoSwitch.ts";

const nowMs = Date.parse("2026-10-08T12:10:00.000Z");
const later = "2026-10-08T15:00:00.000Z";

const window = (
  id: string,
  usedPercent: number,
  resetsAt: string = later,
): ServerProviderUsageWindow => ({
  id,
  kind: id === "five_hour" ? "session" : "weekly",
  label: id,
  usedPercent,
  resetsAt,
});

const account = (overrides: Partial<UsageLimitSourceAccount> = {}): UsageLimitSourceAccount => ({
  id: "1",
  driver: ProviderDriverKind.make("claudeAgent"),
  email: "Active@example.com",
  active: true,
  status: "ok",
  usageLimits: {
    checkedAt: "2026-10-08T12:00:00.000Z",
    windows: [window("five_hour", 40), window("seven_day", 60)],
  },
  ...overrides,
});

const source = (accounts: UsageLimitSourceAccount[]): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("claude-swap"),
  kind: "claudeSwap",
  label: "claude-swap",
  checkedAt: "2026-10-08T12:00:00.000Z",
  accounts,
});

const native = (
  email: string,
  windows: ServerProviderUsageWindow[],
  checkedAt = "2026-10-08T12:05:00.000Z",
): Pick<ServerProvider, "auth" | "usageLimits"> => ({
  auth: { status: "authenticated", email },
  usageLimits: { checkedAt, windows },
});

const binding = (
  accounts: UsageLimitSourceAccount[],
  defaultProviders: ReadonlyArray<Pick<ServerProvider, "auth" | "usageLimits">> = [],
) => claudeSwapActiveBindingPercent({ source: source(accounts), defaultProviders, nowMs });

describe("claudeSwapActiveBindingPercent", () => {
  it("is the fuller of the active account's 5-hour and weekly windows", () => {
    expect(binding([account({ id: "2", active: false }), account()])).toBe(60);
  });

  it("is unknown without an active claude-swap account", () => {
    expect(claudeSwapActiveBindingPercent({ source: undefined, defaultProviders: [], nowMs })).toBe(
      null,
    );
    expect(binding([account({ active: false })])).toBeNull();
  });

  it("ignores model-scoped weekly windows", () => {
    const usageLimits = {
      checkedAt: "2026-10-08T12:00:00.000Z",
      windows: [window("five_hour", 20), window("seven_day_opus", 99)],
    };
    expect(binding([account({ usageLimits })])).toBe(20);
  });

  it("ignores windows whose reset has passed", () => {
    const usageLimits = {
      checkedAt: "2026-10-08T12:00:00.000Z",
      windows: [window("five_hour", 97, "2026-10-08T12:00:00.000Z"), window("seven_day", 30)],
    };
    expect(binding([account({ usageLimits })])).toBe(30);
  });

  it("uses a fresher default Claude reading for the same account", () => {
    expect(binding([account()], [native("active@example.com", [window("five_hour", 92)])])).toBe(
      92,
    );
    // Older than claude-swap's row: the row wins.
    expect(
      binding(
        [account()],
        [native("active@example.com", [window("five_hour", 92)], "2026-10-08T11:00:00.000Z")],
      ),
    ).toBe(60);
  });

  it("uses the default Claude reading when claude-swap's row is stale", () => {
    const stale = account({
      stale: true,
      usageLimits: { checkedAt: "2026-10-08T12:00:00.000Z", windows: [window("five_hour", 99)] },
    });
    expect(binding([stale])).toBeNull();
    expect(binding([stale], [native("active@example.com", [window("five_hour", 91)])])).toBe(91);
  });

  it("ignores a default Claude instance signed in to another account", () => {
    const stale = account({ stale: true });
    expect(binding([stale], [native("other@example.com", [window("five_hour", 99)])])).toBeNull();
  });

  it("ignores an instance window the claude-swap row does not have", () => {
    // A Team seat has no weekly limit: a weekly window on the instance is the previous login's.
    const team = account({
      usageLimits: { checkedAt: "2026-10-08T12:00:00.000Z", windows: [window("five_hour", 40)] },
    });
    expect(
      binding(
        [team],
        [native("active@example.com", [window("five_hour", 50), window("seven_day", 99)])],
      ),
    ).toBe(50);
  });

  it("ignores a row claude-swap could not read", () => {
    const usageLimits = {
      checkedAt: "2026-10-08T12:00:00.000Z",
      windows: [],
      unavailable: { reason: "probeFailed" as const },
    };
    expect(binding([account({ usageLimits })])).toBeNull();
  });
});

describe("decideClaudeSwapAutoSwitch", () => {
  const limits = (windows: ServerProviderUsageWindow[]) => ({
    checkedAt: "2026-10-08T12:00:00.000Z",
    windows,
  });
  /** A Team seat: a 5-hour window and no weekly one. */
  const team = (
    id: string,
    usedPercent: number,
    resetsAt: string,
    overrides: Partial<UsageLimitSourceAccount> = {},
  ) =>
    account({
      id,
      active: false,
      email: `${id}@example.com`,
      usageLimits: limits([window("five_hour", usedPercent, resetsAt)]),
      ...overrides,
    });
  /** A Max account: a 5-hour window and a weekly one at 30%. */
  const max = (
    id: string,
    usedPercent: number,
    weeklyResetsAt: string,
    overrides: Partial<UsageLimitSourceAccount> = {},
  ) =>
    account({
      id,
      active: false,
      email: `${id}@example.com`,
      usageLimits: limits([
        window("five_hour", usedPercent),
        window("seven_day", 30, weeklyResetsAt),
      ]),
      ...overrides,
    });
  const decide = (
    accounts: UsageLimitSourceAccount[],
    overrides: Partial<Parameters<typeof decideClaudeSwapAutoSwitch>[0]> = {},
  ) =>
    decideClaudeSwapAutoSwitch({
      source: source(accounts),
      defaultProviders: [],
      atPercent: 90,
      nowMs,
      lastSwitchAtMs: null,
      backoffUntilMs: null,
      ...overrides,
    });
  const farWeekly = "2026-10-12T00:00:00.000Z";
  const spentMax = max("1", 91, farWeekly, { active: true });

  it("at the threshold, moves to the account whose quota runs out first", () => {
    expect(
      decide([
        spentMax,
        team("2", 10, "2026-10-08T14:00:00.000Z"),
        team("3", 50, "2026-10-08T13:00:00.000Z"),
        max("4", 0, "2026-10-09T00:00:00.000Z"),
      ]),
    ).toEqual({
      outcome: "switch",
      fromAccountId: "1",
      toAccountId: "3",
      email: "3@example.com",
      usedPercent: 91,
      window: "session",
    });
  });

  it("ranks a weekly reset that comes before a Team seat's 5-hour reset first", () => {
    expect(
      decide([
        spentMax,
        team("2", 10, "2026-10-08T14:00:00.000Z"),
        max("3", 0, "2026-10-08T13:30:00.000Z"),
      ]),
    ).toMatchObject({ toAccountId: "3" });
  });

  it("names the weekly window when it binds", () => {
    const weeklySpent = account({
      usageLimits: limits([window("five_hour", 40), window("seven_day", 95)]),
    });
    expect(decide([weeklySpent, team("2", 10, later)])).toMatchObject({
      usedPercent: 95,
      window: "weekly",
    });
  });

  it("counts a window that has reset as fresh quota for a full period", () => {
    expect(
      decide([
        spentMax,
        team("2", 100, "2026-10-08T12:00:00.000Z"),
        max("3", 0, "2026-10-09T00:00:00.000Z"),
      ]),
    ).toMatchObject({ toAccountId: "2" });
  });

  it("skips accounts without room or a usable login, and is blocked when none is left", () => {
    const soon = "2026-10-08T13:00:00.000Z";
    const unusable = [
      team("2", 90, soon),
      team("3", 10, soon, { disabled: true }),
      team("4", 10, soon, { status: "relogin_required" }),
      team("5", 10, soon, { stale: true }),
      team("6", 10, soon, {
        usageLimits: {
          checkedAt: "2026-10-08T12:00:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      }),
    ];
    expect(decide([spentMax, ...unusable, team("7", 10, later)])).toMatchObject({
      toAccountId: "7",
    });
    expect(decide([spentMax, ...unusable])).toEqual({ outcome: "blocked" });
  });

  it("below the threshold, moves only to quota that runs out at least ten minutes sooner", () => {
    const working = max("1", 40, farWeekly, { active: true });
    expect(decide([working, team("2", 10, later)])).toEqual({
      outcome: "switch",
      fromAccountId: "1",
      toAccountId: "2",
      email: "2@example.com",
    });
    const seat = team("1", 40, "2026-10-08T14:00:00.000Z", { active: true });
    expect(decide([seat, team("2", 10, "2026-10-08T13:51:00.000Z")])).toBeNull();
    expect(decide([seat, team("3", 10, "2026-10-08T13:50:00.000Z")])).toMatchObject({
      toAccountId: "3",
    });
    expect(decide([seat, max("4", 0, farWeekly)])).toBeNull();
    expect(decide([working])).toBeNull();
  });

  it("does nothing without a current reading, inside the back-off, or while a switch settles", () => {
    const accounts = [spentMax, team("2", 10, later)];
    expect(decide([{ ...spentMax, stale: true }, team("2", 10, later)])).toBeNull();
    expect(
      decideClaudeSwapAutoSwitch({
        source: { ...source(accounts), error: "cswap failed" },
        defaultProviders: [],
        atPercent: 90,
        nowMs,
        lastSwitchAtMs: null,
        backoffUntilMs: null,
      }),
    ).toBeNull();
    expect(decide(accounts, { backoffUntilMs: nowMs + 1 })).toBeNull();
    expect(decide(accounts, { backoffUntilMs: nowMs })).not.toBeNull();
    expect(decide(accounts, { lastSwitchAtMs: nowMs - 59_999 })).toBeNull();
    expect(decide(accounts, { lastSwitchAtMs: nowMs - 60_000 })).not.toBeNull();
  });

  it("acts on a fresher turn reading, but not one from before the last switch settled", () => {
    const working = max("1", 40, farWeekly, { active: true, email: "active@example.com" });
    const accounts = [working, max("2", 10, "2026-10-13T00:00:00.000Z")];
    const turn = [native("active@example.com", [window("five_hour", 95)])];
    expect(decide(accounts, { defaultProviders: turn })).toMatchObject({
      toAccountId: "2",
      usedPercent: 95,
    });
    // The reading at 12:05 came in before the 12:04:30 switch had settled.
    expect(
      decide(accounts, {
        defaultProviders: turn,
        lastSwitchAtMs: Date.parse("2026-10-08T12:04:30.000Z"),
      }),
    ).toBeNull();
  });
});

describe("claudeSwapLoginMovedAt", () => {
  const switchedAt = Date.parse("2026-10-08T12:04:30.000Z");
  const movedAt = (
    accounts: UsageLimitSourceAccount[],
    options: {
      readonly lastSwitchAtMs?: number | null;
      readonly defaultProviders?: ReadonlyArray<Pick<ServerProvider, "auth" | "usageLimits">>;
      readonly nowMs?: number;
    } = {},
  ) =>
    claudeSwapLoginMovedAt({
      source: source(accounts),
      defaultProviders: options.defaultProviders ?? [],
      atPercent: 90,
      nowMs: options.nowMs ?? nowMs,
      lastSwitchAtMs: options.lastSwitchAtMs === undefined ? switchedAt : options.lastSwitchAtMs,
    });

  it("is when the switch settled, once it has", () => {
    expect(movedAt([account()])).toBe(switchedAt + 60_000);
    expect(movedAt([account()], { nowMs: switchedAt + 59_999 })).toBeNull();
    expect(movedAt([account()], { lastSwitchAtMs: null })).toBeNull();
  });

  it("needs the new account to read below the threshold", () => {
    const spent = account({
      usageLimits: { checkedAt: "2026-10-08T12:06:00.000Z", windows: [window("seven_day", 90)] },
    });
    expect(movedAt([spent])).toBeNull();
    expect(movedAt([account({ stale: true })])).toBeNull();
  });

  it("reads the new account, not the old login's turn readings", () => {
    const old = [
      native("active@example.com", [window("five_hour", 99)], "2026-10-08T12:05:00.000Z"),
    ];
    expect(movedAt([account()], { defaultProviders: old })).toBe(switchedAt + 60_000);
    const fresh = [
      native("active@example.com", [window("five_hour", 99)], "2026-10-08T12:06:00.000Z"),
    ];
    expect(movedAt([account()], { defaultProviders: fresh })).toBeNull();
  });
});

const full = (id: string, overrides: Partial<UsageLimitSourceAccount> = {}) =>
  account({
    id,
    active: false,
    email: `${id}@example.com`,
    usageLimits: {
      checkedAt: "2026-10-08T12:00:00.000Z",
      windows: [window("five_hour", 95), window("seven_day", 30)],
    },
    ...overrides,
  });

const allFull = (
  accounts: UsageLimitSourceAccount[] | undefined,
  defaultProviders: ReadonlyArray<Pick<ServerProvider, "auth" | "usageLimits">> = [],
) =>
  claudeSwapAllFull({
    source: accounts ? source(accounts) : undefined,
    defaultProviders,
    atPercent: 90,
    nowMs,
  });

describe("claudeSwapAllFull", () => {
  it("is unknown without a readable snapshot", () => {
    expect(allFull(undefined)).toBeNull();
    expect(
      claudeSwapAllFull({
        source: { ...source([full("1")]), error: "cswap failed" },
        defaultProviders: [],
        atPercent: 90,
        nowMs,
      }),
    ).toBeNull();
    expect(allFull([])).toBeNull();
  });

  it("is full only when every account is at the threshold", () => {
    expect(allFull([full("1"), full("2")])).toBe(true);
    expect(allFull([full("1"), account({ id: "2", active: false })])).toBe(false);
    const atThreshold = full("3", {
      usageLimits: { checkedAt: "2026-10-08T12:00:00.000Z", windows: [window("seven_day", 90)] },
    });
    expect(allFull([full("1"), atThreshold])).toBe(true);
  });

  it("ignores disabled, dead, stale and unreadable accounts", () => {
    const room = account({ id: "9", active: false });
    expect(allFull([full("1"), { ...room, disabled: true }])).toBe(true);
    expect(allFull([full("1"), { ...room, status: "relogin_required" }])).toBe(true);
    expect(allFull([full("1"), { ...room, stale: true }])).toBe(true);
    expect(
      allFull([
        full("1"),
        {
          ...room,
          usageLimits: { ...room.usageLimits, unavailable: { reason: "probeFailed" } },
        },
      ]),
    ).toBe(true);
    expect(allFull([{ ...room, stale: true }])).toBeNull();
  });

  it("counts a full window that has already reset as room", () => {
    const reset = full("2", {
      usageLimits: {
        checkedAt: "2026-10-08T12:00:00.000Z",
        windows: [window("five_hour", 100, "2026-10-08T12:00:00.000Z"), window("seven_day", 30)],
      },
    });
    expect(allFull([full("1"), reset])).toBe(false);
    const allReset = full("3", {
      usageLimits: {
        checkedAt: "2026-10-08T12:00:00.000Z",
        windows: [window("five_hour", 100, "2026-10-08T12:00:00.000Z")],
      },
    });
    expect(allFull([full("1"), allReset])).toBe(false);
  });

  it("reads the active account from the freshest default Claude reading", () => {
    // claude-swap still shows the active account under the line; the turn just hit it.
    const active = account({ email: "active@example.com" });
    expect(allFull([active, full("2")])).toBe(false);
    expect(
      allFull([active, full("2")], [native("active@example.com", [window("five_hour", 100)])]),
    ).toBe(true);
  });
});

describe("antigravityFallbackTarget", () => {
  const antigravity = (
    windows: ServerProviderUsageWindow[],
    overrides: Partial<ServerProvider> = {},
  ): ServerProvider => ({
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-08T12:00:00.000Z",
    models: [
      { slug: "claude-sonnet", name: "Claude Sonnet 4.6", isCustom: false, capabilities: null },
      { slug: "claude-opus", name: "Claude Opus 4.6", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-10-08T12:00:00.000Z", windows },
    ...overrides,
  });
  const settings = {
    claudeSwapUsageEnabled: true,
    claudeSwapAutoSwitchEnabled: true,
    claudeSwapAutoSwitchAtPercent: 90,
    claudeSwapAntigravityFallbackEnabled: true,
  };
  const base = {
    settings,
    source: source([full("1"), full("2")]),
    defaultProviders: [],
    providers: [antigravity([window("3p-5h", 40), window("3p-weekly", 50)])],
    nowMs,
  };

  it("continues on Antigravity's Opus once every claude-swap account is full", () => {
    expect(antigravityFallbackTarget(base)).toEqual({
      instanceId: ProviderInstanceId.make("antigravity"),
      model: "claude-opus",
    });
  });

  it.each([
    "claudeSwapUsageEnabled",
    "claudeSwapAutoSwitchEnabled",
    "claudeSwapAntigravityFallbackEnabled",
  ] as const)("does nothing with %s off", (key) => {
    expect(antigravityFallbackTarget({ ...base, settings: { ...settings, [key]: false } })).toBe(
      null,
    );
  });

  it("is the last resort: never while a claude-swap account has room or is unknown", () => {
    expect(
      antigravityFallbackTarget({
        ...base,
        source: source([full("1"), account({ id: "2", active: false })]),
      }),
    ).toBeNull();
    expect(antigravityFallbackTarget({ ...base, source: undefined })).toBeNull();
    expect(
      antigravityFallbackTarget({ ...base, source: { ...source([full("1")]), error: "failed" } }),
    ).toBeNull();
  });

  it("stops Antigravity at the claude-swap threshold too", () => {
    const at = (percent: number, atPercent = 90) =>
      antigravityFallbackTarget({
        ...base,
        settings: { ...settings, claudeSwapAutoSwitchAtPercent: atPercent },
        providers: [antigravity([window("3p-5h", percent), window("3p-weekly", 10)])],
      });
    expect(at(89)).not.toBeNull();
    expect(at(90)).toBeNull();
    expect(at(80, 80)).toBeNull();
    expect(at(79, 80)).not.toBeNull();
  });

  it("needs Antigravity's Claude quota and a Claude model", () => {
    const target = (provider: ServerProvider) =>
      antigravityFallbackTarget({ ...base, providers: [provider] });
    expect(target(antigravity([window("gemini-5h", 10)]))).toBeNull();
    expect(target(antigravity([window("3p-5h", 10)], { usageLimits: undefined }))).toBeNull();
    expect(
      target(
        antigravity([window("3p-5h", 10)], {
          models: [{ slug: "gemini-3", name: "Gemini 3", isCustom: false, capabilities: null }],
        }),
      ),
    ).toBeNull();
    expect(target(antigravity([window("3p-5h", 10)], { enabled: false }))).toBeNull();
  });
});
