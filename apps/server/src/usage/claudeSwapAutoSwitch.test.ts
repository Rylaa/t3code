import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";

import {
  CLAUDE_SWAP_AUTO_BACKOFF_MS,
  claudeSwapActiveBindingPercent,
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
