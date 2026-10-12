import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadExtensions,
  type OrchestrationV2ThreadExtensionUse,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRunSummary } from "./models.ts";
import {
  filterThreadExtensionSections,
  mcpServerGroups,
  mcpServerMetaLabel,
  mcpServerRows,
  mcpServerSourceLabel,
  mcpServerStatusFreshness,
  mcpServerStatusLabel,
  mcpServerStatusTone,
  pluginRowView,
  sectionWithMatches,
  skillStartText,
  skillStateBadges,
  THREAD_EXTENSION_SECTION_ORDER,
  THREAD_EXTENSION_SECTION_TITLES,
  threadExtensionDisplayName,
  threadExtensionGroups,
  threadExtensionSectionCountLabel,
  threadExtensionSectionExpandedByDefault,
  threadExtensionSections,
  threadExtensionsCommandSection,
  threadExtensionsEmptyState,
  threadExtensionsFootnotes,
  threadExtensionsInventoryNote,
  threadExtensionsMatchStatus,
  threadExtensionsNoMatchState,
  threadExtensionsProvider,
  threadExtensionsRevision,
  threadExtensionsSummary,
  threadExtensionUsesLabel,
  withoutThreadExtensionsCommands,
  type McpServerRowView,
  type ThreadExtensionSections,
  type ThreadExtensionsProvider,
} from "./threadExtensions.ts";

const threadId = ThreadId.make("thread:1");

function use(
  kind: OrchestrationV2ThreadExtensionUse["kind"],
  name: string,
  second: number,
  overrides: Partial<OrchestrationV2ThreadExtensionUse> = {},
): OrchestrationV2ThreadExtensionUse {
  return {
    kind,
    name,
    plugin: name.includes(":") ? (name.split(":")[0] ?? null) : null,
    count: 1,
    lastUsedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 8, 12, 0, second)),
    lastItem: { threadId, itemId: TurnItemId.make(`item:${name}`) },
    ...overrides,
  };
}

describe("threadExtensionSections", () => {
  it("lists used entries by recent use above loaded ones that went unused", () => {
    const extensions: OrchestrationV2ThreadExtensions = {
      used: [
        use("skill", "review", 1, { count: 3 }),
        use("skill", "caveman:caveman-review", 9),
        use("mcp", "context7", 5, { tools: [{ name: "query-docs", count: 2 }], count: 2 }),
        use("agent", "caveman:cavecrew-builder", 7),
      ],
      inventoryStatus: "available",
      inventory: {
        skills: ["review", "caveman:caveman-review", "simplify", "caveman:compress"],
        plugins: [{ name: "caveman", version: "1.2.0" }, { name: "remotion" }],
        mcpServers: [
          { name: "context7", status: "connected" },
          { name: "plugin:remotion:docs", status: "failed", source: "plugin" },
        ],
        agents: ["Explore", "caveman:cavecrew-builder"],
      },
    };

    const sections = threadExtensionSections(extensions);

    expect(sections.inventoryStatus).toBe("available");
    expect(sections.isEmpty).toBe(false);
    expect(sections.skills.used.map((row) => [row.name, row.count])).toEqual([
      ["caveman:caveman-review", 1],
      ["review", 3],
    ]);
    expect(sections.skills.unused.map((row) => [row.name, row.plugin])).toEqual([
      ["caveman:compress", "caveman"],
      ["simplify", null],
    ]);
    // A plugin's use sums what it ships and points at the latest of them.
    expect(sections.plugins.used).toEqual([
      {
        name: "caveman",
        plugin: null,
        count: 2,
        lastUsedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 8, 12, 0, 9)),
        lastItem: { threadId, itemId: TurnItemId.make("item:caveman:caveman-review") },
        version: "1.2.0",
      },
    ]);
    expect(sections.plugins.unused.map((row) => row.name)).toEqual(["remotion"]);
    expect(sections.mcpServers.used.map((row) => [row.name, row.status, row.tools])).toEqual([
      ["context7", "connected", [{ name: "query-docs", count: 2 }]],
    ]);
    expect(sections.mcpServers.unused.map((row) => [row.name, row.status, row.plugin])).toEqual([
      ["plugin:remotion:docs", "failed", "remotion"],
    ]);
    expect(sections.agents.used.map((row) => row.name)).toEqual(["caveman:cavecrew-builder"]);
    expect(sections.agents.unused.map((row) => row.name)).toEqual(["Explore"]);
  });

  it("merges OpenCode 2's per-thread T3 server into the T3 uses the server records", () => {
    const { mcpServers } = threadExtensionSections({
      used: [use("mcp", "t3-code", 4, { count: 3 })],
      inventoryStatus: "unsupported",
      mcpServersLive: true,
      inventory: {
        skills: [],
        plugins: [],
        agents: [],
        mcpServers: [
          { name: "t3-code-thread:1", status: "connected" },
          { name: "linear", status: "connected" },
        ],
      },
    });

    expect(mcpServers.used.map((row) => [row.name, row.count, row.status])).toEqual([
      ["t3-code", 3, "connected"],
    ]);
    expect(mcpServers.unused.map((row) => row.name)).toEqual(["linear"]);
  });

  it("shows only used entries when the provider reports no inventory", () => {
    const sections = threadExtensionSections({
      used: [use("mcp", "linear", 2)],
      inventoryStatus: "unsupported",
      inventory: null,
    });

    expect(sections.inventoryStatus).toBe("unsupported");
    expect(sections.mcpServers.used.map((row) => row.name)).toEqual(["linear"]);
    expect(sections.skills).toEqual({ used: [], unused: [] });
  });

  it("is empty before data arrives or when nothing was loaded or used", () => {
    expect(threadExtensionSections(undefined).isEmpty).toBe(true);
    expect(
      threadExtensionSections({ used: [], inventoryStatus: "pending", inventory: null }).isEmpty,
    ).toBe(true);
  });
});

describe("threadExtensionsRevision", () => {
  const run = (overrides: Partial<ThreadRunSummary> = {}): ThreadRunSummary => ({
    runId: RunId.make("run:1"),
    status: "running",
    requestedAt: "2026-10-08T12:00:00.000Z",
    startedAt: "2026-10-08T12:00:01.000Z",
    completedAt: null,
    assistantMessageId: null,
    ...overrides,
  });

  it("changes when a run starts or settles, not while it works", () => {
    const working = threadExtensionsRevision({ latestRun: run(), activeProviderThreadId: null });

    expect(threadExtensionsRevision({ latestRun: run(), activeProviderThreadId: null })).toBe(
      working,
    );
    expect(
      threadExtensionsRevision({
        latestRun: run({ status: "completed", completedAt: "2026-10-08T12:01:00.000Z" }),
        activeProviderThreadId: null,
      }),
    ).not.toBe(working);
    expect(
      threadExtensionsRevision({
        latestRun: run({ runId: RunId.make("run:2") }),
        activeProviderThreadId: null,
      }),
    ).not.toBe(working);
  });
});

