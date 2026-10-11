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
import { isT3McpServerName } from "@t3tools/shared/t3McpToolPresentation";
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
  /** MCP servers: where the definition came from, such as `user` or `plugin`. */
  readonly source?: string;
  /** MCP servers, live reads only: why the server failed. Untrusted plain text. */
  readonly error?: string;
  /** MCP servers, live reads only: the tools the server offers. */
  readonly availableTools?: ReadonlyArray<string>;
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

export type ThreadExtensionSectionKey = "skills" | "plugins" | "mcpServers" | "agents";

/** T3's own composer commands that open the extensions view, and the section each opens. */
export const THREAD_EXTENSIONS_COMMANDS = [
  { name: "mcp", section: "mcpServers", description: "Show MCP servers and their status" },
  { name: "skills", section: "skills", description: "Show skills, plugins and agents" },
] as const satisfies ReadonlyArray<{
  readonly name: string;
  readonly section: ThreadExtensionSectionKey;
  readonly description: string;
}>;

/**
 * The section a whole-message `/mcp` or `/skills` opens, or null. With
 * arguments (`/mcp reconnect x`) it stays an ordinary message to the provider.
 */
export function threadExtensionsCommandSection(prompt: string): ThreadExtensionSectionKey | null {
  const text = prompt.trim().toLowerCase();
  return THREAD_EXTENSIONS_COMMANDS.find((command) => text === `/${command.name}`)?.section ?? null;
}

/** A provider's own `/mcp` or `/skills` is hidden while T3 offers its built-in one. */
export function withoutThreadExtensionsCommands<T extends { readonly name: string }>(
  commands: ReadonlyArray<T>,
  offered: boolean,
): ReadonlyArray<T> {
  if (!offered) return commands;
  return commands.filter(
    (command) => !THREAD_EXTENSIONS_COMMANDS.some((builtIn) => builtIn.name === command.name),
  );
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
      // pending, disabled, unknown, or no status reported.
      return "neutral";
  }
}

/** The words for a status, so it never reads by color alone. Null when none was reported. */
export function mcpServerStatusLabel(status: string | undefined): string | null {
  switch (status) {
    case undefined:
      return null;
    case "connected":
      return "Connected";
    case "pending":
      return "Connecting";
    case "needs-auth":
      return "Needs sign-in";
    case "failed":
      return "Failed";
    case "disabled":
      return "Disabled";
    default:
      return "Unknown";
  }
}

/** Problems, listed right after T3's own server: failed, then needing sign-in. */
const MCP_PROBLEM_STATUSES = ["failed", "needs-auth"];
/** Unused servers after the used ones: working, connecting, switched off, then anything else. */
const MCP_STATUS_ORDER = ["connected", "pending", "disabled"];
const MCP_USED_RANK = MCP_PROBLEM_STATUSES.length + 1;

function mcpServerRank(view: McpServerRowView): number {
  if (view.builtIn) return 0;
  const problem = MCP_PROBLEM_STATUSES.indexOf(view.row.status ?? "");
  if (problem !== -1) return problem + 1;
  if (view.row.count > 0) return MCP_USED_RANK;
  const status = MCP_STATUS_ORDER.indexOf(view.row.status ?? "");
  return MCP_USED_RANK + 1 + (status === -1 ? MCP_STATUS_ORDER.length : status);
}

/** Tool names a server row lists before "Show all". */
export const MCP_SERVER_TOOL_PREVIEW_LIMIT = 8;

export interface McpServerRowView {
  readonly row: ThreadExtensionRow;
  /** "T3 Code" for T3's own server, else the name without its plugin prefix. */
  readonly label: string;
  readonly builtIn: boolean;
  /** Where the server comes from: Built in, its plugin, or its config scope. */
  readonly badge: string | null;
  readonly statusLabel: string | null;
  readonly tone: McpServerStatusTone;
  /** What the user can do about the status. */
  readonly hint: string | null;
  /** Null hides Reconnect; a reason shows it disabled. */
  readonly reconnect: { readonly disabledReason: string | null } | null;
  /** Whether the row expands: an error, a hint, its tools or Reconnect. Last use shows on the row. */
  readonly hasDetail: boolean;
  /** Loaded but unused, neither T3's own nor a problem: a list may fold these away. */
  readonly foldable: boolean;
}

/**
 * The MCP section's rows: T3's own server pinned first, then problems, then
 * used servers most recent first, then the rest by status and name, with what
 * each row may do. Reconnect needs a server that answers controlMcpServer, the
 * operate grant, a live status list (a snapshot has no session to act on) and
 * a provider that reconnects.
 */
