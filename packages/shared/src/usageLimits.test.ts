import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type LimitAccount,
  antigravityClaudeFallback,
  antigravityClaudeHasRoom,
  claudeSwapAutoSwitchLine,
  claudeSwapSourceForProvider,
  collectProviderUsageLimits,
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  elapsedShare,
  isStaleLimitAccount,
  paceOf,
  paceRemainingPercent,
  usesChatGptSharing,
  withoutClaudeSwapSources,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("pace", () => {
  it("places the clock three fifths through a five-hour window with two hours left", () => {
    expect(elapsedShare(window, now)).toBeCloseTo(0.6);
    expect(paceRemainingPercent(window, now)).toBe(40);
    expect(paceOf(window, now)).toBe("under");
    expect(paceOf({ ...window, usedPercent: 62 }, now)).toBe("on");
    expect(paceOf({ ...window, usedPercent: 80 }, now)).toBe("ahead");
  });
});

describe("pools", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const weekly = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
    resetsAt: "2026-09-06T12:00:00.000Z",
  } as const;
  const claude = ProviderDriverKind.make("claudeAgent");
  const source = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt,
  };
  const laptop = { entry: { target: { label: "Laptop" } } };

  it("merges one account reported natively on two environments and by a hub into one entry", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "Same@example.com" },
      usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 40 }] },
    });
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [native] } }],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: {
            providers: [
              {
                ...native,
                usageLimits: {
                  checkedAt: "2026-09-03T11:30:00.000Z",
                  windows: [{ ...window, usedPercent: 55 }],
                },
              },
            ],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    plan: "Claude Subscription",
                    usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 10 }] },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      key: "env-a:claude",
      sourceLabel: null,
      redeem: { environmentId: "env-b", input: { instanceId: "claude" } },
      environments: [
        { environmentId: "env-a", label: "Laptop" },
        { environmentId: "env-b", label: "Desktop" },
      ],
    });
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(55);
  });

  it("merges OpenCode Go limits from machines with the same API key", () => {
    const go = provider({
      driver: ProviderDriverKind.make("opencode"),
      instanceId: ProviderInstanceId.make("opencode"),
      auth: { status: "authenticated" },
      usageLimits: {
        checkedAt,
        credentialFingerprint: "shared-go-key",
        windows: [{ ...window, id: "go_rolling", usedPercent: 3 }],
      },
    });
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [go] } }],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: {
            providers: [
              {
                ...go,
                usageLimits: {
                  ...go.usageLimits!,
                  checkedAt: "2026-09-03T11:30:00.000Z",
                  windows: [{ ...window, id: "go_rolling", usedPercent: 4 }],
                },
              },
            ],
          },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.environments).toEqual([
      { environmentId: "env-a", label: "Laptop" },
      { environmentId: "env-b", label: "Desktop" },
    ]);
    expect(collectLimitPools(accounts, now)[0]?.windows[0]?.members).toHaveLength(1);
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(4);

    const differentKey = {
      ...go,
      usageLimits: { ...go.usageLimits!, credentialFingerprint: "other-go-key" },
    };
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: { providers: [differentKey] },
    });
    expect(collectLimitAccounts(input)).toHaveLength(2);

    input.set(EnvironmentId.make("env-a"), {
      ...laptop,
      serverConfig: {
        providers: [{ ...go, auth: { status: "authenticated", email: "same@example.com" } }],
      },
    });
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: {
        providers: [
          { ...differentKey, auth: { status: "authenticated", email: "SAME@example.com" } },
        ],
      },
    });
    expect(collectLimitAccounts(input)).toHaveLength(1);
  });

  it("takes windows from a fresher hub read but credits and redeem from the native instance", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt,
        windows: [{ ...window, usedPercent: 40 }],
        resetCredits: { availableCount: 2 },
      },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [native],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    usageLimits: {
                      checkedAt: "2026-09-03T11:30:00.000Z",
                      windows: [{ ...window, usedPercent: 55 }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.windows[0]?.usedPercent).toBe(55);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({ environmentId: "env-a", input: { instanceId: "claude" } });
    expect(account?.environments).toEqual([{ environmentId: "env-a", label: "Laptop" }]);
  });

  it("redeems through the hub when it holds a credit, even with a fresher native read", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [{ ...window, usedPercent: 40 }],
        resetCredits: { availableCount: 3, nextCreditId: "native-credit" },
      },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [native],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...window, usedPercent: 55 }],
                      resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.redeem).toEqual({
      environmentId: "env-a",
      input: { sourceId: "hub", accountId: "claude-same@example.com.json", creditId: "hub-credit" },
    });
    expect(account?.limits.resetCredits?.availableCount).toBe(3);
  });

  it("redeems on the environment whose snapshot supplied the credits on show", () => {
    const stale = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt,
        windows: [window],
        resetCredits: { availableCount: 0 },
      },
    });
    const fresh = {
      ...stale,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 2 },
      },
    };
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [stale] } }],
      [
        EnvironmentId.make("env-b"),
        { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [fresh] } },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({ environmentId: "env-b", input: { instanceId: "codex" } });
  });

  it("keeps distinct hub accounts redeemable through their own source", () => {
    const hubAccounts = ["first", "second"].map((id) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      email: `${id}@example.com`,
      usageLimits: {
        checkedAt,
        windows: [window],
        resetCredits: { availableCount: 2, nextCreditId: `${id}-credit` },
      },
    }));
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [{ ...source, accounts: hubAccounts }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(input).map((account) => account.redeem)).toEqual(
      hubAccounts.map((account) => ({
        environmentId: "env-a",
        input: { sourceId: "hub", accountId: account.id, creditId: `${account.id}-credit` },
      })),
    );
  });

  it("does not give old credits the timestamp of a newer window-only read", () => {
    const snapshots = [
      { checkedAt, windows: [window], resetCredits: { availableCount: 2 } },
      { checkedAt: "2026-09-03T12:00:00.000Z", windows: [window] },
      {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 1 },
      },
    ];
    const input = new Map(
      snapshots.map((usageLimits, i) => [
        EnvironmentId.make(`env-${i}`),
        {
          ...laptop,
          serverConfig: {
            providers: [
              provider({
                auth: { status: "authenticated", email: "same@example.com" },
                usageLimits,
              }),
            ],
          },
        },
      ]),
    );
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.checkedAt).toBe("2026-09-03T12:00:00.000Z");
    expect(account?.limits.resetCredits?.availableCount).toBe(1);
    expect(account?.redeem?.environmentId).toBe("env-2");
  });

  it("keeps one email in two workspaces apart while merging each workspace's duplicates", () => {
    const login = (instanceId: string, workspaceId: string, usedPercent: number) =>
      provider({
        instanceId: ProviderInstanceId.make(instanceId),
        auth: { status: "authenticated", email: "same@example.com", workspaceId },
        usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent }] },
      });
    const hubAccount = (id: string, workspaceId?: string) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      email: "same@example.com",
      ...(workspaceId ? { workspaceId } : {}),
      usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 50 }] },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [login("business", "ws-business", 8), login("personal", "ws-plus", 26)],
            usageLimitSources: [
              { ...source, accounts: [hubAccount("plus.json", "ws-plus"), hubAccount("x.json")] },
            ],
          },
        },
      ],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: { providers: [login("personal", "ws-plus", 26)] },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts.map((account) => account.key)).toEqual([
      "env-a:business",
      "env-a:personal",
      "hub:x.json",
    ]);
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(8);
    const withoutEmail = (id: string, workspaceId: string) => {
      const { email: _email, ...account } = hubAccount(id, workspaceId);
      return account;
    };
    const sameFile = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [{ ...source, accounts: [withoutEmail("a.json", "ws-1")] }],
          },
        },
      ],
      [
        EnvironmentId.make("env-b"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [{ ...source, accounts: [withoutEmail("a.json", "ws-2")] }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(sameFile).map((account) => account.key)).toEqual([
      "hub:a.json:ws-1",
      "hub:a.json:ws-2",
    ]);
    expect(accounts[1]?.environments.map((environment) => environment.label)).toEqual([
      "Laptop",
      "Desktop",
    ]);
  });

  it("joins a report without a workspace to the only workspace signed in with its email", () => {
    const native = provider({
      driver: claude,
      auth: { status: "authenticated", email: "same@example.com", workspaceId: "org-a" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const hubAccount = {
      id: "claude.json",
      driver: claude,
      email: "same@example.com",
      usageLimits: { checkedAt, windows: [window] },
    };
    const withOther = (other: ServerProvider) =>
      new Map([
        [
          EnvironmentId.make("env-a"),
          {
            ...laptop,
            serverConfig: {
              providers: [native, other],
              usageLimitSources: [{ ...source, accounts: [hubAccount] }],
            },
          },
        ],
      ]);
    const unrelated = provider({ instanceId: ProviderInstanceId.make("codex-2") });
    expect(collectLimitAccounts(withOther(unrelated)).map((account) => account.key)).toEqual([
      "env-a:codex",
    ]);
    const unreadable = provider({
      ...native,
      instanceId: ProviderInstanceId.make("team"),
      auth: { ...native.auth, workspaceId: "org-b" },
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
    });
    expect(collectLimitAccounts(withOther(unreadable)).map((account) => account.key)).toEqual([
      "env-a:codex",
      "hub:claude.json",
    ]);
  });

  it("keys a hub account without an email by hub, so two environments on one hub share it", () => {
    const seat = {
      id: "claude-team-seat.json",
      driver: claude,
      usageLimits: { checkedAt, windows: [window] },
    };
    const hub = { ...source, accounts: [seat] };
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        { ...laptop, serverConfig: { providers: [], usageLimitSources: [hub] } },
      ],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: { providers: [], usageLimitSources: [hub] },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts.map((account) => account.key)).toEqual(["hub:claude-team-seat.json"]);
    expect(accounts[0]?.displayName).toBe("claude-team-seat");
  });

  it("pools Codex windows by kind, whichever slot reported them", () => {
    const codexAccount = (id: string, slots: readonly string[]) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      usageLimits: {
        checkedAt,
        windows: slots.map((slot) => ({ ...weekly, id: slot, usedPercent: 50 })),
      },
    });
    const pooled = (accounts: ReturnType<typeof codexAccount>[]) =>
      collectLimitPools(
        collectLimitAccounts(
          new Map([
            [
              EnvironmentId.make("env-a"),
              {
                ...laptop,
                serverConfig: { providers: [], usageLimitSources: [{ ...source, accounts }] },
              },
            ],
          ]),
        ),
        now,
      )[0]?.windows ?? [];
    for (const order of [
      [codexAccount("business", ["primary"]), codexAccount("plus", ["secondary"])],
      [codexAccount("plus", ["secondary"]), codexAccount("business", ["primary"])],
    ]) {
      const windows = pooled(order);
      expect(windows.map((window) => window.id)).toEqual(["weekly"]);
      expect(windows[0]?.members).toHaveLength(2);
    }
    expect(
      pooled([codexAccount("a", ["secondary"]), codexAccount("b", ["primary", "secondary"])]).map(
        (window) => window.id,
      ),
    ).toEqual(["weekly", "weekly:secondary"]);
  });

  it("pools windows by id across accounts and orders resets by when they land", () => {
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "a",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [
                        { ...window, usedPercent: 80, resetsAt: "2026-09-03T13:00:00.000Z" },
                        { ...weekly, usedPercent: 20 },
                      ],
                    },
                  },
                  {
                    id: "b",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...window, usedPercent: 40 }],
                    },
                  },
                  {
                    id: "c",
                    driver: ProviderDriverKind.make("codex"),
                    usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 50 }] },
                  },
                  {
                    id: "unsupported",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [],
                      unavailable: { reason: "unsupported" as const },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const pools = collectLimitPools(collectLimitAccounts(input), now);
    expect(pools.map((pool) => [pool.driver, pool.accounts.length])).toEqual([
      ["claudeAgent", 2],
      ["codex", 1],
    ]);
    const [session, week] = pools[0]!.windows;
    const untimed = collectLimitPools(
      collectLimitAccounts(input).map((account) =>
        account.key === "hub:b"
          ? {
              ...account,
              limits: {
                ...account.limits,
                windows: account.limits.windows.map((w) => ({ ...w, resetsAt: undefined })),
              },
            }
          : account,
      ),
      now,
    );
    expect(untimed[0]?.windows[0]?.pace).toBe("on");
    expect(session).toMatchObject({
      id: "five_hour",
      remainingPercent: 40,
      usedPercent: 60,
      pace: "under",
    });
    expect(
      session?.resets.map((reset) => [reset.member.account.key, reset.restoresPercent]),
    ).toEqual([
      ["hub:a", 40],
      ["hub:b", 20],
    ]);
    expect(week).toMatchObject({ id: "seven_day", remainingPercent: 80, members: [{}] });
    // Codex reports `primary` for both its five-hour and (on Go) monthly window.
    const mixed = collectLimitPools(
      [
        ...collectLimitAccounts(input),
        {
          key: "go",
          driver: claude,
          displayName: "Go",
          email: undefined,
          plan: undefined,
          accentColor: undefined,
          environments: [],
          sourceLabel: null,
          redeem: null,
          sourceKind: null,
          sourceAccount: null,
          active: false,
          switchTo: null,
          limits: {
            checkedAt,
            windows: [
              {
                id: "five_hour",
                kind: "monthly",
                label: "Monthly",
                usedPercent: 82,
                windowDurationMins: 30 * 24 * 60,
                resetsAt: "2026-09-14T12:00:00.000Z",
              },
            ],
          },
        },
      ],
      now,
    );
    expect(mixed[0]?.windows.map((window) => [window.kind, window.members.length])).toEqual([
      ["session", 2],
      ["weekly", 1],
      ["monthly", 1],
    ]);
    expect(session?.members.map((member) => member.account.key)).toEqual(["hub:a", "hub:b"]);
    expect(pools[0]?.accounts.map((account) => account.key)).toEqual(["hub:a", "hub:b"]);
  });
});