describe("threadExtensionDisplayName", () => {
  it("drops the plugin prefix a badge already shows", () => {
    const row = (name: string, plugin: string | null) => ({
      name,
      plugin,
      count: 0,
      lastUsedAt: null,
      lastItem: null,
    });

    expect(
      [
        row("caveman:caveman-review", "caveman"),
        row("plugin:context7:context7", "context7"),
        row("review", null),
        row("caveman:", "caveman"),
      ].map(threadExtensionDisplayName),
    ).toEqual(["caveman-review", "context7", "review", "caveman:"]);
  });
});

describe("mcpServerStatusTone", () => {
  it("maps provider statuses to tones", () => {
    expect(
      ["connected", "needs-auth", "failed", "pending", "disabled", "unknown", undefined].map(
        mcpServerStatusTone,
      ),
    ).toEqual(["ok", "warning", "error", "neutral", "neutral", "neutral", "neutral"]);
  });
});

describe("threadExtensionSectionCountLabel", () => {
  it("counts used items out of everything listed, or just the total when nothing is used", () => {
    // A used skill the session never listed as loaded, beside two loaded but unused.
    const { skills } = threadExtensionSections({
      used: [use("skill", "frontend-design", 1)],
      inventoryStatus: "available",
      inventory: { skills: ["review", "simplify"], plugins: [], mcpServers: [], agents: [] },
    });

    expect(threadExtensionSectionCountLabel(skills)).toBe("1 of 3 used");
    expect(threadExtensionSectionCountLabel({ used: [], unused: skills.unused })).toBe("2");
    expect(threadExtensionSectionCountLabel({ used: [], unused: [] })).toBe("0");
  });
});

describe("threadExtensionSectionExpandedByDefault", () => {
  it("starts open when something was used and closed when everything went unused", () => {
    const { skills } = threadExtensionSections({
      used: [use("skill", "review", 1)],
      inventoryStatus: "available",
      inventory: { skills: ["simplify"], plugins: [], mcpServers: [], agents: [] },
    });

    expect(threadExtensionSectionExpandedByDefault(skills)).toBe(true);
    expect(threadExtensionSectionExpandedByDefault({ used: skills.used, unused: [] })).toBe(true);
    expect(threadExtensionSectionExpandedByDefault({ used: [], unused: skills.unused })).toBe(
      false,
    );
    expect(threadExtensionSectionExpandedByDefault({ used: [], unused: [] })).toBe(false);
  });
});

describe("threadExtensionsFootnotes", () => {
  it("says a fork's inherited history isn't counted", () => {
    const forkedFrom = { type: "run" as const, threadId, runId: RunId.make("run:source") };

    expect(threadExtensionsFootnotes({ forkedFrom: null })).toHaveLength(1);
    expect(threadExtensionsFootnotes({ forkedFrom })).toEqual([
      "Calls made inside workflow agents aren't counted.",
      "Only this fork's own turns are counted, not the history it inherited.",
    ]);
  });
});

describe("threadExtensionsCommandSection", () => {
  it("opens a section only for the whole command, without arguments", () => {
    expect(["/mcp", "  /MCP ", "/skills", "/Skills\n"].map(threadExtensionsCommandSection)).toEqual(
      ["mcpServers", "mcpServers", "skills", "skills"],
    );
    expect(
      ["/mcp reconnect linear", "/skills list", "/mcps", "/skill", "check /mcp", "mcp", ""].map(
        threadExtensionsCommandSection,
      ),
    ).toEqual([null, null, null, null, null, null, null]);
  });
});

describe("withoutThreadExtensionsCommands", () => {
  it("hides the provider's /mcp and /skills only while T3 offers its own", () => {
    const commands = [{ name: "mcp" }, { name: "skills" }, { name: "review" }, { name: "mcp-x" }];

    expect(withoutThreadExtensionsCommands(commands, true).map((command) => command.name)).toEqual([
      "review",
      "mcp-x",
    ]);
    expect(withoutThreadExtensionsCommands(commands, false)).toEqual(commands);
  });
});

describe("mcpServerStatusLabel", () => {
  it("names every status in words", () => {
    expect(
      [
        "connected",
        "pending",
        "needs-auth",
        "failed",
        "disabled",
        "unknown",
        "weird",
        undefined,
      ].map(mcpServerStatusLabel),
    ).toEqual([
      "Connected",
      "Connecting",
      "Needs sign-in",
      "Failed",
      "Disabled",
      "Unknown",
      "Unknown",
      null,
    ]);
  });
});

