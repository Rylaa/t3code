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
  CLAUDE_SWAP_AUTO_BACKOFF_MS,
  claudeSwapActiveBindingPercent,
  claudeSwapAllFull,
  decideClaudeSwapAutoTick,
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

  it("ignores a row claude-swap could not read", () => {
    const usageLimits = {
      checkedAt: "2026-10-08T12:00:00.000Z",
      windows: [],
      unavailable: { reason: "probeFailed" as const },
    };
    expect(binding([account({ usageLimits })])).toBeNull();
  });
});

describe("decideClaudeSwapAutoTick", () => {
  const base = {
    enabled: true,
    atPercent: 90,
    bindingPercent: 91 as number | null,
    nowMs,
    lastTickAtMs: null as number | null,
    backoffUntilMs: null as number | null,
  };

  it.each([
    ["off", "skip", { enabled: false }],
    ["an unknown reading", "skip", { bindingPercent: null }],
    ["below the near band", "skip", { bindingPercent: 84.9 }],
    ["in the near band", "tick", { bindingPercent: 85 }],
    ["at the threshold", "tick", { bindingPercent: 90 }],
    ["at the limit", "tick", { bindingPercent: 100 }],
    ["inside the back-off", "skip", { backoffUntilMs: nowMs + 1 }],
    [
      "after the back-off",
      "tick",
      { backoffUntilMs: nowMs, lastTickAtMs: nowMs - CLAUDE_SWAP_AUTO_BACKOFF_MS },
    ],
    ["within a minute of the last tick", "skip", { lastTickAtMs: nowMs - 59_999 }],
    ["a minute after the last tick", "tick", { lastTickAtMs: nowMs - 60_000 }],
  ] as const)("%s: %s", (_, expected, overrides) => {
    expect(decideClaudeSwapAutoTick({ ...base, ...overrides })).toBe(expected);
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
