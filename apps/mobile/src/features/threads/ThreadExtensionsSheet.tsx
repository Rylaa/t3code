/**
 * Skills & plugins sheet: the skills, plugins, MCP servers and agents a thread
 * used, from `orchestration.getThreadExtensions`, beside what the active
 * provider session loaded but did not use. Mobile's counterpart of the web
 * right panel's Skills & plugins surface; opened from the thread header.
 *
 * The composer's /mcp and /skills open it with that section first.
 *
 * The query is keyed by the thread's run boundaries, so an open sheet
 * refreshes when a run starts or settles instead of on every item or polling.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  MCP_SERVER_TOOL_PREVIEW_LIMIT,
  mcpServerRows,
  mcpServerStatusFreshness,
  threadExtensionDisplayName,
  threadExtensionSectionCountLabel,
  threadExtensionSectionExpandedByDefault,
  threadExtensionSections,
  threadExtensionsFootnotes,
  threadExtensionsInventoryNote,
  threadExtensionsRevision,
  type McpServerRowView,
  type McpServerStatusTone,
  type ThreadExtensionRow,
  type ThreadExtensionSection,
  type ThreadExtensionSectionKey,
} from "@t3tools/client-runtime/state/thread-extensions";
import type { EnvironmentId, OrchestrationV2ThreadExtensions, ThreadId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import * as Haptics from "expo-haptics";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { AccessibilityInfo, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadSheetFrame } from "./ThreadAgentsSheet";

/** Loaded-but-unused rows past this many start collapsed. */
const UNUSED_PREVIEW_LIMIT = 4;

const STATUS_DOT_CLASS = {
  ok: "bg-adaptive-emerald-600-400",
  warning: "bg-adaptive-amber-700-400",
  error: "bg-adaptive-rose-600-400",
  neutral: "bg-foreground-muted",
} as const satisfies Record<McpServerStatusTone, string>;

const SECTION_TITLE: Record<ThreadExtensionSectionKey, string> = {
  skills: "Skills",
  plugins: "Plugins",
  mcpServers: "MCP servers",
  agents: "Agents",
};
const SECTION_ORDER = ["skills", "plugins", "mcpServers", "agents"] as const;

type ExtensionsTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Listed first and open: the section /mcp or /skills asked for. */
  readonly focus?: ThreadExtensionSectionKey;
};

export function ThreadExtensionsSheet({ route }: StaticScreenProps<ExtensionsTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const openChildThread = (childThreadId: ThreadId) => {
    void Haptics.selectionAsync();
    // Replace rather than push, like the Agents sheet: the child thread
    // belongs in the workspace stack, not on top of this leaf sheet.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: target.environmentId,
        threadId: childThreadId,
      }),
    );
  };

  const content = (
    <ScrollView
      className="flex-1"
      // The iOS header is translucent and floats over this view; UIKit has to
      // inset the content or the first row sits underneath the title.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      <ThreadExtensionsContent
        environmentId={target.environmentId}
        threadId={target.threadId}
        focus={target.focus}
        onOpenThread={openChildThread}
      />
    </ScrollView>
  );

  return (
    <ThreadSheetFrame
      title="Skills & plugins"
      screenId="thread-extensions-sheet-native"
      onBack={() => navigation.goBack()}
    >
      {content}
    </ThreadSheetFrame>
  );
}

function ThreadExtensionsContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly focus: ThreadExtensionSectionKey | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, threadId } = props;
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const revision = shell === null ? null : threadExtensionsRevision(shell);
  const query = useEnvironmentQuery(
    orchestrationEnvironment.threadExtensions({
      environmentId,
      input: revision === null ? { threadId } : { threadId, revision },
    }),
  );

  // A new revision is a new query; keep showing the last result while it loads.
  const [retained, setRetained] = useState<{
    readonly threadId: ThreadId;
    readonly data: OrchestrationV2ThreadExtensions;
  } | null>(null);
  if (query.data !== null && retained?.data !== query.data) {
    setRetained({ threadId, data: query.data });
  }
  const data = query.data ?? (retained?.threadId === threadId ? retained.data : null);
  const sections = useMemo(() => threadExtensionSections(data), [data]);

  // Opening shows what the session reports now, not a read cached by an earlier visit.
  const refreshCached = useEffectEvent(() => {
    if (query.data !== null) query.refresh();
  });
  useEffect(() => refreshCached(), []);

  if (data === null) {
    return query.error === null ? (
      <Text className="pt-6 text-center text-sm text-foreground-muted">
        Loading skills and plugins…
      </Text>
    ) : (
      <View className="items-center gap-2 pt-6">
        <Text className="text-center text-sm font-t3-medium text-foreground">
          Couldn't load skills and plugins
        </Text>
        <Text className="text-center text-xs text-foreground-muted">{query.error}</Text>
        <Pressable
          accessibilityRole="button"
          className="min-h-11 justify-center px-3 active:opacity-60"
          onPress={query.refresh}
        >
          <Text className="text-sm font-t3-medium text-foreground">Retry</Text>
        </Pressable>
      </View>
    );
  }

  const providerNote = threadExtensionsInventoryNote(
    sections.inventoryStatus,
    data.mcpServersLive === true,
  );

  if (sections.isEmpty) {
    return (
      <View className="gap-2 px-4 pt-6">
        <Text className="text-center text-sm font-t3-medium text-foreground">
          No skills or plugins yet
        </Text>
        <Text className="text-center text-xs text-foreground-muted">
          {providerNote ??
            "Skills, plugins, MCP servers and agents show up here once the session loads them or the agent uses them."}
        </Text>
      </View>
    );
  }

  const freshness = mcpServerStatusFreshness(data);
  const renderSection = (key: ThreadExtensionSectionKey) =>
    key === "mcpServers" ? (
      <McpServerSection
        key={`${threadId}:${key}`}
        environmentId={environmentId}
        threadId={threadId}
        section={sections.mcpServers}
        live={data.mcpServersLive === true}
        initiallyExpanded={props.focus === key}
        onRefresh={query.refresh}
        onOpenThread={props.onOpenThread}
      />
    ) : (
      <ExtensionSection
        key={`${threadId}:${key}`}
        title={SECTION_TITLE[key]}
        section={sections[key]}
        initiallyExpanded={props.focus === key}
        threadId={threadId}
        onOpenThread={props.onOpenThread}
      />
    );

  return (
    <View className="gap-5 pt-2">
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
          {freshness === null ? "" : `MCP servers · ${freshness}`}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: query.isPending }}
          className="min-h-11 justify-center px-3 active:opacity-60"
          onPress={query.refresh}
        >
          <Text className="text-sm font-t3-medium text-foreground">
            {query.isPending ? "Refreshing…" : "Refresh"}
          </Text>
        </Pressable>
      </View>
      {props.focus === undefined ? null : renderSection(props.focus)}
      {SECTION_ORDER.filter((key) => key !== props.focus).map(renderSection)}
      <View className="gap-1">
        {providerNote === null ? null : (
          <Text className="text-xs text-foreground-muted">{providerNote}</Text>
        )}
        {threadExtensionsFootnotes(shell).map((note) => (
          <Text key={note} className="text-xs text-foreground-muted">
            {note}
          </Text>
        ))}
      </View>
    </View>
  );
}

function SectionHeader(props: {
  readonly title: string;
  readonly section: ThreadExtensionSection;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: props.expanded }}
      className="min-h-11 flex-row items-center gap-2 pb-1 active:opacity-60"
      onPress={() => {
        void Haptics.selectionAsync();
        props.onToggle();
      }}
    >
      <Text className="text-sm font-t3-bold text-foreground">{props.title}</Text>
      <View className="flex-1" />
      <Text className="text-xs tabular-nums text-foreground-muted">
        {threadExtensionSectionCountLabel(props.section)}
      </Text>
      <SymbolView
        name="chevron.down"
        size={12}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
        style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
      />
    </Pressable>
  );
}