describe("mcpServerRows", () => {
  const claudeConfig = (threadMcpControl: boolean | undefined) => ({
    environment: {
      capabilities: threadMcpControl === undefined ? {} : { threadMcpControl },
    },
    providers: [
      { instanceId: "claude", driver: "claudeAgent" },
      { instanceId: "codex", driver: "codex" },
    ],
  });
  const shell = (
    runStatus: string | null,
    activeRunId: string | null = null,
    instanceId = "claude",
  ) => ({
    providerInstanceId: instanceId,
    runtime: { providerInstanceId: instanceId, activeRunId },
    latestRun: runStatus === null ? null : { status: runStatus },
  });
  const extensions: OrchestrationV2ThreadExtensions = {
    used: [use("mcp", "linear", 3)],
    inventoryStatus: "available",
    mcpServersLive: true,
    inventory: {
      skills: [],
      plugins: [],
      agents: [],
      mcpServers: [
        { name: "zeta", status: "connected", source: "user", tools: ["a", "b"] },
        { name: "linear", status: "needs-auth", source: "user" },
        { name: "off", status: "disabled", source: "project" },
        { name: "alpha", status: "connected", source: "project" },
        { name: "t3-code", status: "connected", source: "dynamic" },
        { name: "broken", status: "failed", source: "local", error: "ENOENT" },
        { name: "slow", status: "pending" },
        { name: "plugin:remotion:docs", status: "connected", source: "plugin" },
        { name: "claude.ai Slack", status: "connected", source: "claudeai" },
      ],
    },
  };
  const rows = (
    overrides: Partial<Parameters<typeof mcpServerRows>[1]> = {},
    data: OrchestrationV2ThreadExtensions = extensions,
  ) =>
    mcpServerRows(threadExtensionSections(data).mcpServers, {
      live: data.mcpServersLive === true,
      permitted: true,
      config: claudeConfig(true),
      shell: shell(null),
      ...overrides,
    });
  const byLabel = <A>(pick: (view: McpServerRowView) => A, views = rows()) =>
    Object.fromEntries(views.map((view) => [view.label, pick(view)]));

  it("labels each server with its source in words and its status", () => {
    expect(byLabel((view) => [view.badge, view.statusLabel])).toEqual({
      "T3 Code": ["Built in", "Connected"],
      broken: ["Local", "Failed"],
      linear: ["Personal", "Needs sign-in"],
      alpha: ["Project", "Connected"],
      docs: ["remotion", "Connected"],
      zeta: ["Personal", "Connected"],
      slow: [null, "Connecting"],
      off: ["Project", "Disabled"],
      // The claude.ai badge carries the prefix the connector's name repeats.
      Slack: ["claude.ai", "Connected"],
    });
    expect(rows().find((view) => view.label === "broken")?.row.error).toBe("ENOENT");
    expect(rows().find((view) => view.label === "zeta")?.row.availableTools).toEqual(["a", "b"]);
    expect(rows().find((view) => view.label === "linear")?.hint).toBe(
      "Sign in on the computer that runs T3 Code: claude mcp login linear --no-browser, then check the connection.",
    );
  });

  it("offers Reconnect on every live Claude server that is not disabled, T3's own included", () => {
    expect(byLabel((view) => view.reconnect)).toEqual({
      "T3 Code": { disabledReason: null },
      broken: { disabledReason: null },
      linear: { disabledReason: null },
      alpha: { disabledReason: null },
      docs: { disabledReason: null },
      zeta: { disabledReason: null },
      slow: { disabledReason: null },
      off: null,
      Slack: { disabledReason: null },
    });
  });

  it("hides Reconnect without the capability, the grant, a live list or a provider that reconnects", () => {
    const hidden = (overrides: Partial<Parameters<typeof mcpServerRows>[1]>) =>
      rows(overrides).every((view) => view.reconnect === null);

    expect(hidden({ config: claudeConfig(undefined) })).toBe(true);
    expect(hidden({ config: claudeConfig(false) })).toBe(true);
    expect(hidden({ config: null })).toBe(true);
    expect(hidden({ permitted: false })).toBe(true);
    expect(hidden({ live: false })).toBe(true);
    expect(hidden({ shell: shell(null, null, "codex") })).toBe(true);
    expect(hidden({})).toBe(false);
  });

  it("keeps Reconnect disabled while a turn is live, not while a finished turn waits", () => {
    // The latest run is a follow-up queued behind the live one in the last case.
    for (const status of ["preparing", "starting", "running", "queued"]) {
      expect(rows({ shell: shell(status, "run:live") })[0]?.reconnect).toEqual({
        disabledReason: "Wait for the current turn to finish, then try again.",
      });
    }
    for (const status of ["waiting", "completed", "queued"]) {
      expect(rows({ shell: shell(status) })[0]?.reconnect).toEqual({ disabledReason: null });
    }
  });

  it("expands a row only for an error, a hint, its tools or Reconnect", () => {
    const snapshot = { ...extensions, mcpServersLive: false };

    expect(byLabel((view) => view.hasDetail, rows({}, snapshot))).toEqual({
      "T3 Code": false,
      broken: true,
      linear: true,
      alpha: false,
      docs: false,
      zeta: true,
      slow: false,
      off: false,
      Slack: false,
    });
    expect(rows().find((view) => view.label === "alpha")?.hasDetail).toBe(true);
    // Last use and calls show on the row itself, so they leave nothing to expand.
    const [used] = rows(
      {},
      {
        used: [use("mcp", "context7", 1, { tools: [{ name: "query-docs", count: 2 }] })],
        inventoryStatus: "unsupported",
        inventory: null,
      },
    );
    expect(used?.hasDetail).toBe(false);
  });

  it("lists used servers the session did not report, without status or actions", () => {
    const [view] = rows(
      {},
      { used: [use("mcp", "context7", 1)], inventoryStatus: "unsupported", inventory: null },
    );

    expect(view).toMatchObject({ label: "context7", statusLabel: null, tone: "neutral" });
    expect(view?.reconnect).toBeNull();
  });

  describe("sign-in", () => {
    const signInConfig = (
      capabilities: { threadMcpControl?: boolean; threadMcpSignIn?: boolean } = {
        threadMcpControl: true,
        threadMcpSignIn: true,
      },
    ) => ({ ...claudeConfig(true), environment: { capabilities } });
    const signInData: OrchestrationV2ThreadExtensions = {
      used: [],
      inventoryStatus: "available",
      mcpServersLive: true,
      inventory: {
        skills: [],
        plugins: [],
        agents: [],
        mcpServers: [
          { name: "linear", status: "needs-auth", source: "user", signIn: "oauth" },
          {
            name: "claude.ai Notion",
            status: "needs-auth",
            source: "claudeai",
            signIn: "claude-ai",
          },
          { name: "signed-out", status: "failed", source: "user", signIn: "oauth" },
          { name: "keyed", status: "needs-auth", source: "user" },
          { name: "zeta", status: "connected", source: "user", signIn: "oauth" },
          { name: "local", status: "connected", source: "user" },
          { name: "claude.ai Slack", status: "connected", source: "claudeai", signIn: "claude-ai" },
        ],
      },
    };
    const signInRows = (overrides: Partial<Parameters<typeof mcpServerRows>[1]> = {}) =>
      rows({ config: signInConfig(), ...overrides }, signInData);
    const claudeFallback = (name: string) =>
      `Sign in on the computer that runs T3 Code: claude mcp login ${name} --no-browser, then check the connection.`;

    it("offers Sign in instead of Reconnect where Claude Code offers Authenticate", () => {
      expect(
        byLabel(
          (view) => ({
            signIn: view.signIn,
            signOut: view.signOut,
            reconnect: view.reconnect !== null,
            hint: view.hint,
          }),
          signInRows(),
        ),
      ).toEqual({
        linear: {
          signIn: { kind: "oauth", label: "Sign in", fallback: claudeFallback("linear") },
          signOut: null,
          reconnect: false,
          hint: null,
        },
        Notion: {
          signIn: {
            kind: "claude-ai",
            label: "Authorize on claude.ai",
            fallback: "Authorize it in Settings > Connectors on claude.ai.",
          },
          signOut: null,
          reconnect: false,
          hint: null,
        },
        // A signed-out server reads as failed: signing in again is the way back.
        "signed-out": {
          signIn: { kind: "oauth", label: "Sign in", fallback: claudeFallback("signed-out") },
          signOut: null,
          reconnect: true,
          hint: null,
        },
        // A server that sends its own Authorization header does not sign in through T3 Code.
        keyed: { signIn: null, signOut: null, reconnect: true, hint: claudeFallback("keyed") },
        zeta: { signIn: null, signOut: { disabledReason: null }, reconnect: true, hint: null },
        local: { signIn: null, signOut: null, reconnect: true, hint: null },
        Slack: { signIn: null, signOut: null, reconnect: true, hint: null },
      });
      expect(signInRows().every((view) => view.hasDetail)).toBe(true);
    });

    it("falls back to the terminal command, keeping Reconnect, when T3 Code can't sign in", () => {
      for (const overrides of [
        { config: signInConfig({ threadMcpControl: true }) },
        { permitted: false },
        { live: false },
      ]) {
        const views = signInRows(overrides);
        expect(views.every((view) => view.signIn === null && view.signOut === null)).toBe(true);
        expect(views.find((view) => view.label === "linear")?.hint).toBe(claudeFallback("linear"));
        expect(views.find((view) => view.label === "Notion")?.hint).toBe(
          "Authorize it in Settings > Connectors on claude.ai.",
        );
      }
      expect(
        signInRows({ shell: shell(null, null, "codex") }).every(
          (view) => view.signIn === null && view.signOut === null,
        ),
      ).toBe(true);
      // Without native sign-in, Reconnect picks up a sign-in made in a terminal.
      const linear = signInRows({ config: signInConfig({ threadMcpControl: true }) }).find(
        (view) => view.label === "linear",
      );
      expect(linear?.reconnect).toEqual({ disabledReason: null });
    });

    it("keeps Sign in available mid-turn and Sign out disabled until the turn ends", () => {
      const views = signInRows({ shell: shell("running", "run:live") });
      expect(views.find((view) => view.label === "linear")?.signIn?.label).toBe("Sign in");
      expect(views.find((view) => view.label === "zeta")?.signOut).toEqual({
        disabledReason: "Wait for the current turn to finish, then try again.",
      });
    });

    it("quotes server names in commands and names each provider's own", () => {
      const named = (name: string, driver = "claudeAgent") =>
        mcpServerRows(
          threadExtensionSections({
            used: [],
            inventoryStatus: "available",
            mcpServersLive: true,
            inventory: {
              skills: [],
              plugins: [],
              agents: [],
              mcpServers: [{ name, status: "needs-auth" }],
            },
          }).mcpServers,
          {
            live: true,
            permitted: true,
            config: {
              environment: { capabilities: { threadMcpControl: true } },
              providers: [{ instanceId: "this", driver }],
            },
            shell: shell(null, null, "this"),
          },
        )[0]?.hint;

      expect(named("plugin:docs:context7")).toBe(claudeFallback("plugin:docs:context7"));
      expect(named("my server")).toBe(claudeFallback("'my server'"));
      expect(named("it's $(rm -rf ~)")).toBe(claudeFallback("'it'\\''s $(rm -rf ~)'"));
      expect(named("linear", "opencode")).toBe(
        "Sign in on the computer that runs T3 Code: opencode mcp auth linear, then check the connection.",
      );
      expect(named("linear", "codex")).toBe("Sign in to this server from the provider's own CLI.");
    });
  });
});

