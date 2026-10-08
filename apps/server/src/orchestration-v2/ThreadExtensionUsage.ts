/**
 * Which skills, MCP servers and named agents a thread used, derived from its
 * persisted turn items. Clients only hold a window of a long thread's items,
 * so the server derives this from the projection store for the whole thread.
 *
 * @module orchestration-v2/ThreadExtensionUsage
 */
import type {
  OrchestrationV2ProviderInventory,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadExtensionKind,
  OrchestrationV2ThreadExtensionUse,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { resolveT3McpToolName } from "@t3tools/shared/t3McpToolPresentation";
import * as DateTime from "effect/DateTime";

interface ThreadExtensionUsageItemBase {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly runId: RunId | null;
  /** The item's start, else its last update. */
  readonly at: DateTime.Utc;
}

/** One persisted turn item, reduced to the fields usage derivation reads. */
export type ThreadExtensionUsageItem =
  | (ThreadExtensionUsageItemBase & {
      readonly type: "tool";
      readonly toolName: string;
      /** A Claude `Skill` call's `input.skill`. */
      readonly skill: string | null;
      /** The item's `toolSource`, which MCP presentation sets to `mcp:<server>`. */
      readonly sourceKey: string | null;
    })
  | (ThreadExtensionUsageItemBase & {
      readonly type: "prompt";
      readonly text: string;
    })
  | (ThreadExtensionUsageItemBase & {
      readonly type: "agent";
      readonly agentType: string;
    });

/**
 * The usage item a persisted turn item's fields make, or undefined when it
 * cannot use a skill, MCP server or named agent.
 */
export function threadExtensionUsageItem(row: {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly runId: RunId | null;
  readonly at: DateTime.Utc;
  readonly type: string;
  readonly toolName: string | null;
  readonly skill: string | null;
  readonly sourceKey: string | null;
  readonly text: string | null;
  readonly agentType: string | null;
}): ThreadExtensionUsageItem | undefined {
  const base = { threadId: row.threadId, itemId: row.itemId, runId: row.runId, at: row.at };
  switch (row.type) {
    case "dynamic_tool":
      return row.toolName === null
        ? undefined
        : {
            ...base,
            type: "tool",
            toolName: row.toolName,
            skill: row.toolName === "Skill" ? row.skill : null,
            sourceKey: row.sourceKey,
          };
    case "user_message":
      return row.text === null ? undefined : { ...base, type: "prompt", text: row.text };
    case "subagent":
      return row.agentType === null
        ? undefined
        : { ...base, type: "agent", agentType: row.agentType };
    default:
      return undefined;
  }
}

/** Usage items of decoded projection records; the SQL store reads the same fields directly. */
export function threadExtensionUsageItemsFromProjection(input: {
  readonly threadId: ThreadId;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly childTurnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
}): ReadonlyArray<ThreadExtensionUsageItem> {
  const agentTypes = new Map(
    input.subagents.flatMap((subagent) =>
      subagent.agentType === undefined ? [] : [[subagent.id, subagent.agentType] as const],
    ),
  );
  return [
    ...input.turnItems.filter((item) => item.threadId === input.threadId),
    ...input.childTurnItems.filter((item) => item.type === "dynamic_tool"),
  ].flatMap((item) => {
    const usage = threadExtensionUsageItem({
      threadId: item.threadId,
      itemId: item.id,
      runId: item.runId,
      at: item.startedAt ?? item.updatedAt,
      type: item.type,
      toolName: item.type === "dynamic_tool" ? item.toolName : null,
      skill:
        item.type === "dynamic_tool" &&
        typeof item.input === "object" &&
        item.input !== null &&
        typeof Reflect.get(item.input, "skill") === "string"
          ? (Reflect.get(item.input, "skill") as string)
          : null,
      sourceKey: item.toolSource?.key ?? null,
      text: item.type === "user_message" ? item.text : null,
      agentType: item.type === "subagent" ? (agentTypes.get(item.subagentId) ?? null) : null,
    });
    return usage === undefined ? [] : [usage];
  });
}

const MAX_USED_ENTRIES = 200;
const MAX_MCP_TOOLS = 20;
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/u;
const LEADING_SLASH_COMMAND = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/u;
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/iu;

interface UsageAccumulator {
  readonly kind: OrchestrationV2ThreadExtensionKind;
  name: string;
  plugin: string | null;
  count: number;
  lastUsedAt: DateTime.Utc;
  lastItem: { readonly threadId: ThreadId; readonly itemId: TurnItemId };
  readonly tools: Map<string, number>;
}

function pluginOfName(name: string): string | null {
  const separator = name.indexOf(":");
  return separator > 0 ? name.slice(0, separator) : null;
}

function skillName(value: string): string | undefined {
  const name = value.trim().replace(/^\//u, "");
  return NAME_PATTERN.test(name) ? name : undefined;
}

/** Claude names a server's tools `mcp__<server>__<tool>` after replacing other characters with `_`. */
function claudeMcpServerKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/gu, "_").toLowerCase();
}

function mcpCall(
  toolName: string,
  sourceKey: string | null,
): { readonly server: string; readonly tool: string } | undefined {
  const t3Tool = resolveT3McpToolName(toolName);
  if (t3Tool !== null) return { server: "t3-code", tool: t3Tool };
  const qualified = MCP_TOOL_NAME.exec(toolName);
  if (qualified?.[1] && qualified[2]) return { server: qualified[1], tool: qualified[2] };
  if (sourceKey?.startsWith("mcp:") !== true) return undefined;
  // Codex and ACP adapters name an MCP call `<server>.<tool>`.
  const server = sourceKey.slice("mcp:".length);
  if (server.length === 0) return undefined;
  const prefix = `${server}.`;
  const tool = toolName.toLowerCase().startsWith(prefix.toLowerCase())
    ? toolName.slice(prefix.length)
    : toolName;
  return { server, tool };
}