describe("pooled account columns", () => {
  const weekly = {
    ...window,
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
  } as const;
  const account = (key: string, windows: LimitAccount["limits"]["windows"]): LimitAccount => ({
    key,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: key,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: "Hub",
    redeem: null,
    sourceKind: null,
    sourceAccount: null,
    active: false,
    switchTo: null,
    limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
  });
  const keys = (pool: ReturnType<typeof collectLimitPools>[number]) =>
    pool.windows.map((row) =>
      row.columns.map((member) => (member.window ? member.account.key : null)),
    );

  // regression: #20349 sessions stay visible while the weekly quota is exhausted
  it.each([
    ["claudeAgent", "13:00", 40, "14:00", 100],
    ["codex", "14:00", 100, "14:00", 100],
    ["claudeAgent", "15:00", 100, "15:00", 100],
    ["codex", "15:00", 40, "14:00", 60],
  ] as const)(
    "%s session resetting at %s with %i percent spent becomes usable at %s with %i percent restored",
    (driver, sessionReset, usedPercent, usableAt, restoresPercent) => {
      const at = (time: string) => `2026-09-03T${time}:00.000Z`;
      const a = {
        ...account("a", [
          {
            ...window,
            id: driver === "codex" ? "primary" : window.id,
            usedPercent,
            resetsAt: at(sessionReset),
          },
          {
            ...weekly,
            id: driver === "codex" ? "secondary" : weekly.id,
            usedPercent: 100,
            resetsAt: at("14:00"),
          },
        ]),
        driver: ProviderDriverKind.make(driver),
      };
      const [session] = collectLimitPools([a], now)[0]!.windows;
      expect.soft(session?.remainingPercent).toBe(0);
      expect(session?.resets[0]).toMatchObject({
        at: Date.parse(at(usableAt)),
        restoresPercent,
      });
    },
  );

  it("excludes weekly-blocked sessions from the pool without changing snapshots or model allowances", () => {
    const blocked = account("blocked", [
      window,
      { ...weekly, usedPercent: 100 },
      { ...weekly, id: "seven_day_fable", usedPercent: 20 },
    ]);
    const accounts = [
      blocked,
      account("available", [
        { ...window, usedPercent: 20 },
        { ...weekly, usedPercent: 99 },
        { ...weekly, id: "seven_day_fable", usedPercent: 40 },
      ]),
      { ...blocked, key: "cursor", driver: ProviderDriverKind.make("cursor") },
    ];
    const snapshot = structuredClone(accounts);
    const [claude, cursor] = collectLimitPools(accounts, now);
    expect.soft(claude?.windows.map((row) => row.remainingPercent)).toEqual([40, 1, 70]);
    expect.soft(cursor?.windows.map((row) => row.remainingPercent)).toEqual([60, 0, 80]);
    expect(accounts).toEqual(snapshot);
  });

  it("keeps session columns across rows with opposite reset and usage orders", () => {
    const accounts = [
      account("a", [
        { ...weekly, usedPercent: 80, resetsAt: "2026-09-05T12:00:00.000Z" },
        { ...window, usedPercent: 10, resetsAt: "2026-09-03T15:00:00.000Z" },
      ]),
      account("b", [
        { ...weekly, usedPercent: 20, resetsAt: "2026-09-06T12:00:00.000Z" },
        { ...window, usedPercent: 90, resetsAt: "2026-09-03T13:00:00.000Z" },
      ]),
    ];
    const [pool] = collectLimitPools(accounts, now);
    expect(pool!.accounts.map((account) => account.key)).toEqual(["b", "a"]);
    expect(keys(pool!)).toEqual([
      ["b", "a"],
      ["b", "a"],
    ]);
    expect(pool!.windows[1]!.resets.map((reset) => reset.member.account.key)).toEqual(["a", "b"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(50);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual(keys(pool!));
  });

  it.each([undefined, "invalid", "2026-09-03T11:30:00.000Z"])(
    "keeps blocked sessions empty without predicting a refill from a missing or stale clock (%s)",
    (resetsAt) => {
      const [pool] = collectLimitPools(
        [
          account("session-clock", [
            { ...window, resetsAt },
            { ...weekly, usedPercent: 100 },
          ]),
          account("weekly-clock", [window, { ...weekly, usedPercent: 100, resetsAt }]),
        ],
        now,
      );
      expect(pool!.windows[0]).toMatchObject({ remainingPercent: 0, pace: null, resets: [] });
      expect(pool!.windows[0]!.columns.map((column) => column.window?.resetsAt)).toEqual([
        undefined,
        undefined,
      ]);
    },
  );

  it("orders by usable session refill and clears suppression after a fresh weekly reading", () => {
    const blocked = account("blocked", [
      { ...window, resetsAt: "2026-09-03T13:00:00.000Z" },
      { ...weekly, usedPercent: 100, resetsAt: "2026-09-03T15:00:00.000Z" },
    ]);
    const available = account("available", [window]);
    const [before] = collectLimitPools([blocked, available], now);
    expect(before!.accounts.map((account) => account.key)).toEqual(["available", "blocked"]);
    expect(before!.windows[0]!.remainingPercent).toBe(30);
    const refreshed = {
      ...blocked,
      limits: {
        checkedAt: "2026-09-03T12:00:00.000Z",
        windows: [blocked.limits.windows[0]!, { ...weekly, usedPercent: 10 }],
      },
    };
    const [after] = collectLimitPools([refreshed, available], now);
    expect(after!.accounts.map((account) => account.key)).toEqual(["blocked", "available"]);
    expect(after!.windows[0]!.remainingPercent).toBe(60);
    expect(after!.windows[0]!.resets[0]).toMatchObject({
      at: Date.parse("2026-09-03T13:00:00.000Z"),
      restoresPercent: 20,
    });
  });

  it("preserves gaps without counting missing windows toward pooled quota", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [window]),
        account("b", [
          { ...window, resetsAt: "2026-09-03T15:00:00.000Z" },
          { ...weekly, usedPercent: 80 },
        ]),
        account("c", [weekly]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([
      ["a", "b", null],
      [null, "b", "c"],
    ]);
    expect(pool!.windows[1]!.members.map((member) => member.account.key)).toEqual(["b", "c"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(40);
    expect(pool!.windows[1]!.resets.map((reset) => reset.restoresPercent)).toEqual([40, 20]);
  });

  it("falls back to weekly resets when no account reports a session", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [{ ...weekly, resetsAt: "2026-09-06T12:00:00.000Z" }]),
        account("b", [{ ...weekly, resetsAt: "2026-09-05T12:00:00.000Z" }]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([["b", "a"]]);
  });
});

describe("/usage-limits", () => {
  const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
  const selected = provider({
    usageLimits: limits,
    auth: { status: "authenticated", email: "same@example.com" },
  });
  const sources = [
    {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy" as const,
      label: "Accounts",
      checkedAt: limits.checkedAt,
      accounts: [
        {
          id: "duplicate",
          driver: selected.driver,
          email: "SAME@example.com",
          usageLimits: limits,
        },
        { id: "oss", driver: selected.driver, plan: "Codex OSS", usageLimits: limits },
        { id: "other-provider", driver: ProviderDriverKind.make("claude"), usageLimits: limits },
      ],
    },
  ];

  it("uses hub credit balances and redemption targets in the composer, including native duplicates", () => {
    const hubs = sources.map((source) => ({
      ...source,
      accounts: source.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          resetCredits: { availableCount: 2, nextCreditId: `${account.id}-credit` },
        },
      })),
    }));
    const report = collectProviderUsageLimits(selected.instanceId, [selected], hubs, now);
    expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(2);
    expect(report?.accounts[0]?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "duplicate",
      creditId: "duplicate-credit",
    });
    expect(report?.accounts.find((account) => account.id === "hub:oss")?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "oss",
      creditId: "oss-credit",
    });
  });

  it("gives a hub credit to no native row when its email is signed in to two workspaces", () => {
    const workspaces = ["ws-a", "ws-b"].map((workspaceId) =>
      provider({
        instanceId: ProviderInstanceId.make(workspaceId),
        usageLimits: limits,
        auth: { status: "authenticated", email: "same@example.com", workspaceId },
      }),
    );
    const hub = [
      {
        ...sources[0]!,
        accounts: [
          {
            id: "duplicate",
            driver: selected.driver,
            email: "same@example.com",
            usageLimits: { ...limits, resetCredits: { availableCount: 2, nextCreditId: "c" } },
          },
        ],
      },
    ];
    const report = collectProviderUsageLimits(workspaces[0]!.instanceId, workspaces, hub, now);
    expect(report?.accounts.map((account) => account.resetCreditInput)).toEqual([
      { instanceId: "ws-a" },
      { instanceId: "ws-b" },
      { sourceId: "hub", accountId: "duplicate", creditId: "c" },
    ]);
  });

  it("redeems a native duplicate through the hub even when the native snapshot is fresher", () => {
    const fresher = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 3, nextCreditId: "native-credit" },
      },
      auth: { status: "authenticated", email: "same@example.com" },
    });
    const stale = [
      {
        id: UsageLimitSourceId.make("hub"),
        kind: "cliproxy" as const,
        label: "Accounts",
        checkedAt: limits.checkedAt,
        accounts: [
          {
            id: "duplicate",
            driver: fresher.driver,
            email: "SAME@example.com",
            usageLimits: {
              ...limits,
              resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
            },
          },
        ],
      },
    ];
    const report = collectProviderUsageLimits(fresher.instanceId, [fresher], stale, now);
    expect(report?.accounts[0]?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "duplicate",
      creditId: "hub-credit",
    });
    expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(3);
  });

  it("keeps unidentified custom instances separate, filtering by driver", () => {
    const report = collectProviderUsageLimits(
      selected.instanceId,
      [
        selected,
        provider({
          instanceId: ProviderInstanceId.make("codex-work"),
          displayName: "Work",
          usageLimits: { ...limits, resetCredits: { availableCount: 2 } },
        }),
        provider({
          driver: ProviderDriverKind.make("claude"),
          instanceId: ProviderInstanceId.make("claude"),
          usageLimits: limits,
        }),
      ],
      sources,
      now,
    );
    expect(report?.createdAt).toBe("2026-09-03T12:00:00.000Z");
    expect(report?.accounts.map((account) => account.id)).toEqual([
      "codex",
      "codex-work",
      "hub:oss",
    ]);
    expect(report?.accounts[0]).toMatchObject({
      instanceId: selected.instanceId,
      email: selected.auth.email,
    });
    expect(report?.accounts[1]).toMatchObject({
      displayName: "Work",
      limits: { resetCredits: { availableCount: 2 } },
    });
    expect(report?.accounts[2]).toMatchObject({
      label: "Accounts · oss",
      sourceLabel: "Accounts",
      plan: "Codex OSS",
    });
    expect(report?.notices).toEqual([]);
  });

  it("keeps the freshest usable native duplicate and the freshest native credits in either order", () => {
    const failed = provider({
      auth: selected.auth,
      usageLimits: {
        ...limits,
        checkedAt: "2026-09-03T11:40:00.000Z",
        unavailable: { reason: "probeFailed" },
      },
    });
    const credited = provider({
      instanceId: ProviderInstanceId.make("codex-credit"),
      auth: selected.auth,
      usageLimits: {
        checkedAt: "2026-09-03T11:20:00.000Z",
        windows: [{ ...window, usedPercent: 50 }],
        resetCredits: { availableCount: 2 },
      },
    });
    const staleCredit = provider({
      ...credited,
      instanceId: ProviderInstanceId.make("codex-stale-credit"),
      usageLimits: { ...limits, resetCredits: { availableCount: 3 } },
    });
    const freshest = provider({
      instanceId: ProviderInstanceId.make("codex-fresh"),
      auth: selected.auth,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [{ ...window, usedPercent: 55 }],
      },
    });
    const duplicates = [failed, staleCredit, credited, freshest];
    for (const providers of [duplicates, duplicates.toReversed()]) {
      const report = collectProviderUsageLimits(failed.instanceId, providers, sources, now);
      expect(report?.accounts.map((account) => account.id)).toEqual(["codex-fresh", "hub:oss"]);
      expect(report?.accounts[0]).toMatchObject({
        limits: {
          checkedAt: "2026-09-03T11:30:00.000Z",
          windows: [{ usedPercent: 55 }],
          resetCredits: { availableCount: 2 },
        },
        resetCreditInput: { instanceId: "codex-credit" },
      });
      expect(report?.accounts[0]?.limits.unavailable).toBeUndefined();
    }
  });

  it("merges native workspace duplicates only while the workspace evidence is unambiguous", () => {
    const known = provider({
      ...selected,
      instanceId: ProviderInstanceId.make("workspace-a"),
      auth: { ...selected.auth, workspaceId: "ws-a" },
    });
    const fresh = provider({
      ...known,
      instanceId: ProviderInstanceId.make("workspace-a-fresh"),
      usageLimits: { ...limits, checkedAt: "2026-09-03T11:30:00.000Z" },
    });
    const natives = [known, fresh, selected];
    expect(
      collectProviderUsageLimits(selected.instanceId, natives, [], now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["workspace-a-fresh"]);

    const unreadable = provider({
      instanceId: ProviderInstanceId.make("workspace-b"),
      auth: { ...selected.auth, workspaceId: "ws-b" },
    });
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [...natives, unreadable],
        [],
        now,
      )?.accounts.map((account) => account.id),
    ).toEqual(["workspace-a-fresh", "codex"]);
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [...natives, { ...unreadable, usageLimits: limits }],
        [],
        now,
      )?.accounts.map((account) => account.id),
    ).toEqual(["workspace-a-fresh", "codex", "workspace-b"]);
  });

  it("supports a source-only provider and keeps duplicates when the native probe failed", () => {
    expect(
      collectProviderUsageLimits(selected.instanceId, [provider({})], sources, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["hub:duplicate", "hub:oss"]);
    const failed = provider({ usageLimits: { ...limits, unavailable: { reason: "probeFailed" } } });
    expect(
      collectProviderUsageLimits(selected.instanceId, [failed], sources, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["codex", "hub:duplicate", "hub:oss"]);
    expect(collectProviderUsageLimits(selected.instanceId, [provider({})], [], now)).toBeNull();
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [provider({ enabled: false, usageLimits: limits })],
        [],
        now,
      ),
    ).toBeNull();
  });

  it("surfaces source errors only for sources that carry the selected driver", () => {
    const failing = { ...sources[0]!, error: "token expired" };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [failing], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    const claudeOnly = { ...failing, accounts: failing.accounts.slice(2) };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [claudeOnly], now)?.notices,
    ).toEqual([]);
    const unreadable = { ...failing, accounts: [] };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [unreadable], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    const sourceOnly = collectProviderUsageLimits(
      selected.instanceId,
      [provider({})],
      [unreadable],
      now,
    );
    expect(sourceOnly?.accounts).toEqual([]);
    expect(sourceOnly?.notices).toEqual(["Accounts: token expired"]);
  });

  it("advertises global and workspace commands only for providers present in Limits", () => {
    const withWorkspace = provider({
      workspaceSnapshots: [
        { cwd: "/tmp/project", checkedAt: limits.checkedAt, slashCommands: [], skills: [] },
      ],
    });
    const [supported] = withUsageLimitsCommands([withWorkspace], sources);
    expect(supported?.slashCommands.map((command) => command.name)).toEqual(["usage-limits"]);
    expect(
      supported?.workspaceSnapshots?.[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
    expect(withUsageLimitsCommands([withWorkspace], [])[0]?.slashCommands).toEqual([]);
    const ownCommand = provider({
      slashCommands: [{ name: "usage-limits", description: "Provider's own" }],
    });
    expect(withUsageLimitsCommands([ownCommand], [])[0]?.slashCommands).toEqual([
      { name: "usage-limits", description: "Provider's own" },
    ]);
    const unreadable = { ...sources[0]!, accounts: [], error: "token expired" };
    expect(
      withUsageLimitsCommands([withWorkspace], [unreadable])[0]?.slashCommands.map(
        (command) => command.name,
      ),
    ).toEqual(["usage-limits"]);
    expect(
      withUsageLimitsCommands([selected], [])[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
  });

  it("scopes a failed claude-swap read to Claude, while a failed hub still covers every driver", () => {
    const claude = provider({
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claude"),
    });
    const antigravity = provider({
      driver: ProviderDriverKind.make("antigravity"),
      instanceId: ProviderInstanceId.make("antigravity"),
    });
    const codex = provider({});
    const swapDown = {
      id: UsageLimitSourceId.make("claude-swap"),
      kind: "claudeSwap" as const,
      label: "claude-swap",
      checkedAt: limits.checkedAt,
      accounts: [],
      error: "cswap was not found.",
    };
    const hubDown = { ...sources[0]!, accounts: [], error: "ECONNREFUSED" };
    const commandsFor = (unreadable: typeof swapDown | typeof hubDown) =>
      withUsageLimitsCommands([claude, antigravity, codex], [unreadable]).map((entry) =>
        entry.slashCommands.map((command) => command.name),
      );
    const noticesFor = (
      selectedProvider: ServerProvider,
      unreadable: typeof swapDown | typeof hubDown,
    ) =>
      collectProviderUsageLimits(selectedProvider.instanceId, [selectedProvider], [unreadable], now)
        ?.notices;

    expect(commandsFor(swapDown)).toEqual([["usage-limits"], [], []]);
    expect(noticesFor(claude, swapDown)).toEqual(["claude-swap: cswap was not found."]);
    expect(noticesFor(antigravity, swapDown)).toBeUndefined();
    expect(noticesFor(codex, swapDown)).toBeUndefined();

    expect(commandsFor(hubDown)).toEqual([["usage-limits"], ["usage-limits"], ["usage-limits"]]);
    expect(noticesFor(antigravity, hubDown)).toEqual(["Accounts: ECONNREFUSED"]);
  });
});

describe("sameUsageLimitCommandCoverage", () => {
  const codexAccount = {
    id: "a",
    driver: ProviderDriverKind.make("codex"),
    usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [] },
  };
  const base = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "Accounts",
    checkedAt: "2026-09-03T11:00:00.000Z",
  };
  it("ignores quota movement but not the drivers offered the command", () => {
    const withCodex = [{ ...base, accounts: [codexAccount] }];
    const withCodexLater = [
      {
        ...base,
        accounts: [
          {
            ...codexAccount,
            usageLimits: { ...codexAccount.usageLimits, checkedAt: "2026-09-03T12:00:00.000Z" },
          },
        ],
      },
    ];
    expect(sameUsageLimitCommandCoverage(withCodex, withCodexLater)).toBe(true);
    expect(sameUsageLimitCommandCoverage(withCodex, [{ ...base, accounts: [] }])).toBe(false);
  });
  it("treats a failed read as a change in coverage, in both directions", () => {
    const empty = [{ ...base, accounts: [] }];
    const failed = [{ ...base, accounts: [], error: "token expired" }];
    expect(sameUsageLimitCommandCoverage(empty, failed)).toBe(false);
    expect(sameUsageLimitCommandCoverage(failed, empty)).toBe(false);
    expect(
      sameUsageLimitCommandCoverage(failed, [{ ...base, accounts: [], error: "still down" }]),
    ).toBe(true);
  });
  it("counts a failed claude-swap read as Claude coverage only", () => {
    const swapDown = [{ ...base, kind: "claudeSwap" as const, accounts: [], error: "down" }];
    const withClaude = [
      { ...base, accounts: [{ ...codexAccount, driver: ProviderDriverKind.make("claudeAgent") }] },
    ];
    expect(sameUsageLimitCommandCoverage(swapDown, withClaude)).toBe(true);
    expect(sameUsageLimitCommandCoverage(swapDown, [{ ...base, accounts: [codexAccount] }])).toBe(
      false,
    );
  });
});