describe("mcpServerGroups", () => {
  const groups = (data: OrchestrationV2ThreadExtensions) =>
    mcpServerGroups(
      mcpServerRows(threadExtensionSections(data).mcpServers, {
        live: false,
        permitted: false,
        config: null,
        shell: null,
      }),
    ).map((group) => ({
      id: group.id,
      label: group.label,
      countLabel: group.countLabel,
      tone: group.tone,
      rows: group.rows.map((view) => view.label),
    }));
  const inventory = (
    mcpServers: NonNullable<OrchestrationV2ThreadExtensions["inventory"]>["mcpServers"],
  ) => ({ skills: [], plugins: [], agents: [], mcpServers });

  it("groups by status: problems, connected, then the rest, each led by T3's own server", () => {
    expect(
      groups({
        used: [use("mcp", "zeta", 9), use("mcp", "alpha", 1), use("mcp", "linear", 5)],
        inventoryStatus: "available",
        inventory: inventory([
          { name: "off", status: "disabled" },
          { name: "zeta", status: "connected" },
          { name: "beta", status: "connected" },
          { name: "alpha", status: "connected" },
          { name: "linear", status: "needs-auth" },
          { name: "atlas", status: "needs-auth" },
          { name: "broken", status: "failed" },
          { name: "slow", status: "pending" },
          { name: "odd", status: "unknown" },
          { name: "t3-code", status: "connected" },
        ]),
      }),
    ).toEqual([
      {
        id: "mcpServers:attention",
        label: "Needs attention",
        countLabel: "1 failed · 2 need sign-in",
        tone: "warning",
        // Failed before needs sign-in; within that, used before unused.
        rows: ["broken", "linear", "atlas"],
      },
      {
        id: "mcpServers:connected",
        label: "Connected",
        countLabel: "4",
        tone: "neutral",
        // T3 first, then used by recency (zeta at :09, alpha at :01), then A–Z.
        rows: ["T3 Code", "zeta", "alpha", "beta"],
      },
      {
        id: "mcpServers:not-connected",
        label: "Not connected",
        countLabel: "3",
        tone: "neutral",
        rows: ["odd", "off", "slow"],
      },
    ]);
  });

  it("keeps a failed T3 server first among the problems rather than above every group", () => {
    const [attention] = groups({
      used: [],
      inventoryStatus: "available",
      inventory: inventory([
        { name: "broken", status: "failed" },
        { name: "t3-code", status: "needs-auth" },
      ]),
    });

    expect(attention?.rows).toEqual(["T3 Code", "broken"]);
    expect(attention?.countLabel).toBe("1 failed · 1 needs sign-in");
  });

  it("puts servers with no reported status under Used in this thread, open", () => {
    const data: OrchestrationV2ThreadExtensions = {
      used: [use("mcp", "context7", 2), use("mcp", "linear", 4)],
      inventoryStatus: "unsupported",
      inventory: null,
    };

    expect(groups(data)).toEqual([
      {
        id: "mcpServers:used",
        label: "Used in this thread",
        countLabel: "2",
        tone: "neutral",
        rows: ["linear", "context7"],
      },
    ]);
  });

  it("collapses a status group past eight rows but never the used group", () => {
    const many = Array.from({ length: 9 }, (_, index) => `server-${index}`);
    const views = mcpServerGroups(
      mcpServerRows(
        threadExtensionSections({
          used: many.map((name, index) => use("mcp", name, index)),
          inventoryStatus: "unsupported",
          inventory: null,
        }).mcpServers,
        { live: false, permitted: false, config: null, shell: null },
      ),
    );
    expect(views.map((group) => group.expandedByDefault)).toEqual([true]);

    const statusGroups = mcpServerGroups(
      mcpServerRows(
        threadExtensionSections({
          used: [],
          inventoryStatus: "available",
          inventory: inventory([
            ...many.map((name) => ({ name, status: "connected" })),
            { name: "broken", status: "failed" },
          ]),
        }).mcpServers,
        { live: false, permitted: false, config: null, shell: null },
      ),
    );
    expect(statusGroups.map((group) => [group.label, group.expandedByDefault])).toEqual([
      ["Needs attention", true],
      ["Connected", false],
    ]);
  });

  it("keeps Needs attention open however many servers it holds, also while searching", () => {
    // A real setup: 10 failed, 16 needing sign-in, 7 connected.
    const servers = [
      ...Array.from({ length: 10 }, (_, index) => ({ name: `broken-${index}`, status: "failed" })),
      ...Array.from({ length: 16 }, (_, index) => ({
        name: `auth-${index}`,
        status: "needs-auth",
      })),
      ...Array.from({ length: 7 }, (_, index) => ({ name: `ok-${index}`, status: "connected" })),
    ];
    const sections = threadExtensionSections({
      used: [],
      inventoryStatus: "available",
      inventory: inventory(servers),
    });
    const open = (query: string) =>
      mcpServerGroups(
        mcpServerRows(filterThreadExtensionSections(sections, query).mcpServers, {
          live: false,
          permitted: false,
          config: null,
          shell: null,
        }),
      ).map((group) => [group.label, group.rows.length, group.expandedByDefault]);

    expect(open("")).toEqual([
      ["Needs attention", 26, true],
      ["Connected", 7, true],
    ]);
    // "sign" matches the Needs sign-in status word on 16 servers.
    expect(open("sign")).toEqual([["Needs attention", 16, true]]);
  });
});

