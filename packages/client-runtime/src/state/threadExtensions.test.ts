import {
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadExtensions,
  type OrchestrationV2ThreadExtensionUse,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRunSummary } from "./models.ts";
import {
  mcpServerRows,
  mcpServerStatusFreshness,
  mcpServerStatusLabel,
  mcpServerStatusTone,
  threadExtensionDisplayName,
  threadExtensionSectionCountLabel,
  threadExtensionSectionExpandedByDefault,
  threadExtensionSections,
  threadExtensionsCommandSection,
  threadExtensionsFootnotes,
  threadExtensionsInventoryNote,
  threadExtensionsRevision,
  withoutThreadExtensionsCommands,
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
  it("counts used items apart from the loaded ones that went unused", () => {
    // A used skill the session never listed as loaded, beside two loaded but unused.
    const { skills } = threadExtensionSections({
      used: [use("skill", "frontend-design", 1)],
      inventoryStatus: "available",
      inventory: { skills: ["review", "simplify"], plugins: [], mcpServers: [], agents: [] },
    });

    expect(threadExtensionSectionCountLabel(skills)).toBe("1 used · 2 unused");
    expect(threadExtensionSectionCountLabel({ used: skills.used, unused: [] })).toBe("1 used");
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

  it("pins T3's own server first, then problems, then by status and name", () => {
    expect(rows().map((view) => [view.label, view.badge, view.statusLabel])).toEqual([
      ["T3 Code", "Built in", "Connected"],
      ["broken", "local", "Failed"],
      ["linear", "user", "Needs sign-in"],
      ["alpha", "project", "Connected"],
      ["docs", "remotion", "Connected"],
      ["zeta", "user", "Connected"],
      ["slow", null, "Connecting"],
      ["off", "project", "Disabled"],
    ]);
    const broken = rows().find((view) => view.label === "broken");
    expect(broken?.row.error).toBe("ENOENT");
    expect(rows().find((view) => view.label === "zeta")?.row.availableTools).toEqual(["a", "b"]);
    expect(rows().find((view) => view.label === "linear")?.hint).toBe(
      "Sign in from a terminal: run /mcp in Claude Code.",
    );
  });

  it("offers Reconnect on every live Claude server that is not disabled, T3's own included", () => {
    expect(rows().map((view) => [view.label, view.reconnect])).toEqual([
      ["T3 Code", { disabledReason: null }],
      ["broken", { disabledReason: null }],
      ["linear", { disabledReason: null }],
      ["alpha", { disabledReason: null }],
      ["docs", { disabledReason: null }],
      ["zeta", { disabledReason: null }],
      ["slow", { disabledReason: null }],
      ["off", null],
    ]);
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

  it("lists used servers by recent use after problems and before the rest", () => {
    const views = rows(
      {},
      {
        used: [
          use("mcp", "zeta", 9),
          use("mcp", "broken", 3),
          use("mcp", "context7", 5, { tools: [{ name: "query-docs", count: 2 }], count: 2 }),
          use("mcp", "alpha", 1),
        ],
        inventoryStatus: "available",
        mcpServersLive: true,
        inventory: {
          skills: [],
          plugins: [],
          agents: [],
          mcpServers: [
            { name: "t3-code", status: "connected" },
            { name: "off", status: "disabled" },
            { name: "zeta", status: "connected" },
            { name: "beta", status: "connected" },
            { name: "alpha", status: "pending" },
            { name: "broken", status: "failed" },
            { name: "slow", status: "pending" },
          ],
        },
      },
    );

    expect(views.map((view) => [view.label, view.foldable])).toEqual([
      ["T3 Code", false],
      ["broken", false],
      ["zeta", false],
      ["context7", false],
      ["alpha", false],
      ["beta", true],
      ["slow", true],
      ["off", true],
    ]);
  });

  it("never folds T3's own server or a problem away, even unused", () => {
    expect(rows().map((view) => [view.label, view.foldable])).toEqual([
      ["T3 Code", false],
      ["broken", false],
      ["linear", false],
      ["alpha", true],
      ["docs", true],
      ["zeta", true],
      ["slow", true],
      ["off", true],
    ]);
  });

  it("expands a row only for an error, a hint, its tools or Reconnect", () => {
    const snapshot = { ...extensions, mcpServersLive: false };

    expect(rows({}, snapshot).map((view) => [view.label, view.hasDetail])).toEqual([
      ["T3 Code", false],
      ["broken", true],
      ["linear", true],
      ["alpha", false],
      ["docs", false],
      ["zeta", true],
      ["slow", false],
      ["off", false],
    ]);
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
});

describe("threadExtensionsInventoryNote", () => {
  it("does not claim a provider reported nothing when its MCP servers are live", () => {
    expect(threadExtensionsInventoryNote("available", true)).toBeNull();
    expect(threadExtensionsInventoryNote("unsupported")).toBe(
      "This provider doesn't report what it loaded, so only what this thread used is listed.",
    );
    expect(threadExtensionsInventoryNote("unsupported", true)).toBe(
      "This provider reports only its MCP servers, so the other sections list only what this thread used.",
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
