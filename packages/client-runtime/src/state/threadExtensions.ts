/**
 * How web and mobile present a thread's skills, plugins, MCP servers and
 * agents: what its turns used, merged with what the active provider session
 * loaded. The data comes from `orchestration.getThreadExtensions`.
 */
import type {
  OrchestrationV2ThreadExtensions,
  OrchestrationV2ThreadExtensionUse,
  OrchestrationV2ThreadInventoryStatus,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { isT3McpServerName } from "@t3tools/shared/t3McpToolPresentation";
import * as DateTime from "effect/DateTime";

import {
  resolveProviderSkillSourceKind,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
  type ProviderSkillSourceKind,
} from "../providerSkills.ts";
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
  /** Skills: what it does, from the provider's skill or else its slash command. */
  readonly description?: string;
  /** Skills: where the matching provider skill lives. Unset without a match. */
  readonly sourceKind?: ProviderSkillSourceKind;
  /** Skills: the source it groups under: its plugin, Project, Repo, Personal, App, System or Other. */
  readonly sourceLabel?: string;
  /** Skills: false when switched off in the provider's settings. Unset without a match. */
  readonly enabled?: boolean;
  /** Skills: who may start it. Unset without a match. */
  readonly invocation?: "anyone" | "user-only" | "agent-only";
  /** Skills: the matching provider skill's file. */
  readonly path?: string;
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

/** The section order on every surface. */
export const THREAD_EXTENSION_SECTION_ORDER = [
  "mcpServers",
  "skills",
  "plugins",
  "agents",
] as const satisfies ReadonlyArray<ThreadExtensionSectionKey>;

/** A section's title, and the nouns its counts and searches use. */
export const THREAD_EXTENSION_SECTION_TITLES: Readonly<
  Record<
    ThreadExtensionSectionKey,
    { readonly title: string; readonly singular: string; readonly plural: string }
  >
> = {
  mcpServers: { title: "MCP servers", singular: "MCP server", plural: "MCP servers" },
  skills: { title: "Skills", singular: "skill", plural: "skills" },
  plugins: { title: "Plugins", singular: "plugin", plural: "plugins" },
  agents: { title: "Agents", singular: "agent", plural: "agents" },
};

/** A group of rows inside a section, such as "Used in this thread" or a plugin's skills. */
export interface ThreadExtensionGroup<Row> {
  /** Unique across sections, to remember the user's toggle by. */
  readonly id: string;
  readonly label: string;
  readonly rows: ReadonlyArray<Row>;
  /** "18", "2 of 18 used", or a problem count such as "2 failed · 1 needs sign-in". */
  readonly countLabel: string;
  readonly tone: "neutral" | "warning";
  readonly expandedByDefault: boolean;
}

/** Groups past this many rows start collapsed, except "Used in this thread" and "Needs attention". */
const GROUP_PREVIEW_LIMIT = 8;

/** The thread's provider as the extensions view reads it. */
export interface ThreadExtensionsProvider {
  readonly driver: ServerProvider["driver"];
  /** For the thread's folder, else the machine-level list. */
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

/**
 * The thread's provider (its runtime instance first), with the skills and
 * slash commands it reports for `cwd`. Null when the instance is unknown.
 */
export function threadExtensionsProvider(
  providers: ReadonlyArray<ServerProvider>,
  shell: {
    readonly providerInstanceId: string;
    readonly runtime: { readonly providerInstanceId: string } | null;
  } | null,
  cwd: string | null,
): ThreadExtensionsProvider | null {
  const instanceId = shell?.runtime?.providerInstanceId ?? shell?.providerInstanceId;
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  if (provider === undefined) return null;
  return {
    driver: provider.driver,
    skills: resolveProviderSkillsForCwd(provider, cwd),
    slashCommands: resolveProviderSlashCommandsForCwd(provider, cwd),
  };
}

/**
 * How to start a skill from the composer: `/name` for Claude, `$name`
 * elsewhere. Null when the user can't: it is off or only the agent may start it.
 */
export function skillStartText(
  row: Pick<ThreadExtensionRow, "name" | "enabled" | "invocation">,
  driver: string | null,
): string | null {
  if (row.enabled === false || row.invocation === "agent-only") return null;
  return `${driver === "claudeAgent" ? "/" : "$"}${row.name}`;
}

export interface SkillStateBadge {
  readonly label: "Off" | "Only you" | "Only the agent";
  /** The badge as a plain sentence, for the expanded row. */
  readonly sentence: string;
}

/** What limits a skill, from its provider skill. Empty when nothing does or nothing matched. */
export function skillStateBadges(row: ThreadExtensionRow): ReadonlyArray<SkillStateBadge> {
  const badges: SkillStateBadge[] = [];
  if (row.enabled === false) {
    badges.push({
      label: "Off",
      sentence: "Turned off in the provider's settings, so it won't run.",
    });
  }
  if (row.invocation === "user-only") {
    badges.push({
      label: "Only you",
      sentence: "Only you can start it. The agent won't use it on its own.",
    });
  }
  if (row.invocation === "agent-only") {
    badges.push({
      label: "Only the agent",
      sentence: "Only the agent can start it. It isn't in the / menu.",
    });
  }
  return badges;
}

function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "1 use" or "3 uses"; null for something never used. */
export function threadExtensionUsesLabel(count: number): string | null {
  return count === 0 ? null : countOf(count, "use");
}

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

/** Statuses that need the user: failed, then needing sign-in, in that order. */
const MCP_PROBLEM_STATUSES = ["failed", "needs-auth"];

/** "2 failed · 1 needs sign-in" for these servers, or null when none has a problem. */
function mcpProblemsLabel(rows: ReadonlyArray<ThreadExtensionRow>): string | null {
  const failed = rows.filter((row) => row.status === "failed").length;
  const signIn = rows.filter((row) => row.status === "needs-auth").length;
  const parts = [
    ...(failed === 0 ? [] : [`${failed} failed`]),
    ...(signIn === 0 ? [] : [countOf(signIn, "needs sign-in", "need sign-in")]),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * Where an MCP server comes from, in words: Built in, its plugin, or its
 * config scope (user reads Personal). An unknown scope reads as reported.
 */
export function mcpServerSourceLabel(
  source: string | undefined,
  plugin: string | null,
  builtIn: boolean,
): string | null {
  if (builtIn) return "Built in";
  if (plugin !== null) return plugin;
  switch (source) {
    case undefined:
      return null;
    case "user":
      return "Personal";
    case "project":
      return "Project";
    case "local":
      return "Local";
    case "claudeai":
      return "claude.ai";
    case "sdk":
      return "SDK";
    default:
      return source;
  }
}

/** Tool names a server row lists before "Show all". */
export const MCP_SERVER_TOOL_PREVIEW_LIMIT = 8;

/** An MCP row's meta after its status: "3 tools · 2 uses", or null with neither. */
export function mcpServerMetaLabel(
  row: Pick<ThreadExtensionRow, "availableTools" | "count">,
): string | null {
  const tools = row.availableTools?.length ?? 0;
  const parts = [
    ...(tools === 0 ? [] : [countOf(tools, "tool")]),
    ...(row.count === 0 ? [] : [countOf(row.count, "use")]),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}

export interface McpServerRowView {
  readonly row: ThreadExtensionRow;
  /** "T3 Code" for T3's own server, else the name without its plugin or `claude.ai ` prefix. */
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
}

/**
 * The MCP section's rows with what each may do; `mcpServerGroups` orders
 * them. Reconnect needs a server that answers controlMcpServer, the operate
 * grant, a live status list (a snapshot has no session to act on) and a
 * provider that reconnects.
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

  return [...section.used, ...section.unused].map((row): McpServerRowView => {
    const builtIn = isT3McpServerName(row.name);
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
      label: builtIn
        ? "T3 Code"
        : row.source === "claudeai"
          ? // The claude.ai badge already says where the connector comes from.
            row.name.replace(/^claude\.ai /, "")
          : threadExtensionDisplayName(row),
      builtIn,
      badge: mcpServerSourceLabel(row.source, row.plugin, builtIn),
      statusLabel: mcpServerStatusLabel(row.status),
      tone: mcpServerStatusTone(row.status),
      hint,
      reconnect,
      hasDetail:
        row.error !== undefined ||
        hint !== null ||
        (row.availableTools?.length ?? 0) > 0 ||
        reconnect !== null,
    };
  });
}

/**
 * MCP rows by status: Needs attention (failed, then needs sign-in),
 * Connected, Not connected, and Used in this thread for servers the provider
 * reported no status for. In each, T3's own server comes first, then used
 * servers most recent first, then the rest by label.
 */
export function mcpServerGroups(
  views: ReadonlyArray<McpServerRowView>,
): ReadonlyArray<ThreadExtensionGroup<McpServerRowView>> {
  const problemRank = (view: McpServerRowView) =>
    MCP_PROBLEM_STATUSES.indexOf(view.row.status ?? "");
  const sorted = [...views].sort(
    (left, right) =>
      Number(right.builtIn) - Number(left.builtIn) ||
      problemRank(left) - problemRank(right) ||
      byRecentUse(left.row, right.row) ||
      left.label.localeCompare(right.label),
  );
  const rowsWhere = (test: (status: string | undefined) => boolean) =>
    sorted.filter((view) => test(view.row.status));
  const attention = rowsWhere((status) => MCP_PROBLEM_STATUSES.includes(status ?? ""));
  const connected = rowsWhere((status) => status === "connected");
  const notConnected = rowsWhere(
    (status) =>
      status !== undefined && status !== "connected" && !MCP_PROBLEM_STATUSES.includes(status),
  );
  const used = rowsWhere((status) => status === undefined);
  return [
    extensionGroup(
      "mcpServers:attention",
      "Needs attention",
      attention,
      mcpProblemsLabel(attention.map((view) => view.row)) ?? "",
      // What matters most here, so it never starts hidden behind its own size.
      { tone: "warning", alwaysOpen: true },
    ),
    // Status is the question here, so these counts leave usage to the rows.
    extensionGroup("mcpServers:connected", "Connected", connected, `${connected.length}`),
    extensionGroup(
      "mcpServers:not-connected",
      "Not connected",
      notConnected,
      `${notConnected.length}`,
    ),
    extensionGroup("mcpServers:used", "Used in this thread", used, `${used.length}`, {
      alwaysOpen: true,
    }),
  ].filter((group) => group.rows.length > 0);
}

function extensionGroup<Row>(
  id: string,
  label: string,
  rows: ReadonlyArray<Row>,
  countLabel: string,
  options: { readonly tone?: "neutral" | "warning"; readonly alwaysOpen?: boolean } = {},
): ThreadExtensionGroup<Row> {
  return {
    id,
    label,
    rows,
    countLabel,
    tone: options.tone ?? "neutral",
    expandedByDefault: options.alwaysOpen === true || rows.length <= GROUP_PREVIEW_LIMIT,
  };
}

/** "18", or "2 of 18 used" once something in them was used. */
function threadExtensionGroupCountLabel(rows: ReadonlyArray<ThreadExtensionRow>): string {
  const used = rows.filter((row) => row.count > 0).length;
  return used > 0 ? `${used} of ${rows.length} used` : `${rows.length}`;
}

const SKILL_SOURCE_LABELS: Readonly<Record<ProviderSkillSourceKind, string>> = {
  project: "Project",
  repo: "Repo",
  personal: "Personal",
  app: "App",
  system: "System",
  other: "Other",
};
/** Source groups in order; plugins sit between Personal and App. */
const SOURCE_GROUP_ORDER = ["project", "repo", "personal", "plugin", "app", "system", "other"];

/**
 * A section's groups. Used in this thread comes first, most recent first;
 * used rows also stay in their source group so its counts are whole. Skills
 * then group by source (Project, Repo, Personal, plugins A–Z, App, System,
 * Other), agents by plugin and then Other, and plugins under Installed.
 */
export function threadExtensionGroups(
  key: "skills" | "plugins" | "agents",
  section: ThreadExtensionSection,
): ReadonlyArray<ThreadExtensionGroup<ThreadExtensionRow>> {
  const used = extensionGroup(
    `${key}:used`,
    "Used in this thread",
    section.used,
    `${section.used.length}`,
    { alwaysOpen: true },
  );
  if (key === "plugins") {
    return [
      used,
      extensionGroup("plugins:installed", "Installed", section.unused, `${section.unused.length}`),
    ].filter((group) => group.rows.length > 0);
  }
  const sources = new Map<string, { kind: string; label: string; rows: ThreadExtensionRow[] }>();
  for (const row of [...section.used, ...section.unused].sort(byName)) {
    const kind = row.plugin === null ? (row.sourceKind ?? "other") : "plugin";
    const label = row.plugin ?? SKILL_SOURCE_LABELS[row.sourceKind ?? "other"];
    const id = row.plugin === null ? `${key}:${kind}` : `${key}:plugin:${row.plugin}`;
    const source = sources.get(id) ?? { kind, label, rows: [] };
    source.rows.push(row);
    sources.set(id, source);
  }
  const bySource = [...sources.entries()]
    .sort(
      ([, left], [, right]) =>
        SOURCE_GROUP_ORDER.indexOf(left.kind) - SOURCE_GROUP_ORDER.indexOf(right.kind) ||
        left.label.localeCompare(right.label),
    )
    .map(([id, source]) =>
      extensionGroup(id, source.label, source.rows, threadExtensionGroupCountLabel(source.rows)),
    );
  return section.used.length === 0 ? bySource : [used, ...bySource];
}

export interface PluginRowView {
  readonly row: ThreadExtensionRow;
  /** What it ships: "18 skills (2 used) · 1 MCP server · 3 agents". */
  readonly contents: string;
  /** Its MCP servers' problems, "1 failed · 1 needs sign-in", or null. Warning tone. */
  readonly problems: string | null;
}

/**
 * A plugin row with what it ships: skills and agents named `plugin:…` and
 * MCP servers named `plugin:<plugin>:…`. Pass unfiltered sections.
 */
export function pluginRowView(
  row: ThreadExtensionRow,
  sections: ThreadExtensionSections,
): PluginRowView {
  const all = (entry: ThreadExtensionSection) => [...entry.used, ...entry.unused];
  const servers = all(sections.mcpServers).filter((server) =>
    server.name.startsWith(`plugin:${row.name}:`),
  );
  const part = (rows: ReadonlyArray<ThreadExtensionRow>, noun: string) => {
    const used = rows.filter((entry) => entry.count > 0).length;
    return rows.length === 0
      ? []
      : [`${countOf(rows.length, noun)}${used === 0 ? "" : ` (${used} used)`}`];
  };
  const parts = [
    ...part(
      all(sections.skills).filter((skill) => skill.plugin === row.name),
      "skill",
    ),
    ...part(servers, "MCP server"),
    ...part(
      all(sections.agents).filter((agent) => agent.plugin === row.name),
      "agent",
    ),
  ];
  return {
    row,
    contents: parts.length === 0 ? "No skills, MCP servers or agents" : parts.join(" · "),
    problems: mcpProblemsLabel(servers),
  };
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
      return "Claude lists its plugins, agents and MCP servers after the session's first turn. Until then, skills come from your skill folders.";
    case "unsupported":
      return mcpServersLive
        ? "This provider reports only its MCP servers. Skills come from its skill folders; plugins and agents show once this thread uses them."
        : "This provider doesn't report what it loaded. Skills come from its skill folders; everything else shows once this thread uses it.";
  }
}

/** A section header's count: "3 of 211 used", or "211" when nothing is used. */
export function threadExtensionSectionCountLabel(section: ThreadExtensionSection): string {
  return threadExtensionGroupCountLabel([...section.used, ...section.unused]);
}

/** The search's status line: "Showing 48 of 262 skills". */
export function threadExtensionsMatchStatus(
  key: ThreadExtensionSectionKey,
  shown: number,
  total: number,
): string {
  const { singular, plural } = THREAD_EXTENSION_SECTION_TITLES[key];
  return `Showing ${shown} of ${countOf(total, singular, plural)}`;
}

export interface ThreadExtensionsSummaryPart {
  readonly text: string;
  readonly tone: "neutral" | "warning";
}

/**
 * The summary line: how fresh MCP statuses are, how many servers are
 * connected, how many need attention, and how many skills were used out of
 * those that can run. Pass unfiltered sections.
 */
export function threadExtensionsSummary(
  sections: ThreadExtensionSections,
  extensions: OrchestrationV2ThreadExtensions | null,
): ReadonlyArray<ThreadExtensionsSummaryPart> {
  const parts: ThreadExtensionsSummaryPart[] = [];
  const neutral = (text: string) => parts.push({ text, tone: "neutral" });
  const freshness = mcpServerStatusFreshness(extensions);
  if (freshness !== null) neutral(freshness);

  const servers = [...sections.mcpServers.used, ...sections.mcpServers.unused];
  if (servers.some((server) => server.status !== undefined)) {
    const connected = servers.filter((server) => server.status === "connected").length;
    neutral(`${connected} of ${countOf(servers.length, "MCP server")} connected`);
  } else if (servers.length > 0) {
    neutral(`${countOf(servers.length, "MCP server")} used`);
  }
  const attention = servers.filter((server) =>
    MCP_PROBLEM_STATUSES.includes(server.status ?? ""),
  ).length;
  if (attention > 0) {
    parts.push({ text: countOf(attention, "needs attention", "need attention"), tone: "warning" });
  }

  const skills = [...sections.skills.used, ...sections.skills.unused];
  const used = sections.skills.used.length;
  // The total is known once the session or the provider's skill folders list skills.
  const listed =
    sections.inventoryStatus === "available" ||
    skills.some((skill) => skill.sourceKind !== undefined);
  // A skill switched off can't run, so it only counts once used.
  const total = skills.filter((skill) => skill.count > 0 || skill.enabled !== false).length;
  if (listed && total > 0) {
    neutral(`${used} of ${countOf(total, "skill")} used`);
  } else if (used > 0) {
    neutral(`${countOf(used, "skill")} used`);
  }
  return parts;
}

/** What an empty section says: what is missing, why, and what to do. */
export function threadExtensionsEmptyState(
  key: ThreadExtensionSectionKey,
  inventoryStatus: OrchestrationV2ThreadInventoryStatus,
  mcpServersLive: boolean,
): { readonly title: string; readonly description: string } {
  const status = key === "mcpServers" && mcpServersLive ? "available" : inventoryStatus;
  if (key === "skills") {
    return status === "pending"
      ? {
          title: "No skills yet",
          description: "Claude lists its skills after the session's first turn.",
        }
      : {
          title: "No skills found",
          description:
            "None were found in this project's or your skill folders, and this thread hasn't used any. Add a skill, then restart the agent session.",
        };
  }
  const { plural } = THREAD_EXTENSION_SECTION_TITLES[key];
  switch (status) {
    case "pending":
      return {
        title: `No ${plural} yet`,
        description: `Claude lists its ${plural} after the session's first turn.`,
      };
    case "available":
      return {
        title: `No ${plural}`,
        description:
          key === "mcpServers"
            ? "This session didn't load any MCP servers. Add one in the provider's settings, then restart the agent session."
            : key === "plugins"
              ? "This session didn't load any plugins."
              : "This session didn't report any agents.",
      };
    case "unsupported":
      return {
        title: `No ${plural} used`,
        description:
          key === "mcpServers"
            ? "This provider doesn't report its MCP servers. They show here once this thread calls one."
            : key === "plugins"
              ? "This provider doesn't report its plugins. A plugin shows here once this thread uses something it ships."
              : "This provider doesn't report its agents. An agent shows here once this thread starts one.",
      };
  }
}

/**
 * The no-match state's `elsewhere`: the first other section, in display
 * order, with search matches. Null when no other section has any.
 */
export function sectionWithMatches(
  filtered: ThreadExtensionSections,
  current: ThreadExtensionSectionKey,
): { readonly key: ThreadExtensionSectionKey; readonly count: number } | null {
  for (const key of THREAD_EXTENSION_SECTION_ORDER) {
    const count = filtered[key].used.length + filtered[key].unused.length;
    if (key !== current && count > 0) return { key, count };
  }
  return null;
}

/**
 * What a section with no search matches says. `elsewhere` is another section
 * with matches, which the action then shows; without one it clears the search.
 */
export function threadExtensionsNoMatchState(
  key: ThreadExtensionSectionKey,
  query: string,
  elsewhere: { readonly key: ThreadExtensionSectionKey; readonly count: number } | null,
): {
  readonly title: string;
  readonly description: string;
  readonly action: {
    readonly label: string;
    readonly showSection: ThreadExtensionSectionKey | null;
  };
} {
  const title = `No ${THREAD_EXTENSION_SECTION_TITLES[key].plural} match "${query.trim()}"`;
  if (elsewhere === null || elsewhere.count === 0) {
    return {
      title,
      description: "Search looks at names, descriptions, plugins and statuses. Try a shorter word.",
      action: { label: "Clear search", showSection: null },
    };
  }
  const section = THREAD_EXTENSION_SECTION_TITLES[elsewhere.key].title;
  return {
    title,
    description: `Found ${elsewhere.count} in ${section}.`,
    action: { label: `Show ${section}`, showSection: elsewhere.key },
  };
}

/** Everything a search term may match on a row, lowercased. */
function threadExtensionSearchText(row: ThreadExtensionRow): string {
  return [
    row.name,
    row.plugin,
    row.description,
    row.sourceLabel ?? mcpServerSourceLabel(row.source, row.plugin, isT3McpServerName(row.name)),
    ...skillStateBadges(row).map((badge) => badge.label),
    mcpServerStatusLabel(row.status),
    ...(row.availableTools ?? []),
    ...(row.tools ?? []).map((tool) => tool.name),
  ]
    .join("\n")
    .toLowerCase();
}

/**
 * The rows matching a search in every section: each whitespace-separated term
 * must appear, case-insensitively, in the row's name, plugin, description,
 * source, state badges, MCP status or tool names. A blank query returns the
 * sections unchanged.
 */
export function filterThreadExtensionSections(
  sections: ThreadExtensionSections,
  query: string,
): ThreadExtensionSections {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return sections;
  const matches = (row: ThreadExtensionRow) => {
    const text = threadExtensionSearchText(row);
    return terms.every((term) => text.includes(term));
  };
  const filter = (entry: ThreadExtensionSection): ThreadExtensionSection => ({
    used: entry.used.filter(matches),
    unused: entry.unused.filter(matches),
  });
  return withEmptiness(
    {
      skills: filter(sections.skills),
      plugins: filter(sections.plugins),
      mcpServers: filter(sections.mcpServers),
      agents: filter(sections.agents),
    },
    sections.inventoryStatus,
  );
}

function withEmptiness(
  sections: Pick<ThreadExtensionSections, ThreadExtensionSectionKey>,
  inventoryStatus: OrchestrationV2ThreadInventoryStatus,
): ThreadExtensionSections {
  const isEmpty = THREAD_EXTENSION_SECTION_ORDER.every(
    (key) => sections[key].used.length === 0 && sections[key].unused.length === 0,
  );
  return { ...sections, inventoryStatus, isEmpty };
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

function byName(left: ThreadExtensionRow, right: ThreadExtensionRow): number {
  return left.name.localeCompare(right.name);
}

function section(
  used: ReadonlyArray<ThreadExtensionRow>,
  loaded: ReadonlyArray<ThreadExtensionRow>,
): ThreadExtensionSection {
  const usedNames = new Set(used.map((row) => row.name));
  return {
    used: [...used].sort(byRecentUse),
    unused: loaded.filter((row) => !usedNames.has(row.name)).sort(byName),
  };
}

/** Skill names match the way the composer dedupes them. */
function skillKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The first entry per skill key. */
function bySkillKey<A extends { readonly name: string }>(
  entries: ReadonlyArray<A>,
): ReadonlyMap<string, A> {
  const byKey = new Map<string, A>();
  for (const entry of entries) {
    if (!byKey.has(skillKey(entry.name))) byKey.set(skillKey(entry.name), entry);
  }
  return byKey;
}

/**
 * The skills section: what the thread used, what the session loaded and what
 * the provider's skill folders hold (switched-off ones too), each joined by
 * name with the provider skill and the slash command that describe it. A
 * slash command alone never makes a row, so built-in commands stay out.
 */
function skillsSection(
  used: ReadonlyArray<ThreadExtensionRow>,
  inventorySkills: ReadonlyArray<string>,
  provider: ThreadExtensionsProvider | null,
): ThreadExtensionSection {
  const providerSkills = bySkillKey(provider?.skills ?? []);
  const commands = bySkillKey(provider?.slashCommands ?? []);
  const join = (row: ThreadExtensionRow): ThreadExtensionRow => {
    const skill = providerSkills.get(skillKey(row.name));
    const description =
      skill?.shortDescription ??
      skill?.description ??
      commands.get(skillKey(row.name))?.description;
    const sourceKind = skill === undefined ? undefined : resolveProviderSkillSourceKind(skill);
    return {
      ...row,
      sourceLabel: row.plugin ?? SKILL_SOURCE_LABELS[sourceKind ?? "other"],
      ...(description === undefined ? {} : { description }),
      ...(skill === undefined || sourceKind === undefined
        ? {}
        : {
            sourceKind,
            enabled: skill.enabled,
            invocation:
              skill.userInvocable === false
                ? "agent-only"
                : skill.userInvocationOnly === true
                  ? "user-only"
                  : "anyone",
            path: skill.path,
          }),
    };
  };
  const usedKeys = new Set(used.map((row) => skillKey(row.name)));
  const loaded = bySkillKey([
    ...inventorySkills.map((name) => ({ name })),
    ...providerSkills.values(),
  ]);
  return section(
    used.map(join),
    [...loaded.values()]
      .filter((entry) => !usedKeys.has(skillKey(entry.name)))
      .map((entry) => join(unusedRow(entry.name, pluginOfName(entry.name)))),
  );
}

/**
 * Merges what the thread used with what its session loaded, section by
 * section. Skills also take in the provider's own skills for the thread's
 * folder, with their descriptions, sources and states.
 */
export function threadExtensionSections(
  extensions: OrchestrationV2ThreadExtensions | null | undefined,
  provider: ThreadExtensionsProvider | null = null,
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

  return withEmptiness(
    {
      skills: skillsSection(usedOf("skill"), inventory?.skills ?? [], provider),
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
    },
    extensions?.inventoryStatus ?? "unsupported",
  );
}