describe("mcpServerMetaLabel", () => {
  it("joins the tools a server offers and its uses with a dot", () => {
    expect(mcpServerMetaLabel({ availableTools: ["a", "b", "c"], count: 2 })).toBe(
      "3 tools · 2 uses",
    );
    expect(mcpServerMetaLabel({ availableTools: ["a"], count: 0 })).toBe("1 tool");
    expect(mcpServerMetaLabel({ count: 1 })).toBe("1 use");
    expect(mcpServerMetaLabel({ availableTools: [], count: 0 })).toBeNull();
  });
});

describe("threadExtensionsInventoryNote", () => {
  it("says skills come from the skill folders until the provider lists the rest", () => {
    expect(threadExtensionsInventoryNote("available", true)).toBeNull();
    expect(threadExtensionsInventoryNote("pending")).toBe(
      "Claude lists its plugins, agents and MCP servers after the session's first turn. Until then, skills come from your skill folders.",
    );
    expect(threadExtensionsInventoryNote("unsupported")).toBe(
      "This provider doesn't report what it loaded. Skills come from its skill folders; everything else shows once this thread uses it.",
    );
    expect(threadExtensionsInventoryNote("unsupported", true)).toBe(
      "This provider reports only its MCP servers. Skills come from its skill folders; plugins and agents show once this thread uses them.",
    );
  });
});

describe("mcpServerStatusFreshness", () => {
  it("says whether statuses are live or from the session start", () => {
    const inventory = {
      skills: [],
      plugins: [],
      agents: [],
      mcpServers: [{ name: "linear", status: "connected" }],
    };

    expect(
      mcpServerStatusFreshness({
        used: [],
        inventoryStatus: "available",
        inventory,
        mcpServersLive: true,
      }),
    ).toBe("Live status");
    expect(mcpServerStatusFreshness({ used: [], inventoryStatus: "available", inventory })).toBe(
      "As of session start",
    );
    expect(
      mcpServerStatusFreshness({ used: [], inventoryStatus: "unsupported", inventory: null }),
    ).toBeNull();
  });
});

const claude = (
  skills: ThreadExtensionsProvider["skills"],
  slashCommands: ThreadExtensionsProvider["slashCommands"] = [],
): ThreadExtensionsProvider => ({
  driver: ProviderDriverKind.make("claudeAgent"),
  skills,
  slashCommands,
});

function skill(name: string, overrides: Partial<ServerProviderSkill> = {}): ServerProviderSkill {
  return { name, path: `/home/me/.claude/skills/${name}/SKILL.md`, enabled: true, ...overrides };
}

const available = (
  inventory: Partial<NonNullable<OrchestrationV2ThreadExtensions["inventory"]>>,
  used: ReadonlyArray<OrchestrationV2ThreadExtensionUse> = [],
): OrchestrationV2ThreadExtensions => ({
  used,
  inventoryStatus: "available",
  inventory: { skills: [], plugins: [], mcpServers: [], agents: [], ...inventory },
});

describe("threadExtensionsProvider", () => {
  const provider = (instanceId: string, driver: string) =>
    ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [{ name: "machine-command" }],
      skills: [skill("machine-skill")],
      workspaceSnapshots: [
        {
          cwd: "/work/app",
          checkedAt: "2026-01-01T00:01:00.000Z",
          slashCommands: [{ name: "app-command" }],
          skills: [skill("app-skill", { scope: "project" })],
        },
      ],
    }) satisfies ServerProvider;
  const providers = [provider("claude", "claudeAgent"), provider("codex", "codex")];

  it("reads the runtime's instance first, with the skills for the thread's folder", () => {
    const resolved = threadExtensionsProvider(
      providers,
      { providerInstanceId: "codex", runtime: { providerInstanceId: "claude" } },
      "/work/app",
    );

    expect(resolved?.driver).toBe("claudeAgent");
    expect(resolved?.skills.map((entry) => entry.name)).toEqual(["app-skill"]);
    expect(resolved?.slashCommands.map((entry) => entry.name)).toEqual(["app-command"]);
  });

  it("falls back to the machine-level lists without a snapshot for the folder", () => {
    const resolved = threadExtensionsProvider(
      providers,
      { providerInstanceId: "codex", runtime: null },
      "/somewhere/else",
    );

    expect(resolved?.driver).toBe("codex");
    expect(resolved?.skills.map((entry) => entry.name)).toEqual(["machine-skill"]);
    expect(
      threadExtensionsProvider(providers, { providerInstanceId: "codex", runtime: null }, null)
        ?.slashCommands,
    ).toEqual([{ name: "machine-command" }]);
  });

  it("is null for an unknown instance or no thread", () => {
    expect(
      threadExtensionsProvider(providers, { providerInstanceId: "gone", runtime: null }, null),
    ).toBeNull();
    expect(threadExtensionsProvider(providers, null, "/work/app")).toBeNull();
  });
});

