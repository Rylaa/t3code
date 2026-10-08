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
  mcpServerStatusTone,
  threadExtensionDisplayName,
  threadExtensionSections,
  threadExtensionsRevision,
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
      ["connected", "needs-auth", "failed", "pending", undefined].map(mcpServerStatusTone),
    ).toEqual(["ok", "warning", "error", "neutral", "neutral"]);
  });
});