describe("external usage settings", () => {
  it("deduplicates destinations across accounts and environments without inventing quota pools", () => {
    const managed = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
        externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("a"),
        {
          entry: { target: { label: "A" } },
          serverConfig: {
            providers: [managed, { ...managed, instanceId: ProviderInstanceId.make("personal") }],
          },
        },
      ],
      [
        EnvironmentId.make("b"),
        { entry: { target: { label: "B" } }, serverConfig: { providers: [managed] } },
      ],
    ]);
    expect(collectExternalUsageLinks(presentations)).toEqual([
      {
        ...managed.usageLimits!.externalUsage,
        message: "Track usage in ChatGPT.",
        accounts: [`${managed.instanceId} on A`, "personal on A", `${managed.instanceId} on B`],
      },
    ]);
    expect(collectLimitAccounts(presentations)).toEqual([]);
    expect(collectLimitNotices(presentations)).toEqual([]);
  });
});

describe("ChatGPT sharing presentation", () => {
  it("requires verified sharing metadata rather than the Codex driver or login type", () => {
    const codex = provider({ auth: { status: "authenticated", type: "chatgpt" } });
    expect(usesChatGptSharing(codex)).toBe(false);
    expect(
      usesChatGptSharing({ ...codex, auth: { ...codex.auth, subscriptionSharing: true } }),
    ).toBe(true);
    expect(
      usesChatGptSharing({
        ...codex,
        auth: { status: "unauthenticated", subscriptionSharing: true },
      }),
    ).toBe(false);
  });
});

