import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadExtensionUsage,
  type ThreadExtensionUsageItem,
} from "./ThreadExtensionUsage.ts";

const threadId = ThreadId.make("thread:root");
const runA = RunId.make("run:a");
const runB = RunId.make("run:b");
let nextItem = 0;

function at(second: number): DateTime.Utc {
  return DateTime.makeUnsafe(Date.UTC(2026, 9, 8, 12, 0, second));
}

function base(second: number, runId: RunId | null = runA, thread: ThreadId = threadId) {
  nextItem += 1;
  return { threadId: thread, itemId: TurnItemId.make(`item:${nextItem}`), runId, at: at(second) };
}

function tool(
  second: number,
  toolName: string,
  options: { skill?: string; sourceKey?: string; runId?: RunId | null; thread?: ThreadId } = {},
): ThreadExtensionUsageItem {
  return {
    ...base(second, options.runId === undefined ? runA : options.runId, options.thread),
    type: "tool",
    toolName,
    skill: options.skill ?? null,
    sourceKey: options.sourceKey ?? null,
  };
}

function prompt(
  second: number,
  text: string,
  runId: RunId | null = runA,
): ThreadExtensionUsageItem {
  return { ...base(second, runId), type: "prompt", text };
}

function agent(second: number, agentType: string): ThreadExtensionUsageItem {
  return { ...base(second), type: "agent", agentType };
}

const noInventory = null;

describe("deriveThreadExtensionUsage", () => {
  it("counts Skill calls with their plugin and latest use", () => {
    const first = tool(1, "Skill", { skill: "caveman:caveman-review" });
    const second = tool(5, "Skill", { skill: "caveman:caveman-review", runId: runB });
    const local = tool(3, "Skill", { skill: "/simplify" });

    const used = deriveThreadExtensionUsage([second, local, first], noInventory);

    expect(used).toEqual([
      {
        kind: "skill",
        name: "caveman:caveman-review",
        plugin: "caveman",
        count: 2,
        lastUsedAt: at(5),
        lastItem: { threadId, itemId: second.itemId },
      },
      {
        kind: "skill",
        name: "simplify",
        plugin: null,
        count: 1,
        lastUsedAt: at(3),
        lastItem: { threadId, itemId: local.itemId },
      },
    ]);
  });

  it("counts a skill the user invokes from the prompt once with the Skill call it starts", () => {
    const inventory = {
      skills: ["review", "caveman:compress"],
      plugins: [],
      mcpServers: [],
      agents: [],
    };
    const used = deriveThreadExtensionUsage(
      [
        prompt(1, "/review the diff"),
        tool(2, "Skill", { skill: "review" }),
        // A second call in the same run is a real second use.
        tool(3, "Skill", { skill: "review" }),
        prompt(4, "then $caveman:compress it, but leave $HOME and $20 alone", runB),
        prompt(5, " /review leading space is prose", RunId.make("run:c")),
      ],
      inventory,
    );

    expect(used.map(({ name, count, plugin }) => ({ name, count, plugin }))).toEqual([
      { name: "caveman:compress", count: 1, plugin: "caveman" },
      { name: "review", count: 2, plugin: null },
    ]);
  });

  it("only trusts plugin-namespaced prompt skills without a known skill list", () => {
    const used = deriveThreadExtensionUsage(
      [
        prompt(1, "/compact please"),
        prompt(2, "/caveman:caveman-review now"),
        // Shell variables on a provider without an inventory, such as Codex.
        prompt(3, "cd $repo && echo $file"),
        prompt(4, "use $frontend-design here, not $PATH"),
        prompt(5, "then $caveman:compress it"),
      ],
      noInventory,
    );

    expect(used.map((entry) => entry.name).toSorted()).toEqual([
      "caveman:caveman-review",
      "caveman:compress",
    ]);
  });

  it("still counts a bare prompt skill once a Skill call made it known", () => {
    const used = deriveThreadExtensionUsage(
      [tool(1, "Skill", { skill: "frontend-design" }), prompt(2, "again $frontend-design", runB)],
      noInventory,
    );

    expect(used.map(({ name, count }) => ({ name, count }))).toEqual([
      { name: "frontend-design", count: 2 },
    ]);
  });

  it("groups MCP calls by server across naming schemes and lists their tools", () => {
    const inventory = {
      skills: [],
      plugins: [{ name: "context7" }],
      mcpServers: [
        { name: "plugin:context7:context7", status: "connected", source: "plugin" },
        { name: "claude.ai Notion", status: "needs-auth" },
      ],
      agents: [],
    };
    const used = deriveThreadExtensionUsage(
      [
        tool(1, "mcp__plugin_context7_context7__resolve-library-id"),
        tool(2, "mcp__plugin_context7_context7__query-docs"),
        tool(3, "mcp__plugin_context7_context7__query-docs"),
        tool(4, "mcp__Notion__search"),
        tool(5, "mcp__t3-code__t3_thread_list"),
        tool(6, "t3-code.t3_thread_read"),
        // Codex names MCP calls `<server>.<tool>`; its presentation sets toolSource.
        tool(7, "linear.list_issues", { sourceKey: "mcp:linear" }),
        // Built-in tools are not extensions.
        tool(8, "Bash"),
      ],
      inventory,
    );

    expect(
      used.map(({ kind, name, plugin, count, tools }) => ({ kind, name, plugin, count, tools })),
    ).toEqual([
      {
        kind: "mcp",
        name: "linear",
        plugin: null,
        count: 1,
        tools: [{ name: "list_issues", count: 1 }],
      },
      {
        kind: "mcp",
        name: "t3-code",
        plugin: null,
        count: 2,
        tools: [
          { name: "t3_thread_list", count: 1 },
          { name: "t3_thread_read", count: 1 },
        ],
      },
      {
        kind: "mcp",
        name: "claude.ai Notion",
        plugin: null,
        count: 1,
        tools: [{ name: "search", count: 1 }],
      },
      {
        kind: "mcp",
        name: "plugin:context7:context7",
        plugin: "context7",
        count: 3,
        tools: [
          { name: "query-docs", count: 2 },
          { name: "resolve-library-id", count: 1 },
        ],
      },
    ]);
  });

  it("counts named subagents, including plugin agents", () => {
    const used = deriveThreadExtensionUsage(
      [agent(1, "Explore"), agent(2, "mobile-team:ios-dev"), agent(3, "Explore")],
      noInventory,
    );

    expect(used.map(({ kind, name, plugin, count }) => ({ kind, name, plugin, count }))).toEqual([
      { kind: "agent", name: "Explore", plugin: null, count: 2 },
      { kind: "agent", name: "mobile-team:ios-dev", plugin: "mobile-team", count: 1 },
    ]);
  });

  it("includes calls from a subagent's child thread and points at them", () => {
    const childThreadId = ThreadId.make("thread:child");
    const childCall = tool(2, "Skill", { skill: "simplify", runId: null, thread: childThreadId });

    const [entry] = deriveThreadExtensionUsage([childCall], noInventory);

    expect(entry?.lastItem).toEqual({ threadId: childThreadId, itemId: childCall.itemId });
  });
});