describe("threadExtensionSections skills join", () => {
  it("describes a plugin skill from its slash command and groups it under the plugin", () => {
    const { skills } = threadExtensionSections(
      available({ skills: ["caveman:caveman-review"] }),
      claude([], [{ name: "caveman:caveman-review", description: "Compressed code review" }]),
    );

    expect(skills.unused).toEqual([
      {
        name: "caveman:caveman-review",
        plugin: "caveman",
        count: 0,
        lastUsedAt: null,
        lastItem: null,
        sourceLabel: "caveman",
        description: "Compressed code review",
      },
    ]);
  });

  it("takes a bare skill's short description, then description, scope, state and path", () => {
    const { skills } = threadExtensionSections(
      available({ skills: ["review", "seo-audit", "deploy"] }),
      claude(
        [
          skill("review", {
            scope: "user",
            shortDescription: "Review a diff",
            description: "Long review text",
            userInvocationOnly: true,
          }),
          skill("seo-audit", { scope: "project", description: "Audit SEO" }),
          skill("deploy", { scope: "user", userInvocable: false }),
        ],
        [{ name: "review", description: "From the command" }],
      ),
    );
    const byName = Object.fromEntries(skills.unused.map((row) => [row.name, row]));

    expect(byName.review).toMatchObject({
      description: "Review a diff",
      sourceKind: "personal",
      sourceLabel: "Personal",
      enabled: true,
      invocation: "user-only",
      path: "/home/me/.claude/skills/review/SKILL.md",
    });
    expect(byName["seo-audit"]).toMatchObject({
      description: "Audit SEO",
      sourceKind: "project",
      sourceLabel: "Project",
      invocation: "anyone",
    });
    expect(byName.deploy).toMatchObject({ invocation: "agent-only" });
    expect(byName.deploy?.description).toBeUndefined();
  });

  it("lists a switched-off provider skill the session never loaded, so Off is visible", () => {
    const { skills } = threadExtensionSections(
      available({ skills: ["review"] }),
      claude([skill("review"), skill("legacy", { enabled: false })]),
    );

    expect(skills.unused.map((row) => [row.name, row.enabled])).toEqual([
      ["legacy", false],
      ["review", true],
    ]);
  });

  it("matches names case-insensitively and ignores surrounding space", () => {
    const { skills } = threadExtensionSections(
      available({ skills: ["Review"] }, [use("skill", "SEO-Audit", 1)]),
      claude(
        [skill(" review ", { scope: "user" }), skill("seo-audit", { scope: "project" })],
        [{ name: "REVIEW", description: "Review a diff" }],
      ),
    );

    // One row per skill, not one for the inventory name and another for the provider's.
    expect(skills.unused.map((row) => [row.name, row.sourceLabel, row.description])).toEqual([
      ["Review", "Personal", "Review a diff"],
    ]);
    expect(skills.used.map((row) => [row.name, row.sourceLabel])).toEqual([
      ["SEO-Audit", "Project"],
    ]);
  });

  it("enriches a used skill the session's inventory never listed", () => {
    const { skills } = threadExtensionSections(
      available({ skills: [] }, [use("skill", "frontend-design", 1, { count: 2 })]),
      claude([skill("frontend-design", { scope: "user", description: "Build UIs" })]),
    );

    expect(skills.used).toMatchObject([
      { name: "frontend-design", count: 2, description: "Build UIs", sourceLabel: "Personal" },
    ]);
    expect(skills.unused).toEqual([]);
  });

  it("fills a provider without an inventory from its skill folders (Codex)", () => {
    const sections = threadExtensionSections(
      { used: [], inventoryStatus: "unsupported", inventory: null },
      {
        driver: ProviderDriverKind.make("codex"),
        skills: [
          skill("lint", { scope: "repo" }),
          skill("browser", { path: "/home/me/.codex/plugins/web/browser/SKILL.md" }),
          skill("git", { scope: "system" }),
        ],
        slashCommands: [],
      },
    );

    expect(sections.isEmpty).toBe(false);
    expect(sections.skills.unused.map((row) => [row.name, row.sourceLabel])).toEqual([
      ["browser", "App"],
      ["git", "System"],
      ["lint", "Repo"],
    ]);
  });

  it("never turns a slash command alone into a skill", () => {
    const { skills } = threadExtensionSections(
      available({ skills: ["review"] }),
      claude([], [{ name: "compact" }, { name: "review", description: "Review a diff" }]),
    );

    expect(skills.unused.map((row) => row.name)).toEqual(["review"]);
  });

  it("leaves an unmatched skill with its name and group, inventing nothing", () => {
    const { skills } = threadExtensionSections(available({ skills: ["mystery"] }));

    expect(skills.unused).toEqual([
      {
        name: "mystery",
        plugin: null,
        count: 0,
        lastUsedAt: null,
        lastItem: null,
        sourceLabel: "Other",
      },
    ]);
  });
});

describe("filterThreadExtensionSections", () => {
  const sections = threadExtensionSections(
    {
      used: [
        use("mcp", "context7", 2, { tools: [{ name: "query-docs", count: 1 }] }),
        use("agent", "caveman:cavecrew-builder", 3),
      ],
      inventoryStatus: "available",
      mcpServersLive: true,
      inventory: {
        skills: ["seo-audit", "caveman:caveman-review", "schema"],
        plugins: [{ name: "caveman" }],
        mcpServers: [
          { name: "context7", status: "connected" },
          { name: "linear", status: "needs-auth", source: "user", tools: ["create_issue"] },
        ],
        agents: ["Explore", "caveman:cavecrew-builder"],
      },
    },
    claude([
      skill("seo-audit", { scope: "user", description: "Audit a site's SEO" }),
      skill("schema", { scope: "user", description: "Add structured data", enabled: false }),
    ]),
  );
  const names = (filtered: ThreadExtensionSections) =>
    Object.fromEntries(
      THREAD_EXTENSION_SECTION_ORDER.map((key) => [
        key,
        [...filtered[key].used, ...filtered[key].unused].map((row) => row.name),
      ]),
    );

  it("requires every term, in any field", () => {
    expect(names(filterThreadExtensionSections(sections, "audit seo"))).toEqual({
      mcpServers: [],
      skills: ["seo-audit"],
      plugins: [],
      agents: [],
    });
    // "audit" matches seo-audit and "structured" matches schema, but no row has both.
    expect(filterThreadExtensionSections(sections, "audit structured").isEmpty).toBe(true);
  });

  it("matches descriptions, plugins, sources, states, statuses and tool names", () => {
    expect(names(filterThreadExtensionSections(sections, "STRUCTURED data")).skills).toEqual([
      "schema",
    ]);
    expect(names(filterThreadExtensionSections(sections, "caveman"))).toEqual({
      mcpServers: [],
      skills: ["caveman:caveman-review"],
      plugins: ["caveman"],
      agents: ["caveman:cavecrew-builder"],
    });
    expect(names(filterThreadExtensionSections(sections, "personal")).skills).toEqual([
      "schema",
      "seo-audit",
    ]);
    expect(names(filterThreadExtensionSections(sections, "off")).skills).toEqual(["schema"]);
    expect(names(filterThreadExtensionSections(sections, "sign-in")).mcpServers).toEqual([
      "linear",
    ]);
    expect(names(filterThreadExtensionSections(sections, "create_issue")).mcpServers).toEqual([
      "linear",
    ]);
    expect(names(filterThreadExtensionSections(sections, "query-docs")).mcpServers).toEqual([
      "context7",
    ]);
  });

  it("returns the sections unchanged for a blank query", () => {
    expect(filterThreadExtensionSections(sections, "")).toBe(sections);
    expect(filterThreadExtensionSections(sections, "  \n ")).toBe(sections);
  });

  it("keeps used and loaded rows apart and recomputes emptiness", () => {
    const filtered = filterThreadExtensionSections(sections, "cavecrew");

    expect(filtered.agents.used.map((row) => row.name)).toEqual(["caveman:cavecrew-builder"]);
    expect(filtered.agents.unused).toEqual([]);
    expect(filtered.isEmpty).toBe(false);
    expect(filtered.inventoryStatus).toBe("available");
    expect(filterThreadExtensionSections(sections, "nothing-like-this").isEmpty).toBe(true);
  });
});