describe("claude-swap accounts", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const claude = ProviderDriverKind.make("claudeAgent");
  const environmentId = EnvironmentId.make("env-a");
  const swapAccount = (
    id: string,
    email: string,
    extra: Partial<UsageLimitSourceAccount> = {},
  ): UsageLimitSourceAccount => ({
    id,
    driver: claude,
    email,
    usageLimits: { checkedAt, windows: [window] },
    status: "ok",
    ...extra,
  });
  const presentations = (accounts: UsageLimitSourceAccount[], providers: ServerProvider[] = []) =>
    new Map([
      [
        environmentId,
        {
          entry: { target: { label: "Laptop" } },
          serverConfig: {
            providers,
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("claude-swap"),
                kind: "claudeSwap" as const,
                label: "claude-swap",
                checkedAt,
                accounts,
              },
            ],
          },
        },
      ],
    ]);

  it("offers the limit switch only to the Claude login claude-swap manages", () => {
    const source = (accounts: UsageLimitSourceAccount[]): UsageLimitSourceSnapshot => ({
      id: UsageLimitSourceId.make("claude-swap"),
      kind: "claudeSwap",
      label: "claude-swap",
      checkedAt,
      accounts,
    });
    const managed = source([
      swapAccount("1", "Active@example.com", { active: true }),
      swapAccount("2", "spare@example.com"),
    ]);
    const login = (email: string) =>
      provider({ driver: claude, auth: { status: "authenticated", email } });

    expect(claudeSwapSourceForProvider([managed], login("active@example.com"))).toBe(managed);
    // A custom Claude home signs in as another account; switching would not reach it.
    expect(claudeSwapSourceForProvider([managed], login("other@example.com"))).toBeNull();
    expect(
      claudeSwapSourceForProvider(
        [managed],
        provider({ auth: { status: "authenticated", email: "active@example.com" } }),
      ),
    ).toBeNull();
    expect(
      claudeSwapSourceForProvider(
        [
          source([
            swapAccount("1", "active@example.com", { active: true }),
            swapAccount("2", "dead@example.com", { status: "relogin_required" }),
          ]),
        ],
        login("active@example.com"),
      ),
    ).toBeNull();
  });

  it("offers a switch only for inactive accounts that can serve turns", () => {
    const accounts = collectLimitAccounts(
      presentations([
        swapAccount("1", "active@example.com", { active: true }),
        swapAccount("2", "spare@example.com", { alias: "work", stale: true }),
        swapAccount("3", "expired@example.com", { status: "token_expired" }),
      ]),
    );
    const byEmail = new Map(accounts.map((account) => [account.email, account]));
    expect(byEmail.get("active@example.com")).toMatchObject({
      sourceKind: "claudeSwap",
      active: true,
      switchTo: null,
    });
    expect(byEmail.get("spare@example.com")).toMatchObject({
      active: false,
      displayName: "work",
      sourceAccount: { stale: true },
      switchTo: {
        environmentId,
        input: { sourceId: "claude-swap", accountId: "2", email: "spare@example.com" },
      },
    });
    // cswap or Claude Code refreshes an expired token itself.
    expect(byEmail.get("expired@example.com")?.switchTo).not.toBeNull();
  });

  it("names a dead login in the notices instead of offering it", () => {
    const dead = swapAccount("4", "dead@example.com", {
      status: "relogin_required",
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Sign in again." },
      },
    });
    const input = presentations([dead]);
    expect(collectLimitAccounts(input)).toEqual([]);
    expect(collectLimitNotices(input)).toEqual(["claude-swap · account 4: Sign in again."]);
  });

  it("keeps the active flag when the account merges with the native Claude row", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      displayName: "Claude",
      auth: { status: "authenticated", email: "Active@example.com" },
      usageLimits: { checkedAt: "2026-09-03T11:30:00.000Z", windows: [window] },
    });
    const accounts = collectLimitAccounts(
      presentations([swapAccount("1", "active@example.com", { active: true })], [native]),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      displayName: "Claude",
      sourceKind: "claudeSwap",
      active: true,
      switchTo: null,
      environments: [{ environmentId, label: "Laptop" }],
    });
  });

  const hubSnapshot = (accounts: UsageLimitSourceAccount[]) => ({
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt,
    accounts,
  });
  const withSources = (sources: ReadonlyArray<UsageLimitSourceSnapshot>) =>
    new Map([
      [
        environmentId,
        {
          entry: { target: { label: "Laptop" } },
          serverConfig: { providers: [], usageLimitSources: sources },
        },
      ],
    ]);
  const swapSnapshot = (accounts: UsageLimitSourceAccount[]): UsageLimitSourceSnapshot => ({
    id: UsageLimitSourceId.make("claude-swap"),
    kind: "claudeSwap",
    label: "claude-swap",
    checkedAt,
    accounts,
  });

  it("takes the source details from claude-swap whichever report merged first", () => {
    // The hub's reading is fresher, so its windows win, but not its source details.
    const hub = hubSnapshot([
      {
        id: "spare.json",
        driver: claude,
        email: "Spare@example.com",
        usageLimits: { checkedAt: "2026-09-03T11:30:00.000Z", windows: [window] },
      },
    ]);
    const swap = swapSnapshot([swapAccount("2", "spare@example.com", { alias: "work" })]);
    for (const sources of [
      [hub, swap],
      [swap, hub],
    ]) {
      const accounts = collectLimitAccounts(withSources(sources));
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        sourceKind: "claudeSwap",
        sourceAccount: { id: "2", alias: "work" },
        switchTo: { input: { sourceId: "claude-swap", accountId: "2" } },
        limits: { checkedAt: "2026-09-03T11:30:00.000Z" },
      });
    }
  });

  it("leaves a stale reading's elapsed windows out of the pools and flags it stale", () => {
    const elapsed = { ...window, resetsAt: "2026-09-03T10:00:00.000Z", usedPercent: 95 };
    const weekly = {
      ...window,
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 50,
      resetsAt: "2026-09-08T00:00:00.000Z",
    } as const;
    const stale = swapAccount("2", "stale@example.com", {
      stale: true,
      usageLimits: { checkedAt: "2026-09-01T11:00:00.000Z", windows: [elapsed, weekly] },
    });
    const fresh = swapAccount("1", "fresh@example.com", {
      active: true,
      usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 20 }] },
    });
    const accounts = collectLimitAccounts(presentations([fresh, stale]));
    const staleAccount = accounts.find((account) => account.email === "stale@example.com");
    expect(staleAccount && isStaleLimitAccount(staleAccount)).toBe(true);
    const [pool] = collectLimitPools(accounts, now);
    const session = pool?.windows.find((entry) => entry.id === "five_hour");
    // The elapsed 95% is unknown now, not still used.
    expect(session?.members.map((member) => member.account.email)).toEqual(["fresh@example.com"]);
    expect(session?.usedPercent).toBe(20);
    // A window that has not reset yet still counts.
    expect(
      pool?.windows
        .find((entry) => entry.id === "seven_day")
        ?.members.map((member) => member.account.email),
    ).toEqual(["stale@example.com"]);
  });

  it("reports neither a stale reading's elapsed windows nor dead logins to /usage-limits", () => {
    const elapsed = { ...window, resetsAt: "2026-09-03T10:00:00.000Z", usedPercent: 95 };
    const weekly = {
      ...window,
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      resetsAt: "2026-09-08T00:00:00.000Z",
    } as const;
    const staleLimits = { checkedAt: "2026-09-01T11:00:00.000Z", windows: [elapsed, weekly] };
    const selected = provider({ driver: claude, instanceId: ProviderInstanceId.make("claude") });
    const report = collectProviderUsageLimits(
      selected.instanceId,
      [selected],
      [
        swapSnapshot([
          swapAccount("1", "stale@example.com", { stale: true, usageLimits: staleLimits }),
          // A current reading keeps its windows: only cswap can say they reset.
          swapAccount("2", "fresh@example.com", { usageLimits: staleLimits }),
          swapAccount("3", "dead@example.com", {
            status: "relogin_required",
            usageLimits: {
              checkedAt,
              windows: [],
              unavailable: { reason: "probeFailed", message: "Sign in again." },
            },
          }),
        ]),
      ],
      now,
    );
    expect(
      report?.accounts.map((account) => [
        account.id,
        account.limits.windows.map((entry) => entry.id),
      ]),
    ).toEqual([
      ["claude-swap:1", ["seven_day"]],
      ["claude-swap:2", ["five_hour", "seven_day"]],
    ]);
    expect(report?.notices).toEqual(["claude-swap · account 3: Sign in again."]);
  });

  it("is not stale when a fresher report supplies the bars", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "active@example.com" },
      usageLimits: { checkedAt: "2026-09-03T11:30:00.000Z", windows: [window] },
    });
    const [account] = collectLimitAccounts(
      presentations(
        [swapAccount("1", "active@example.com", { active: true, stale: true })],
        [native],
      ),
    );
    expect(account?.sourceAccount?.stale).toBe(true);
    expect(account && isStaleLimitAccount(account)).toBe(false);
  });

  it("drops claude-swap sources from the notices and keeps the others", () => {
    const input = withSources([
      { ...swapSnapshot([]), error: "cswap was not found." },
      { ...hubSnapshot([]), error: "ECONNREFUSED" },
    ]);
    expect(collectLimitNotices(input)).toEqual([
      "claude-swap: cswap was not found.",
      "hub: ECONNREFUSED",
    ]);
    expect(collectLimitNotices(withoutClaudeSwapSources(input))).toEqual(["hub: ECONNREFUSED"]);
  });

  it("words the last automatic switch by alias or slot, never by email", () => {
    const at = "2026-09-03T11:50:00.000Z";
    const line = (autoSwitch: UsageLimitSourceSnapshot["autoSwitch"]) =>
      claudeSwapAutoSwitchLine({
        ...swapSnapshot([
          swapAccount("1", "work@example.com", { alias: "work" }),
          swapAccount("2", "spare@example.com", { active: true }),
        ]),
        ...(autoSwitch ? { autoSwitch } : {}),
      });

    expect(line(undefined)).toBeNull();
    const switched = line({
      at,
      outcome: "switched",
      fromAccountId: "1",
      toAccountId: "2",
      usedPercent: 91.4,
      window: "session",
    });
    expect(switched).toBe(
      "Switched automatically from work to account #2 at 91% of the 5-hour limit.",
    );
    expect(switched).not.toContain("example.com");
    // A slot that left claude-swap since the switch still has a name.
    expect(
      line({
        at,
        outcome: "switched",
        fromAccountId: "2",
        toAccountId: "7",
        usedPercent: 96,
        window: "weekly",
      }),
    ).toBe("Switched automatically from account #2 to account #7 at 96% of the weekly limit.");
    expect(line({ at, outcome: "switched", toAccountId: "1" })).toBe(
      "Switched automatically to work.",
    );
    expect(line({ at, outcome: "blocked" })).toBe("No account had room for an automatic switch.");
    expect(line({ at, outcome: "failed", detail: "claude-swap did not answer in time." })).toBe(
      "Automatic switch failed: claude-swap did not answer in time.",
    );
  });
});