/** A `plugin:name` form, which neither a built-in command nor a shell variable takes. */
function isNamespacedSkill(name: string): boolean {
  return pluginOfName(name) !== null && !name.endsWith(":");
}

/**
 * Skill names a prompt invokes: a leading `/name`, and `$name` mentions
 * anywhere. Names must be known skills; without the session's skill list a
 * bare `/name` may be a built-in command and a bare `$name` a shell variable,
 * so only plugin-namespaced forms count.
 */
function promptSkillNames(text: string, knownSkills: ReadonlySet<string>): ReadonlySet<string> {
  const names = new Set<string>();
  const invokes = (name: string) => knownSkills.has(name) || isNamespacedSkill(name);
  const slash = LEADING_SLASH_COMMAND.exec(text)?.[1];
  if (slash !== undefined && invokes(slash)) names.add(slash);
  for (const match of text.matchAll(SKILL_MENTION_PATTERN)) {
    const name = match[2];
    if (name !== undefined && invokes(name)) names.add(name);
  }
  return names;
}

/**
 * Skills, MCP servers and named agents the items used, most recent first.
 * A prompt that names a skill and the Skill call it leads to in the same run
 * count once. `inventory` supplies known skill names and MCP server names.
 */
export function deriveThreadExtensionUsage(
  items: ReadonlyArray<ThreadExtensionUsageItem>,
  inventory: OrchestrationV2ProviderInventory | null,
): ReadonlyArray<OrchestrationV2ThreadExtensionUse> {
  // A prompt comes before the Skill call it leads to, even within the same instant.
  const ordered = items.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at) ||
      Number(left.type !== "prompt") - Number(right.type !== "prompt"),
  );
  const knownSkills = new Set(inventory?.skills ?? []);
  for (const item of ordered) {
    if (item.type !== "tool" || item.skill === null) continue;
    const name = skillName(item.skill);
    if (name !== undefined) knownSkills.add(name);
  }
  const inventoryServers = new Map(
    (inventory?.mcpServers ?? []).map((server) => [claudeMcpServerKey(server.name), server.name]),
  );

  const usage = new Map<string, UsageAccumulator>();
  const record = (
    kind: OrchestrationV2ThreadExtensionKind,
    key: string,
    name: string,
    plugin: string | null,
    item: ThreadExtensionUsageItem,
  ): UsageAccumulator => {
    const mapKey = `${kind}\u0000${key}`;
    const existing = usage.get(mapKey);
    if (existing !== undefined) {
      existing.count += 1;
      existing.lastUsedAt = item.at;
      existing.lastItem = { threadId: item.threadId, itemId: item.itemId };
      return existing;
    }
    const created: UsageAccumulator = {
      kind,
      name,
      plugin,
      count: 1,
      lastUsedAt: item.at,
      lastItem: { threadId: item.threadId, itemId: item.itemId },
      tools: new Map(),
    };
    usage.set(mapKey, created);
    return created;
  };

  // Skill invocations a prompt already counted, per run, still owed a Skill call.
  const promptedSkills = new Map<string, number>();
  for (const item of ordered) {
    if (item.type === "prompt") {
      for (const name of promptSkillNames(item.text, knownSkills)) {
        record("skill", name, name, pluginOfName(name), item);
        if (item.runId !== null) {
          const key = `${item.runId}\u0000${name}`;
          promptedSkills.set(key, (promptedSkills.get(key) ?? 0) + 1);
        }
      }
      continue;
    }
    if (item.type === "agent") {
      const name = item.agentType.trim();
      if (name.length > 0) record("agent", name, name, pluginOfName(name), item);
      continue;
    }
    if (item.skill !== null) {
      const name = skillName(item.skill);
      if (name === undefined) continue;
      const promptKey = item.runId === null ? null : `${item.runId}\u0000${name}`;
      const owed = promptKey === null ? 0 : (promptedSkills.get(promptKey) ?? 0);
      if (promptKey !== null && owed > 0) {
        promptedSkills.set(promptKey, owed - 1);
        continue;
      }
      record("skill", name, name, pluginOfName(name), item);
      continue;
    }
    const call = mcpCall(item.toolName, item.sourceKey);
    if (call === undefined) continue;
    const serverKey = claudeMcpServerKey(call.server);
    // Claude items name claude.ai connectors without their `claude_ai_` prefix.
    const inventoryName =
      inventoryServers.get(serverKey) ?? inventoryServers.get(`claude_ai_${serverKey}`);
    // Plugin servers are named `plugin:<plugin>:<server>`.
    const plugin = inventoryName?.startsWith("plugin:")
      ? pluginOfName(inventoryName.slice(7))
      : null;
    const name = inventoryName ?? call.server.replace(/^claude_ai_/u, "");
    const entry = record("mcp", serverKey, name, plugin, item);
    entry.tools.set(call.tool, (entry.tools.get(call.tool) ?? 0) + 1);
  }

  return [...usage.values()]
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.lastUsedAt) - DateTime.toEpochMillis(left.lastUsedAt),
    )
    .slice(0, MAX_USED_ENTRIES)
    .map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      plugin: entry.plugin,
      count: entry.count,
      lastUsedAt: entry.lastUsedAt,
      lastItem: entry.lastItem,
      ...(entry.kind === "mcp"
        ? {
            tools: [...entry.tools]
              .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
              .slice(0, MAX_MCP_TOOLS)
              .map(([name, count]) => ({ name, count })),
          }
        : {}),
    }));
}
