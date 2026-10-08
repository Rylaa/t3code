/**
 * How web and mobile present a thread's skills, plugins, MCP servers and
 * agents: what its turns used, merged with what the active provider session
 * loaded. The data comes from `orchestration.getThreadExtensions`.
 */
import type {
  OrchestrationV2ThreadExtensions,
  OrchestrationV2ThreadExtensionUse,
  OrchestrationV2ThreadInventoryStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { EnvironmentThreadShell } from "./models.ts";

export interface ThreadExtensionRow {
  readonly name: string;
  /** The plugin a `plugin:name` skill, agent or MCP server comes from. */
  readonly plugin: string | null;
  /** 0 for something loaded but not used. A plugin counts the uses of everything it ships. */
  readonly count: number;
  readonly lastUsedAt: DateTime.Utc | null;
  /** The latest use, to jump to. A subagent's own calls live in its child thread. */
  readonly lastItem: OrchestrationV2ThreadExtensionUse["lastItem"] | null;
  /** MCP servers: the provider's status, such as `connected`, `failed` or `needs-auth`. */
  readonly status?: string;
  /** MCP servers: the tools that were called, most used first. */
  readonly tools?: OrchestrationV2ThreadExtensionUse["tools"];
  /** Plugins: the version its manifest declares. */
  readonly version?: string;
}

export interface ThreadExtensionSection {
  /** Most recently used first. */
  readonly used: ReadonlyArray<ThreadExtensionRow>;
  /** Loaded in the session but not used in this thread, by name. */
  readonly unused: ReadonlyArray<ThreadExtensionRow>;
}

export interface ThreadExtensionSections {
  readonly skills: ThreadExtensionSection;
  readonly plugins: ThreadExtensionSection;
  readonly mcpServers: ThreadExtensionSection;
  readonly agents: ThreadExtensionSection;
  /** Whether the active provider session's loaded items are known (only Claude reports them). */
  readonly inventoryStatus: OrchestrationV2ThreadInventoryStatus;
  readonly isEmpty: boolean;
}

export type McpServerStatusTone = "ok" | "warning" | "error" | "neutral";

/** The tone an MCP server status reads in: connected, needs sign-in, failed, or other. */
export function mcpServerStatusTone(status: string | undefined): McpServerStatusTone {
  switch (status) {
    case "connected":
      return "ok";
    case "needs-auth":
      return "warning";
    case "failed":
      return "error";
    default:
      return "neutral";
  }
}

/**
 * The query revision for a thread. It changes when a run starts, changes
 * status or settles, and when the provider session changes, so an open panel
 * refetches at run boundaries instead of on every item or polling.
 */
export function threadExtensionsRevision(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "activeProviderThreadId">,
): string {
  const run = thread.latestRun;
  return [
    run?.runId ?? "",
    run?.status ?? "",
    run?.completedAt ?? "",
    thread.activeProviderThreadId ?? "",
  ].join(":");
}

/** What a panel says about loaded items it can't list, or null when it lists them. */
export function threadExtensionsInventoryNote(
  status: OrchestrationV2ThreadInventoryStatus,
): string | null {
  switch (status) {
    case "available":
      return null;
    case "pending":
      return "Loaded items appear after the next Claude turn.";
    case "unsupported":
      return "This provider doesn't report what it loaded, so only what this thread used is listed.";
  }
}

/**
 * A section header's counts. Used items need not be among the loaded ones,
 * so the two counts stay separate rather than summing to a loaded total.
 */
export function threadExtensionSectionCountLabel(section: ThreadExtensionSection): string {
  const { used, unused } = section;
  return unused.length > 0
    ? `${used.length} used · ${unused.length} unused`
    : `${used.length} used`;
}

/** What a panel's footer says it leaves out. */
export function threadExtensionsFootnotes(
  thread: Pick<EnvironmentThreadShell, "forkedFrom"> | null,
): ReadonlyArray<string> {
  return [
    "Calls made inside workflow agents aren't counted.",
    ...(thread?.forkedFrom == null
      ? []
      : ["Only this fork's own turns are counted, not the history it inherited."]),
  ];
}

/** A `plugin:name` entry reads as its own name beside the plugin badge. */
export function threadExtensionDisplayName(row: ThreadExtensionRow): string {
  if (row.plugin === null) return row.name;
  for (const prefix of [`plugin:${row.plugin}:`, `${row.plugin}:`]) {
    if (row.name.startsWith(prefix) && row.name.length > prefix.length) {
      return row.name.slice(prefix.length);
    }
  }
  return row.name;
}

function usedRow(use: OrchestrationV2ThreadExtensionUse): ThreadExtensionRow {
  return {
    name: use.name,
    plugin: use.plugin,
    count: use.count,
    lastUsedAt: use.lastUsedAt,
    lastItem: use.lastItem,
    ...(use.tools === undefined ? {} : { tools: use.tools }),
  };
}

function unusedRow(name: string, plugin: string | null): ThreadExtensionRow {
  return { name, plugin, count: 0, lastUsedAt: null, lastItem: null };
}

function pluginOfName(name: string): string | null {
  const separator = name.indexOf(":");
  return separator > 0 ? name.slice(0, separator) : null;
}

function byRecentUse(left: ThreadExtensionRow, right: ThreadExtensionRow): number {
  return (
    (right.lastUsedAt === null ? 0 : DateTime.toEpochMillis(right.lastUsedAt)) -
    (left.lastUsedAt === null ? 0 : DateTime.toEpochMillis(left.lastUsedAt))
  );
}

function section(
  used: ReadonlyArray<ThreadExtensionRow>,
  loaded: ReadonlyArray<ThreadExtensionRow>,
): ThreadExtensionSection {
  const usedNames = new Set(used.map((row) => row.name));
  return {
    used: [...used].sort(byRecentUse),
    unused: loaded
      .filter((row) => !usedNames.has(row.name))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/** Merges what the thread used with what its session loaded, section by section. */
export function threadExtensionSections(
  extensions: OrchestrationV2ThreadExtensions | null | undefined,
): ThreadExtensionSections {
  const used = extensions?.used ?? [];
  const inventory = extensions?.inventory ?? null;
  const usedOf = (kind: OrchestrationV2ThreadExtensionUse["kind"]) =>
    used.filter((use) => use.kind === kind).map(usedRow);

  const serverStatus = new Map(
    (inventory?.mcpServers ?? []).map((server) => [server.name, server.status]),
  );
  const withStatus = (row: ThreadExtensionRow): ThreadExtensionRow => {
    const status = serverStatus.get(row.name);
    return status === undefined ? row : { ...row, status };
  };

  // A plugin is used when anything it ships is.
  const pluginUses = new Map<string, ThreadExtensionRow>();
  for (const use of used) {
    if (use.plugin === null) continue;
    const current = pluginUses.get(use.plugin);
    const newer =
      current?.lastUsedAt == null ||
      DateTime.toEpochMillis(use.lastUsedAt) > DateTime.toEpochMillis(current.lastUsedAt);
    pluginUses.set(use.plugin, {
      name: use.plugin,
      plugin: null,
      count: (current?.count ?? 0) + use.count,
      lastUsedAt: newer ? use.lastUsedAt : (current?.lastUsedAt ?? null),
      lastItem: newer ? use.lastItem : (current?.lastItem ?? null),
    });
  }
  const pluginVersions = new Map(
    (inventory?.plugins ?? []).flatMap((plugin) =>
      plugin.version === undefined ? [] : [[plugin.name, plugin.version] as const],
    ),
  );
  const withVersion = (row: ThreadExtensionRow): ThreadExtensionRow => {
    const version = pluginVersions.get(row.name);
    return version === undefined ? row : { ...row, version };
  };

  const sections = {
    skills: section(
      usedOf("skill"),
      (inventory?.skills ?? []).map((name) => unusedRow(name, pluginOfName(name))),
    ),
    plugins: section(
      [...pluginUses.values()].map(withVersion),
      (inventory?.plugins ?? []).map((plugin) => withVersion(unusedRow(plugin.name, null))),
    ),
    mcpServers: section(
      usedOf("mcp").map(withStatus),
      (inventory?.mcpServers ?? []).map((server) =>
        withStatus(
          unusedRow(
            server.name,
            server.name.startsWith("plugin:") ? pluginOfName(server.name.slice(7)) : null,
          ),
        ),
      ),
    ),
    agents: section(
      usedOf("agent"),
      (inventory?.agents ?? []).map((name) => unusedRow(name, pluginOfName(name))),
    ),
  };
  const isEmpty = [sections.skills, sections.plugins, sections.mcpServers, sections.agents].every(
    (entry) => entry.used.length === 0 && entry.unused.length === 0,
  );
  return {
    ...sections,
    inventoryStatus: extensions?.inventoryStatus ?? "unsupported",
    isEmpty,
  };
}