export function mcpServerRows(
  section: ThreadExtensionSection,
  context: {
    readonly live: boolean;
    readonly permitted: boolean;
    readonly config: {
      readonly environment: { readonly capabilities: { readonly threadMcpControl?: boolean } };
      readonly providers: ReadonlyArray<{ readonly instanceId: string; readonly driver: string }>;
    } | null;
    readonly shell: {
      readonly providerInstanceId: string;
      readonly runtime: {
        readonly providerInstanceId: string;
        /** The newest preparing, starting or running run, as the server's run-active check sees it. */
        readonly activeRunId: string | null;
      } | null;
    } | null;
  },
): ReadonlyArray<McpServerRowView> {
  const instanceId =
    context.shell?.runtime?.providerInstanceId ?? context.shell?.providerInstanceId;
  const isClaude =
    context.config?.providers.find((provider) => provider.instanceId === instanceId)?.driver ===
    "claudeAgent";
  // shortcut: only Claude reconnects in v1 and ThreadExtensions does not say which provider can;
  // read that from the server once it reports it.
  const canReconnect =
    context.config?.environment.capabilities.threadMcpControl === true &&
    context.permitted &&
    context.live &&
    isClaude;
  // latestRun is the newest run, which reads `queued` while a follow-up waits behind a live turn.
  const runActive = context.shell?.runtime?.activeRunId != null;

  return [...section.used, ...section.unused]
    .map((row): McpServerRowView => {
      const builtIn = isT3McpServerName(row.name);
      const problem = MCP_PROBLEM_STATUSES.includes(row.status ?? "");
      const hint =
        row.status !== "needs-auth"
          ? null
          : isClaude
            ? "Sign in from a terminal: run /mcp in Claude Code."
            : "Sign in to this server from the provider's own CLI.";
      const reconnect =
        !canReconnect || row.status === undefined || row.status === "disabled"
          ? null
          : {
              disabledReason: runActive
                ? "Wait for the current turn to finish, then try again."
                : null,
            };
      return {
        row,
        label: builtIn ? "T3 Code" : threadExtensionDisplayName(row),
        builtIn,
        badge: builtIn ? "Built in" : (row.plugin ?? row.source ?? null),
        statusLabel: mcpServerStatusLabel(row.status),
        tone: mcpServerStatusTone(row.status),
        hint,
        reconnect,
        hasDetail:
          row.error !== undefined ||
          hint !== null ||
          (row.availableTools?.length ?? 0) > 0 ||
          reconnect !== null,
        foldable: !builtIn && !problem && row.count === 0,
      };
    })
    .sort((left, right) => {
      const order = mcpServerRank(left) - mcpServerRank(right);
      // Used servers keep section.used's most-recent-first order; the sort is stable.
      return order !== 0 || mcpServerRank(left) === MCP_USED_RANK
        ? order
        : left.label.localeCompare(right.label);
    });
}

/** How current the MCP statuses are, or null when the session reported no servers. */
export function mcpServerStatusFreshness(
  extensions: OrchestrationV2ThreadExtensions | null | undefined,
): "Live status" | "As of session start" | null {
  if ((extensions?.inventory?.mcpServers.length ?? 0) === 0) return null;
  return extensions?.mcpServersLive === true ? "Live status" : "As of session start";
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
  mcpServersLive = false,
): string | null {
  switch (status) {
    case "available":
      return null;
    case "pending":
      return "Loaded items appear after the next Claude turn.";
    case "unsupported":
      return mcpServersLive
        ? "This provider reports only its MCP servers, so the other sections list only what this thread used."
        : "This provider doesn't report what it loaded, so only what this thread used is listed.";
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

/** A section opens when the thread used something in it; loaded-only sections start closed. */
export function threadExtensionSectionExpandedByDefault(section: ThreadExtensionSection): boolean {
  return section.used.length > 0;
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

  // T3's own server goes by its recorded use's name, `t3-code`, whatever the provider calls it
  // (OpenCode 2 lists `t3-code-<thread>`), so its uses and live status share one row.
  const mcpServers = (inventory?.mcpServers ?? []).map((server) =>
    isT3McpServerName(server.name) ? { ...server, name: "t3-code" } : server,
  );
  const servers = new Map(mcpServers.map((server) => [server.name, server]));
  const withStatus = (row: ThreadExtensionRow): ThreadExtensionRow => {
    const server = servers.get(row.name);
    if (server === undefined) return row;
    return {
      ...row,
      status: server.status,
      ...(server.source === undefined ? {} : { source: server.source }),
      ...(server.error === undefined ? {} : { error: server.error }),
      ...(server.tools === undefined ? {} : { availableTools: server.tools }),
    };
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
      mcpServers.map((server) =>
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