describe("threadExtensionGroups", () => {
  const groupSummary = (groups: ReturnType<typeof threadExtensionGroups>) =>
    groups.map((group) => [group.label, group.countLabel, group.rows.map((row) => row.name)]);

  it("orders skills Used, Project, Repo, Personal, plugins A–Z, App, System, Other", () => {
    const { skills } = threadExtensionSections(
      available({ skills: ["zeta:one", "alpha:two", "mystery"] }, [
        use("skill", "alpha:two", 5),
        use("skill", "mine", 9),
      ]),
      {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
        skills: [
          skill("mine", { scope: "user" }),
          skill("ours", { scope: "project" }),
          skill("repo-skill", { scope: "repo" }),
          skill("browser", { path: "/home/me/.codex/plugins/web/browser/SKILL.md" }),
          skill("git", { scope: "system" }),
          skill("loose"),
        ],
      },
    );

    expect(groupSummary(threadExtensionGroups("skills", skills))).toEqual([
      ["Used in this thread", "2", ["mine", "alpha:two"]],
      ["Project", "1", ["ours"]],
      ["Repo", "1", ["repo-skill"]],
      // A used skill stays in its source group too, so that group's count is whole.
      ["Personal", "1 of 1 used", ["mine"]],
      ["alpha", "1 of 1 used", ["alpha:two"]],
      ["zeta", "1", ["zeta:one"]],
      ["App", "1", ["browser"]],
      ["System", "1", ["git"]],
      ["Other", "2", ["loose", "mystery"]],
    ]);
  });

  it("opens Used in this thread and groups of up to eight rows; larger groups start closed", () => {
    const names = Array.from({ length: 9 }, (_, index) => `big:skill-${index}`);
    const { skills } = threadExtensionSections(
      available(
        { skills: [...names, "small:one"] },
        names.map((name, index) => use("skill", name, index)),
      ),
    );
    const groups = threadExtensionGroups("skills", skills);

    expect(groups.map((group) => [group.id, group.rows.length, group.expandedByDefault])).toEqual([
      ["skills:used", 9, true],
      ["skills:plugin:big", 9, false],
      ["skills:plugin:small", 1, true],
    ]);
    const eight = threadExtensionSections(available({ skills: names.slice(1) })).skills;
    expect(threadExtensionGroups("skills", eight)[0]?.expandedByDefault).toBe(true);
  });

  it("groups agents by plugin and then Other, and plugins as Used then Installed", () => {
    const sections = threadExtensionSections(
      available(
        {
          agents: ["Explore", "general-purpose", "caveman:builder", "caveman:reviewer"],
          plugins: [{ name: "caveman" }, { name: "remotion" }],
        },
        [use("agent", "caveman:builder", 2), use("agent", "Explore", 4)],
      ),
    );

    expect(groupSummary(threadExtensionGroups("agents", sections.agents))).toEqual([
      ["Used in this thread", "2", ["Explore", "caveman:builder"]],
      ["caveman", "1 of 2 used", ["caveman:builder", "caveman:reviewer"]],
      ["Other", "1 of 2 used", ["Explore", "general-purpose"]],
    ]);
    expect(groupSummary(threadExtensionGroups("plugins", sections.plugins))).toEqual([
      ["Used in this thread", "1", ["caveman"]],
      ["Installed", "1", ["remotion"]],
    ]);
  });

  it("has no groups for an empty section", () => {
    expect(threadExtensionGroups("skills", { used: [], unused: [] })).toEqual([]);
    expect(threadExtensionGroups("plugins", { used: [], unused: [] })).toEqual([]);
  });
});

describe("pluginRowView", () => {
  const sections = threadExtensionSections(
    available(
      {
        skills: Array.from({ length: 18 }, (_, index) => `seo:skill-${index}`),
        plugins: [{ name: "seo", version: "2.2.5" }, { name: "web" }, { name: "empty" }],
        mcpServers: [
          { name: "plugin:seo:search", status: "failed" },
          { name: "plugin:web:browser", status: "needs-auth" },
          { name: "plugin:web:fetch", status: "needs-auth" },
          // Another plugin whose name starts the same way stays out.
          { name: "plugin:seo-extra:x", status: "failed" },
        ],
        agents: ["seo:auditor", "seo:writer", "seo:linker", "web:runner"],
      },
      [
        use("skill", "seo:skill-1", 1),
        use("skill", "seo:skill-2", 2),
        use("agent", "seo:writer", 3),
      ],
    ),
  );
  const view = (name: string) => {
    const row = [...sections.plugins.used, ...sections.plugins.unused].find(
      (entry) => entry.name === name,
    );
    if (row === undefined) throw new Error(`no plugin ${name}`);
    return pluginRowView(row, sections);
  };

  it("lists what a plugin ships with used counts per kind", () => {
    expect(view("seo")).toMatchObject({
      contents: "18 skills (2 used) · 1 MCP server · 3 agents (1 used)",
      problems: "1 failed",
    });
    expect(view("seo").row.version).toBe("2.2.5");
  });

  it("names problems in its MCP servers and says when it lists nothing", () => {
    expect(view("web")).toMatchObject({
      contents: "2 MCP servers · 1 agent",
      problems: "2 need sign-in",
    });
    expect(view("empty")).toMatchObject({
      contents: "No skills, MCP servers or agents",
      problems: null,
    });
  });
});

describe("threadExtensionsSummary", () => {
  const text = (parts: ReturnType<typeof threadExtensionsSummary>) =>
    parts.map((part) => (part.tone === "warning" ? `!${part.text}` : part.text));

  it("says how fresh, connected and healthy the servers are and how many skills were used", () => {
    const extensions: OrchestrationV2ThreadExtensions = {
      ...available(
        {
          skills: ["review", "simplify", "schema"],
          mcpServers: [
            { name: "a", status: "connected" },
            { name: "b", status: "failed" },
            { name: "c", status: "needs-auth" },
            { name: "d", status: "pending" },
          ],
        },
        [use("skill", "review", 1)],
      ),
      mcpServersLive: true,
    };

    expect(text(threadExtensionsSummary(threadExtensionSections(extensions), extensions))).toEqual([
      "Live status",
      "1 of 4 MCP servers connected",
      "!2 need attention",
      "1 of 3 skills used",
    ]);
  });

  it("uses singulars and the session-start freshness", () => {
    const extensions = available(
      { skills: ["review"], mcpServers: [{ name: "a", status: "failed" }] },
      [use("skill", "review", 1)],
    );

    expect(text(threadExtensionsSummary(threadExtensionSections(extensions), extensions))).toEqual([
      "As of session start",
      "0 of 1 MCP server connected",
      "!1 needs attention",
      "1 of 1 skill used",
    ]);
  });

  it("counts used servers when the provider reports no statuses, and used skills without a total", () => {
    const extensions: OrchestrationV2ThreadExtensions = {
      used: [use("mcp", "context7", 1), use("mcp", "linear", 2), use("skill", "review", 3)],
      inventoryStatus: "unsupported",
      inventory: null,
    };

    expect(text(threadExtensionsSummary(threadExtensionSections(extensions), extensions))).toEqual([
      "2 MCP servers used",
      "1 skill used",
    ]);
    expect(threadExtensionsSummary(threadExtensionSections(null), null)).toEqual([]);
  });

  it("leaves switched-off skills out of the total unless the thread used them", () => {
    const extensions = available({ skills: ["review"] }, [use("skill", "old", 1)]);
    const sections = threadExtensionSections(
      extensions,
      claude([
        skill("review"),
        skill("off-1", { enabled: false }),
        skill("old", { enabled: false }),
      ]),
    );

    expect(text(threadExtensionsSummary(sections, extensions))).toEqual(["1 of 2 skills used"]);
  });
});