describe("antigravityClaudeFallback", () => {
  const model = (slug: string, name: string) => ({
    slug,
    name,
    isCustom: false,
    capabilities: null,
  });
  const antigravity = (overrides: Partial<ServerProvider> = {}) =>
    provider({
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      models: [model("gemini-3", "Gemini 3"), model("claude-sonnet", "Claude Sonnet 4.6")],
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [
          { ...window, id: "3p-5h", usedPercent: 40 },
          { ...window, id: "3p-weekly", kind: "weekly", usedPercent: 50 },
          { ...window, id: "gemini-5h", usedPercent: 99 },
        ],
      },
      ...overrides,
    });
  const ids = (fallback: ReturnType<typeof antigravityClaudeFallback>) =>
    fallback?.windows.map((candidate) => candidate.id);

  it("reads the shared Claude & GPT windows and ignores Gemini", () => {
    const fallback = antigravityClaudeFallback([provider({}), antigravity()], now);
    expect(fallback?.provider.instanceId).toBe("antigravity");
    expect(ids(fallback)).toEqual(["3p-5h", "3p-weekly"]);
    expect(fallback?.model?.slug).toBe("claude-sonnet");
    expect(antigravityClaudeHasRoom(fallback!, 90)).toBe(true);
  });

  it("reads older accounts' Claude-only windows", () => {
    const fallback = antigravityClaudeFallback(
      [
        antigravity({
          usageLimits: {
            checkedAt: "2026-09-03T11:00:00.000Z",
            windows: [
              { ...window, id: "claude-weekly", kind: "weekly", usedPercent: 20 },
              { ...window, id: "claude-quota", kind: "other", usedPercent: 95 },
              { ...window, id: "gpt-quota", kind: "other", usedPercent: 10 },
            ],
          },
        }),
      ],
      now,
    );
    expect(ids(fallback)).toEqual(["claude-weekly", "claude-quota"]);
    expect(antigravityClaudeHasRoom(fallback!, 90)).toBe(false);
  });

  it("prefers Opus over any other Claude model, by name", () => {
    const fallback = antigravityClaudeFallback(
      [
        antigravity({
          models: [
            model("claude-sonnet", "Claude Sonnet 4.6"),
            model("m-28", "Claude Opus 4.6 (Thinking)"),
          ],
        }),
      ],
      now,
    );
    expect(fallback?.model?.slug).toBe("m-28");
    expect(
      antigravityClaudeFallback([antigravity({ models: [model("gemini-3", "Gemini 3")] })], now)
        ?.model,
    ).toBeNull();
  });

  it("takes the strongest effort of the Opus variants Antigravity lists", () => {
    const fallback = antigravityClaudeFallback(
      [
        antigravity({
          models: [
            model("claude-opus-5-5-low", "Claude Opus 5.5 (Low)"),
            model("claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"),
            model("claude-opus-5-5-high", "Claude Opus 5.5 (High)"),
            model("claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"),
          ],
        }),
      ],
      now,
    );
    expect(fallback?.model?.slug).toBe("claude-opus-5-5-high");
  });

  it("takes medium effort over low when Antigravity lists no high variant", () => {
    const fallback = antigravityClaudeFallback(
      [
        antigravity({
          models: [
            model("claude-opus-5-5-low", "Claude Opus 5.5 (Low)"),
            model("claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"),
          ],
        }),
      ],
      now,
    );
    expect(fallback?.model?.slug).toBe("claude-opus-5-5-medium");
  });

  it("has no room at the threshold, after a reset, or without a reading", () => {
    const at = (usedPercent: number, atPercent: number) =>
      antigravityClaudeHasRoom(
        antigravityClaudeFallback(
          [
            antigravity({
              usageLimits: {
                checkedAt: "2026-09-03T11:00:00.000Z",
                windows: [{ ...window, id: "3p-5h", usedPercent }],
              },
            }),
          ],
          now,
        )!,
        atPercent,
      );
    expect(at(89, 90)).toBe(true);
    expect(at(90, 90)).toBe(false);
    expect(at(70, 70)).toBe(false);
    const reset = antigravityClaudeFallback(
      [
        antigravity({
          usageLimits: {
            checkedAt: "2026-09-03T11:00:00.000Z",
            windows: [{ ...window, id: "3p-5h", resetsAt: "2026-09-03T11:00:00.000Z" }],
          },
        }),
      ],
      now,
    )!;
    expect(reset.windows).toEqual([]);
    expect(antigravityClaudeHasRoom(reset, 90)).toBe(false);
    const unavailable = antigravityClaudeFallback(
      [
        antigravity({
          usageLimits: {
            checkedAt: "2026-09-03T11:00:00.000Z",
            windows: [{ ...window, id: "3p-5h", usedPercent: 1 }],
            unavailable: { reason: "probeFailed" },
          },
        }),
      ],
      now,
    )!;
    expect(antigravityClaudeHasRoom(unavailable, 90)).toBe(false);
  });

  it("is null without an enabled Antigravity instance", () => {
    expect(antigravityClaudeFallback([provider({})], now)).toBeNull();
    expect(antigravityClaudeFallback([antigravity({ enabled: false })], now)).toBeNull();
    expect(
      antigravityClaudeFallback([antigravity({ availability: "unavailable" })], now),
    ).toBeNull();
  });
});
