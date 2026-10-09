import {
  EnvironmentId,
  ProviderDriverKind,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeSwapSwitchOutcome,
  collectClaudeSwapSources,
  loginExpiryNotice,
  staleAge,
} from "./claudeSwap.logic";

const checkedAt = "2026-10-08T12:00:00.000Z";
const now = Date.parse(checkedAt);
const claude = ProviderDriverKind.make("claudeAgent");
const swapId = UsageLimitSourceId.make("claude-swap");
const laptopId = EnvironmentId.make("laptop");

function account(
  id: string,
  overrides: Partial<UsageLimitSourceAccount> = {},
): UsageLimitSourceAccount {
  return {
    id,
    driver: claude,
    email: `user${id}@example.com`,
    usageLimits: {
      checkedAt,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 10 }],
    },
    status: "ok",
    ...overrides,
  };
}

function presentations(
  accounts: readonly UsageLimitSourceAccount[],
  extra: { readonly error?: string } = {},
) {
  return new Map([
    [
      laptopId,
      {
        entry: { target: { label: "Laptop" } },
        serverConfig: {
          usageLimitSources: [
            {
              id: swapId,
              kind: "claudeSwap" as const,
              label: "claude-swap",
              checkedAt,
              accounts,
              ...extra,
            },
            {
              id: UsageLimitSourceId.make("hub"),
              kind: "cliproxy" as const,
              label: "hub",
              checkedAt,
              accounts: [],
              error: "ECONNREFUSED",
            },
          ],
        },
      },
    ],
  ]);
}

describe("collectClaudeSwapSources", () => {
  it("lists accounts in slot order and offers switches only to live, inactive logins", () => {
    const [view] = collectClaudeSwapSources(
      presentations([
        account("10"),
        account("2", { active: true }),
        account("3", { status: "relogin_required" }),
        account("4", { status: "api_key", alias: "work" }),
        account("5", { email: undefined }),
        account("1", { disabled: true, status: "token_expired" }),
      ]),
    );

    expect(view?.accounts.map((row) => [row.name, row.switchTo !== null])).toEqual([
      ["user1@example.com", true],
      ["user2@example.com", false],
      ["user3@example.com", false],
      ["work", true],
      ["Account 5", false],
      ["user10@example.com", true],
    ]);
    expect(view?.accounts[0]?.switchTo).toMatchObject({
      environmentId: laptopId,
      environmentLabel: "Laptop",
      input: { sourceId: swapId, accountId: "1", email: "user1@example.com" },
    });
    expect(view?.switchBest?.input).toEqual({ sourceId: swapId, strategy: "best" });
  });

  it("offers no best switch when nothing else can take over or the source failed", () => {
    expect(
      collectClaudeSwapSources(
        presentations([account("1", { active: true }), account("2", { status: "no_credentials" })]),
      )[0]?.switchBest,
    ).toBeNull();
    expect(
      collectClaudeSwapSources(presentations([account("1")], { error: "cswap was not found." }))[0]
        ?.switchBest,
    ).toBeNull();
  });
});

describe("claudeSwapSwitchOutcome", () => {
  const [view] = collectClaudeSwapSources(
    presentations([account("1", { alias: "personal" }), account("2", { active: true })]),
  );
  const accounts = view?.accounts ?? [];

  it("names the target by alias or slot, never by email", () => {
    const direct = accounts[0]?.switchTo;
    const best = view?.switchBest;
    if (!direct || !best) throw new Error("expected switch targets");
    expect(claudeSwapSwitchOutcome({ switched: true }, direct, accounts)).toBe(
      "Switched to personal.",
    );
    expect(
      claudeSwapSwitchOutcome({ switched: true, toEmail: "USER1@example.com" }, best, accounts),
    ).toBe("Switched to personal.");
    expect(
      claudeSwapSwitchOutcome({ switched: true, toEmail: "other@example.com" }, best, accounts),
    ).toBe("Switched accounts.");
    expect(
      claudeSwapSwitchOutcome({ switched: false, reason: "already-best" }, best, accounts),
    ).toBe("The active account already has the most headroom.");
  });
});

describe("account markers", () => {
  it("warns about a login that expires within a week", () => {
    expect(loginExpiryNotice(undefined, now)).toBeNull();
    expect(loginExpiryNotice("2026-10-20T12:00:00.000Z", now)).toBeNull();
    expect(loginExpiryNotice("2026-10-10T15:00:00.000Z", now)).toBe(
      "Login expires in 2d 3h. Sign in to it again with claude-swap.",
    );
    expect(loginExpiryNotice("2026-10-07T12:00:00.000Z", now)).toBe(
      "Login expired. Sign in to it again with claude-swap.",
    );
  });

  it("ages stale bars from the reading they came from", () => {
    expect(staleAge(account("1"), now)).toBeNull();
    expect(
      staleAge(
        account("1", {
          stale: true,
          usageLimits: { checkedAt: "2026-10-08T09:30:00.000Z", windows: [] },
        }),
        now,
      ),
    ).toBe("2h 30m old");
  });
});