describe("skill helpers", () => {
  it("starts a skill with / for Claude and $ elsewhere", () => {
    expect(skillStartText({ name: "caveman:caveman-review" }, "claudeAgent")).toBe(
      "/caveman:caveman-review",
    );
    expect(skillStartText({ name: "lint", invocation: "user-only" }, "codex")).toBe("$lint");
    expect(skillStartText({ name: "lint", enabled: true }, null)).toBe("$lint");
  });

  it("offers no way to start a skill that is off or only the agent may start", () => {
    expect(skillStartText({ name: "lint", enabled: false }, "claudeAgent")).toBeNull();
    expect(skillStartText({ name: "lint", invocation: "agent-only" }, "claudeAgent")).toBeNull();
  });

  it("names each state that limits a skill in a badge and a sentence", () => {
    const row = { name: "x", plugin: null, count: 0, lastUsedAt: null, lastItem: null };

    expect(skillStateBadges(row)).toEqual([]);
    expect(skillStateBadges({ ...row, enabled: true, invocation: "anyone" })).toEqual([]);
    expect(skillStateBadges({ ...row, enabled: false, invocation: "user-only" })).toEqual([
      { label: "Off", sentence: "Turned off in the provider's settings, so it won't run." },
      { label: "Only you", sentence: "Only you can start it. The agent won't use it on its own." },
    ]);
    expect(skillStateBadges({ ...row, invocation: "agent-only" })).toEqual([
      { label: "Only the agent", sentence: "Only the agent can start it. It isn't in the / menu." },
    ]);
  });

  it("counts uses in words", () => {
    expect([0, 1, 3].map(threadExtensionUsesLabel)).toEqual([null, "1 use", "3 uses"]);
  });
});

describe("mcpServerSourceLabel", () => {
  it("says where a server comes from in words, or as reported", () => {
    expect([
      mcpServerSourceLabel("dynamic", null, true),
      mcpServerSourceLabel("plugin", "remotion", false),
      ...["user", "project", "local", "claudeai", "sdk", "dynamic"].map((source) =>
        mcpServerSourceLabel(source, null, false),
      ),
      mcpServerSourceLabel(undefined, null, false),
    ]).toEqual([
      "Built in",
      "remotion",
      "Personal",
      "Project",
      "Local",
      "claude.ai",
      "SDK",
      "dynamic",
      null,
    ]);
  });
});

describe("threadExtensionsMatchStatus", () => {
  it("counts matches against the section's total with its noun", () => {
    expect(threadExtensionsMatchStatus("skills", 48, 262)).toBe("Showing 48 of 262 skills");
    expect(threadExtensionsMatchStatus("plugins", 1, 1)).toBe("Showing 1 of 1 plugin");
    expect(threadExtensionsMatchStatus("mcpServers", 0, 11)).toBe("Showing 0 of 11 MCP servers");
  });
});

describe("threadExtensionsEmptyState", () => {
  it("says what is missing, why and what to do, by what the provider reports", () => {
    expect(threadExtensionsEmptyState("mcpServers", "unsupported", true)).toEqual({
      title: "No MCP servers",
      description:
        "This session didn't load any MCP servers. Add one in the provider's settings, then restart the agent session.",
    });
    expect(threadExtensionsEmptyState("mcpServers", "pending", false)).toEqual({
      title: "No MCP servers yet",
      description: "Claude lists its MCP servers after the session's first turn.",
    });
    expect(threadExtensionsEmptyState("mcpServers", "unsupported", false).title).toBe(
      "No MCP servers used",
    );
    expect(threadExtensionsEmptyState("skills", "unsupported", false)).toEqual({
      title: "No skills found",
      description:
        "None were found in this project's or your skill folders, and this thread hasn't used any. Add a skill, then restart the agent session.",
    });
    expect(threadExtensionsEmptyState("skills", "pending", false).title).toBe("No skills yet");
    expect(threadExtensionsEmptyState("plugins", "available", false)).toEqual({
      title: "No plugins",
      description: "This session didn't load any plugins.",
    });
    expect(threadExtensionsEmptyState("plugins", "unsupported", true)).toEqual({
      title: "No plugins used",
      description:
        "This provider doesn't report its plugins. A plugin shows here once this thread uses something it ships.",
    });
    expect(threadExtensionsEmptyState("agents", "pending", false)).toEqual({
      title: "No agents yet",
      description: "Claude lists its agents after the session's first turn.",
    });
    expect(threadExtensionsEmptyState("agents", "unsupported", false).description).toBe(
      "This provider doesn't report its agents. An agent shows here once this thread starts one.",
    );
  });
});

describe("threadExtensionsNoMatchState", () => {
  it("points at another section with matches, or offers to clear the search", () => {
    expect(threadExtensionsNoMatchState("skills", " seo ", { key: "agents", count: 21 })).toEqual({
      title: 'No skills match "seo"',
      description: "Found 21 in Agents.",
      action: { label: "Show Agents", showSection: "agents" },
    });
    expect(threadExtensionsNoMatchState("mcpServers", "zz", null)).toEqual({
      title: 'No MCP servers match "zz"',
      description: "Search looks at names, descriptions, plugins and statuses. Try a shorter word.",
      action: { label: "Clear search", showSection: null },
    });
  });
});

describe("sectionWithMatches", () => {
  const sections = threadExtensionSections({
    used: [],
    inventoryStatus: "available",
    inventory: {
      skills: ["seo-audit", "seo-geo"],
      plugins: [],
      mcpServers: [{ name: "sentry", status: "connected" }],
      agents: ["claude-seo:seo-geo"],
    },
  });

  it("names the first other section in display order with matches, never the one shown", () => {
    expect(sectionWithMatches(sections, "plugins")).toEqual({ key: "mcpServers", count: 1 });
    expect(sectionWithMatches(sections, "mcpServers")).toEqual({ key: "skills", count: 2 });
  });

  it("is null when no other section has matches", () => {
    const empty = { used: [], unused: [] };
    expect(
      sectionWithMatches({ ...sections, mcpServers: empty, agents: empty }, "skills"),
    ).toBeNull();
  });
});

describe("THREAD_EXTENSION_SECTION_ORDER", () => {
  it("lists MCP servers, Skills, Plugins, Agents with their titles", () => {
    expect(
      THREAD_EXTENSION_SECTION_ORDER.map((key) => THREAD_EXTENSION_SECTION_TITLES[key].title),
    ).toEqual(["MCP servers", "Skills", "Plugins", "Agents"]);
  });
});