function ExtensionSection(props: {
  readonly title: string;
  readonly section: ThreadExtensionSection;
  readonly initiallyExpanded: boolean;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { used, unused } = props.section;
  const collapsible = unused.length > UNUSED_PREVIEW_LIMIT;
  const [showUnused, setShowUnused] = useState(false);
  // Expansion follows the data until the user picks a side; the key resets it per thread.
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(
    props.initiallyExpanded ? true : null,
  );
  const expanded = expandedChoice ?? threadExtensionSectionExpandedByDefault(props.section);
  if (used.length === 0 && unused.length === 0) return null;

  const renderRow = (row: ThreadExtensionRow) => (
    <ExtensionRow
      key={row.name}
      row={row}
      threadId={props.threadId}
      onOpenThread={props.onOpenThread}
    />
  );

  return (
    <View>
      <SectionHeader
        title={props.title}
        section={props.section}
        expanded={expanded}
        onToggle={() => setExpandedChoice(!expanded)}
      />
      {expanded ? used.map(renderRow) : null}
      {expanded && (!collapsible || showUnused) ? unused.map(renderRow) : null}
      {expanded && collapsible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showUnused }}
          className="min-h-11 justify-center active:opacity-60"
          onPress={() => setShowUnused(!showUnused)}
        >
          <Text className="text-xs font-t3-medium text-foreground-muted">
            {showUnused ? "Hide unused" : `Show ${unused.length} loaded but unused`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function lastUsedLabel(lastUsedAt: DateTime.Utc): string {
  const elapsed = relativeTime(DateTime.formatIso(lastUsedAt));
  return elapsed === "<1m" ? "Last used just now" : `Last used ${elapsed} ago`;
}

function ExtensionRow(props: {
  readonly row: ThreadExtensionRow;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { row } = props;
  const used = row.count > 0;
  // A subagent's own calls live in its child thread; the row opens it.
  const subagentThreadId =
    row.lastItem !== null && row.lastItem.threadId !== props.threadId
      ? row.lastItem.threadId
      : null;
  const details = [
    row.lastUsedAt === null ? null : lastUsedLabel(row.lastUsedAt),
    (row.tools ?? []).map((tool) => `${tool.name} ×${tool.count}`).join(", ") || null,
  ].filter((part): part is string => part !== null);

  const body = (
    <View className="gap-0.5 border-b border-border-subtle py-2.5">
      <View className="flex-row items-center gap-2">
        <Text
          className={cn(
            "min-w-0 shrink text-sm",
            used ? "font-t3-medium text-foreground" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {threadExtensionDisplayName(row)}
        </Text>
        {row.plugin === null ? null : (
          <View className="shrink-0 rounded-md bg-subtle px-1.5 py-0.5">
            <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
              {row.plugin}
            </Text>
          </View>
        )}
        {row.version === undefined ? null : (
          <Text className="shrink-0 text-2xs text-foreground-muted">v{row.version}</Text>
        )}
        <View className="flex-1" />
        {used ? (
          <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
            Used ×{row.count}
          </Text>
        ) : null}
      </View>
      {details.length > 0 ? (
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {details.join(" · ")}
        </Text>
      ) : null}
    </View>
  );

  if (subagentThreadId === null) return body;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint="Last used in a subagent. Opens its thread."
      className="active:opacity-70"
      onPress={() => props.onOpenThread(subagentThreadId)}
    >
      {body}
    </Pressable>
  );
}

function McpServerSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly section: ThreadExtensionSection;
  readonly live: boolean;
  readonly initiallyExpanded: boolean;
  readonly onRefresh: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, threadId } = props;
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const config = useEnvironmentServerConfig(environmentId);
  const permitted = useAtomValue(
    orchestrationEnvironment.controlMcpServer.permissionAtom(environmentId),
  );
  const controlMcpServer = useAtomCommand(orchestrationEnvironment.controlMcpServer, {
    label: "reconnect MCP server",
    reportFailure: false,
  });
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(
    props.initiallyExpanded ? true : null,
  );
  const expanded = expandedChoice ?? threadExtensionSectionExpandedByDefault(props.section);
  if (props.section.used.length === 0 && props.section.unused.length === 0) return null;
  const rows = mcpServerRows(props.section, { live: props.live, permitted, config, shell });

  const announce = (message: string) => {
    setAnnouncement(message);
    AccessibilityInfo.announceForAccessibility(message);
  };
  const reconnect = async (view: McpServerRowView) => {
    if (reconnecting !== null) return;
    void Haptics.selectionAsync();
    setReconnecting(view.row.name);
    const result = await controlMcpServer({
      environmentId,
      input: { threadId, server: view.row.name, action: "reconnect" },
    });
    setReconnecting(null);
    if (result._tag === "Success") {
      announce(`Reconnected ${view.label}.`);
    } else {
      const error = squashAtomCommandFailure(result);
      announce(
        `${view.label}: ${error instanceof Error ? error.message : "Could not reconnect the MCP server."}`,
      );
    }
    props.onRefresh();
  };

  return (
    <View>
      <SectionHeader
        title={SECTION_TITLE.mcpServers}
        section={props.section}
        expanded={expanded}
        onToggle={() => setExpandedChoice(!expanded)}
      />
      {expanded
        ? rows.map((view) => (
            <McpServerRow
              key={view.row.name}
              view={view}
              threadId={threadId}
              reconnecting={reconnecting === view.row.name}
              onReconnect={() => void reconnect(view)}
              onOpenThread={props.onOpenThread}
            />
          ))
        : null}
      {announcement ? (
        <Text accessibilityLiveRegion="polite" className="pt-2 text-xs text-foreground-muted">
          {announcement}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One MCP server: a status dot beside the status in words, its origin and
 * tool count, expanding to its error, tools and Reconnect. Names, errors and
 * tool names are untrusted text, rendered as plain text only.
 */
function McpServerRow(props: {
  readonly view: McpServerRowView;
  readonly threadId: ThreadId;
  readonly reconnecting: boolean;
  readonly onReconnect: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { view } = props;
  const { row } = view;
  const [open, setOpen] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);
  const tools = row.availableTools ?? [];
  const calls = (row.tools ?? []).map((tool) => `${tool.name} ×${tool.count}`).join(", ");
  const subagentThreadId =
    row.lastItem !== null && row.lastItem.threadId !== props.threadId
      ? row.lastItem.threadId
      : null;
  const summary = [
    view.statusLabel,
    tools.length === 0 ? null : tools.length === 1 ? "1 tool" : `${tools.length} tools`,
    row.count > 0 ? `Used ×${row.count}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const header = (
    <>
      <View className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT_CLASS[view.tone])} />
      <Text
        className={cn(
          "min-w-0 shrink text-sm",
          row.count > 0 ? "font-t3-medium text-foreground" : "text-foreground-muted",
        )}
        numberOfLines={1}
      >
        {view.label}
      </Text>
      {view.badge === null ? null : (
        <View className="shrink-0 rounded-md bg-subtle px-1.5 py-0.5">
          <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
            {view.badge}
          </Text>
        </View>
      )}
      <View className="flex-1" />
      <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{summary}</Text>
    </>
  );

  return (
    <View className="border-b border-border-subtle">
      {view.hasDetail ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          className="min-h-11 flex-row items-center gap-2 py-2.5 active:opacity-70"
          onPress={() => {
            void Haptics.selectionAsync();
            setOpen(!open);
          }}
        >
          {header}
        </Pressable>
      ) : (
        <View className="min-h-11 flex-row items-center gap-2 py-2.5">{header}</View>
      )}
      {row.lastUsedAt === null && !calls && subagentThreadId === null ? null : (
        // Always in view, like the other sections' rows: what this thread did with the server.
        <View className="gap-1 pb-2.5 pl-4">
          {row.lastUsedAt === null ? null : (
            <Text className="text-xs text-foreground-muted">{lastUsedLabel(row.lastUsedAt)}</Text>
          )}
          {calls ? <Text className="text-xs text-foreground-muted">Called {calls}</Text> : null}
          {subagentThreadId === null ? null : (
            <Pressable
              accessibilityRole="link"
              className="min-h-11 justify-center active:opacity-60"
              onPress={() => props.onOpenThread(subagentThreadId)}
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                Open the subagent that used it last
              </Text>
            </Pressable>
          )}
        </View>
      )}
      {view.hasDetail && open ? (
        <View className="gap-1 pb-3 pl-4">
          {row.error === undefined ? null : (
            <Text selectable className="text-xs text-adaptive-rose-600-400">
              {row.error}
            </Text>
          )}
          {view.hint === null ? null : (
            <Text className="text-xs text-foreground-muted">{view.hint}</Text>
          )}
          {tools.length === 0 ? null : (
            <Text className="text-xs text-foreground-muted">
              {(showAllTools ? tools : tools.slice(0, MCP_SERVER_TOOL_PREVIEW_LIMIT)).join(", ")}
            </Text>
          )}
          <View className="flex-row flex-wrap items-center gap-2">
            {tools.length > MCP_SERVER_TOOL_PREVIEW_LIMIT ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showAllTools }}
                className="min-h-11 justify-center active:opacity-60"
                onPress={() => setShowAllTools(!showAllTools)}
              >
                <Text className="text-xs font-t3-medium text-foreground-muted">
                  {showAllTools ? "Show fewer" : `Show all ${tools.length}`}
                </Text>
              </Pressable>
            ) : null}
            {view.reconnect === null ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Reconnect ${view.label}`}
                accessibilityState={{
                  disabled: props.reconnecting || view.reconnect.disabledReason !== null,
                  busy: props.reconnecting,
                }}
                disabled={props.reconnecting || view.reconnect.disabledReason !== null}
                onPress={props.onReconnect}
                className="min-h-11 flex-row items-center rounded-full border border-border px-4 active:opacity-70 disabled:opacity-50"
              >
                <Text className="text-xs font-t3-medium text-foreground">
                  {props.reconnecting ? "Reconnecting…" : "Reconnect"}
                </Text>
              </Pressable>
            )}
          </View>
          {view.reconnect?.disabledReason == null ? null : (
            <Text className="text-xs text-foreground-muted">{view.reconnect.disabledReason}</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}
