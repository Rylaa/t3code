/**
 * Skills & plugins sheet: the MCP servers, skills, plugins and agents a
 * thread used, from `orchestration.getThreadExtensions`, beside what the
 * active provider session loaded and the provider's own skill folders hold.
 * Mobile's counterpart of the web dialog and right panel; opened from the
 * thread header.
 *
 * The composer's /mcp and /skills open it on that section.
 *
 * The query is keyed by the thread's run boundaries, so an open sheet
 * refreshes when a run starts or settles instead of on every item or polling.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  filterThreadExtensionSections,
  MCP_SERVER_TOOL_PREVIEW_LIMIT,
  mcpServerGroups,
  mcpServerMetaLabel,
  mcpServerRows,
  pluginRowView,
  sectionWithMatches,
  THREAD_EXTENSION_SECTION_ORDER,
  THREAD_EXTENSION_SECTION_TITLES,
  threadExtensionGroups,
  threadExtensionsEmptyState,
  threadExtensionSections,
  threadExtensionsFootnotes,
  threadExtensionsInventoryNote,
  threadExtensionsMatchStatus,
  threadExtensionsNoMatchState,
  threadExtensionsProvider,
  threadExtensionsRevision,
  threadExtensionsSummary,
  type McpServerRowView,
  type McpServerStatusTone,
  type ThreadExtensionSection,
  type ThreadExtensionSectionKey,
  type ThreadExtensionSections,
} from "@t3tools/client-runtime/state/thread-extensions";
import type {
  EnvironmentId,
  OrchestrationV2ThreadExtensions,
  ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { Fragment, useEffect, useEffectEvent, useMemo, useState } from "react";
import { AccessibilityInfo, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { SegmentedControl } from "../../components/SegmentedControl";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadSheetFrame } from "./ThreadAgentsSheet";
import {
  Chevron,
  ExtensionGroups,
  ExtensionRow,
  SkillRow,
  subagentThreadIdOf,
} from "./ThreadExtensionsRows";
import { lastUsedAgo } from "./thread-extensions-presentation";

const STATUS_DOT_CLASS = {
  ok: "bg-adaptive-emerald-600-400",
  warning: "bg-adaptive-amber-700-400",
  error: "bg-adaptive-rose-600-400",
  neutral: "bg-foreground-muted",
} as const satisfies Record<McpServerStatusTone, string>;

/** Failed and Needs sign-in read in their color; every other status stays muted. */
const STATUS_WORD_CLASS = {
  ok: "text-foreground-muted",
  warning: "text-adaptive-amber-700-400",
  error: "text-adaptive-rose-600-400",
  neutral: "text-foreground-muted",
} as const satisfies Record<McpServerStatusTone, string>;

const SECTION_OPTIONS = THREAD_EXTENSION_SECTION_ORDER.map((key) => ({
  value: key,
  label: key === "mcpServers" ? "MCP" : THREAD_EXTENSION_SECTION_TITLES[key].title,
  accessibilityLabel: THREAD_EXTENSION_SECTION_TITLES[key].title,
}));

type ExtensionsTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The section to show: the one /mcp or /skills asked for. Skills otherwise. */
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
      // Rows and the clear button answer the first tap while the keyboard is up.
      keyboardShouldPersistTaps="handled"
    >
      <ThreadExtensionsContent
        // Search, section and group choices belong to one thread.
        key={target.threadId}
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

function sectionSize(section: ThreadExtensionSection): number {
  return section.used.length + section.unused.length;
}

function ThreadExtensionsContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly focus: ThreadExtensionSectionKey | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, threadId } = props;
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const config = useEnvironmentServerConfig(environmentId);
  const project = useProject(
    shell === null ? null : scopeProjectRef(environmentId, shell.projectId),
  );
  // The folder the composer reads skills for: the thread's worktree, else its project.
  const cwd =
    project === null
      ? null
      : projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: shell?.worktreePath ?? null,
        });
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
  // Keyed on the instance, not the shell, which changes with every turn item.
  const providers = config?.providers ?? null;
  const instanceId = shell?.runtime?.providerInstanceId ?? shell?.providerInstanceId ?? null;
  const provider = useMemo(
    () =>
      providers === null || instanceId === null
        ? null
        : threadExtensionsProvider(
            providers,
            { providerInstanceId: instanceId, runtime: null },
            cwd,
          ),
    [providers, instanceId, cwd],
  );
  const sections = useMemo(() => threadExtensionSections(data, provider), [data, provider]);
  const [search, setSearch] = useState("");
  const filtered = useMemo(
    () => filterThreadExtensionSections(sections, search),
    [sections, search],
  );
  const [section, setSection] = useState<ThreadExtensionSectionKey>(props.focus ?? "skills");
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const toggleGroup = (groupId: string, expanded: boolean) =>
    setToggles((current) => new Map(current).set(groupId, expanded));

  // Opening shows what the session reports now, not a read cached by an earlier visit.
  const refreshCached = useEffectEvent(() => {
    if (query.data !== null) query.refresh();
  });
  useEffect(() => refreshCached(), []);

  // Reconnect lives here, not in the MCP list: a tab switch or a search that hides the
  // list mid-request must neither lose the result nor allow a second request.
  const permitted = useAtomValue(
    orchestrationEnvironment.controlMcpServer.permissionAtom(environmentId),
  );
  const controlMcpServer = useAtomCommand(orchestrationEnvironment.controlMcpServer, {
    label: "reconnect MCP server",
    reportFailure: false,
  });
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const announce = (message: string) => {
    setAnnouncement(message);
    // Android reads the live region below as it changes; iOS has none.
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(message);
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
    query.refresh();
  };

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

  const live = data.mcpServersLive === true;
  const providerNote = threadExtensionsInventoryNote(sections.inventoryStatus, live);

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

  const summary = threadExtensionsSummary(sections, data);
  const searching = search.trim() !== "";
  const matchStatus = searching
    ? threadExtensionsMatchStatus(
        section,
        sectionSize(filtered[section]),
        sectionSize(sections[section]),
      )
    : "";

  return (
    <View className="gap-4 pt-2">
      <SegmentedControl
        options={SECTION_OPTIONS}
        selected={section}
        onSelect={(next) => {
          void Haptics.selectionAsync();
          setSection(next);
        }}
        role="tab"
      />
      {summary.length === 0 ? null : (
        <Text
          className="text-xs text-foreground-muted"
          accessibilityLabel={summary.map((part) => part.text).join(", ")}
        >
          {summary.map((part, index) => (
            <Fragment key={part.text}>
              {index === 0 ? "" : " · "}
              <Text
                className={cn(
                  "text-xs",
                  part.tone === "warning" ? "text-adaptive-amber-700-400" : "text-foreground-muted",
                )}
              >
                {part.text}
              </Text>
            </Fragment>
          ))}
        </Text>
      )}
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <View className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 rounded-full bg-input pl-3.5">
            <SymbolView
              name="magnifyingglass"
              size={15}
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
            />
            <TextInput
              accessibilityLabel="Search MCP servers, skills, plugins and agents"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              placeholder="Search"
              placeholderTextColorClassName="accent-placeholder"
              selectionColorClassName="accent-focus/32"
              cursorColorClassName="accent-focus"
              selectionHandleColorClassName="accent-focus"
              className="min-h-11 min-w-0 flex-1 px-0 py-0 font-sans text-base text-foreground"
              value={search}
              onChangeText={setSearch}
              onSubmitEditing={() => {
                // Android reads the live region below as it changes; iOS has none.
                if (Platform.OS === "ios" && matchStatus !== "") {
                  AccessibilityInfo.announceForAccessibility(matchStatus);
                }
              }}
            />
            {search.length === 0 ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                className="size-11 items-center justify-center active:opacity-60"
                onPress={() => setSearch("")}
              >
                <SymbolView
                  name="xmark.circle.fill"
                  size={16}
                  tintColorClassName="accent-foreground-muted"
                />
              </Pressable>
            )}
          </View>
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
        {/* Stays mounted, so Android reads each new count. */}
        <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          {matchStatus}
        </Text>
        {/* Outside the MCP list, so a Reconnect that settles after the list is gone still shows. */}
        <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          {announcement}
        </Text>
      </View>
      {sectionSize(filtered[section]) === 0 ? (
        <SectionNotice
          section={section}
          search={search}
          searching={searching}
          sections={sections}
          filtered={filtered}
          live={live}
          onShowSection={setSection}
          onClearSearch={() => setSearch("")}
        />
      ) : section === "mcpServers" ? (
        <McpServerSection
          threadId={threadId}
          section={filtered.mcpServers}
          live={live}
          permitted={permitted}
          config={config}
          shell={shell}
          reconnecting={reconnecting}
          onReconnect={(view) => void reconnect(view)}
          toggles={toggles}
          onToggle={toggleGroup}
          onOpenThread={props.onOpenThread}
        />
      ) : (
        <ExtensionGroups
          groups={threadExtensionGroups(section, filtered[section])}
          toggles={toggles}
          onToggle={toggleGroup}
          renderRow={(row, group) => {
            const inUsedGroup = group.id === `${section}:used`;
            return section === "skills" ? (
              <SkillRow
                key={row.name}
                row={row}
                showSource={inUsedGroup}
                driver={provider?.driver ?? null}
                threadId={threadId}
                onOpenThread={props.onOpenThread}
              />
            ) : (
              <ExtensionRow
                key={row.name}
                row={row}
                badge={section === "agents" && inUsedGroup ? (row.plugin ?? "Other") : null}
                plugin={section === "plugins" ? pluginRowView(row, sections) : null}
                threadId={threadId}
                onOpenThread={props.onOpenThread}
              />
            );
          }}
        />
      )}
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

/** An empty section says why; a search with no matches here points at a section with some. */
function SectionNotice(props: {
  readonly section: ThreadExtensionSectionKey;
  readonly search: string;
  readonly searching: boolean;
  readonly sections: ThreadExtensionSections;
  readonly filtered: ThreadExtensionSections;
  readonly live: boolean;
  readonly onShowSection: (section: ThreadExtensionSectionKey) => void;
  readonly onClearSearch: () => void;
}) {
  const noMatch = props.searching
    ? threadExtensionsNoMatchState(
        props.section,
        props.search,
        sectionWithMatches(props.filtered, props.section),
      )
    : null;
  const notice =
    noMatch ??
    threadExtensionsEmptyState(props.section, props.sections.inventoryStatus, props.live);
  return (
    <View className="items-center gap-2 px-4 pt-4">
      <Text className="text-center text-sm font-t3-medium text-foreground">{notice.title}</Text>
      <Text className="text-center text-xs text-foreground-muted">{notice.description}</Text>
      {noMatch === null ? null : (
        <Pressable
          accessibilityRole="button"
          className="min-h-11 justify-center px-3 active:opacity-60"
          onPress={() => {
            const target = noMatch.action.showSection;
            if (target === null) props.onClearSearch();
            else props.onShowSection(target);
          }}
        >
          <Text className="text-sm font-t3-medium text-foreground">{noMatch.action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

function McpServerSection(props: {
  readonly threadId: ThreadId;
  readonly section: ThreadExtensionSection;
  readonly live: boolean;
  readonly permitted: boolean;
  readonly config: ServerConfig | null;
  readonly shell: EnvironmentThreadShell | null;
  /** The server a Reconnect is in flight for. */
  readonly reconnecting: string | null;
  readonly onReconnect: (view: McpServerRowView) => void;
  readonly toggles: ReadonlyMap<string, boolean>;
  readonly onToggle: (groupId: string, expanded: boolean) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const groups = mcpServerGroups(
    mcpServerRows(props.section, {
      live: props.live,
      permitted: props.permitted,
      config: props.config,
      shell: props.shell,
    }),
  );
  return (
    <ExtensionGroups
      groups={groups}
      toggles={props.toggles}
      onToggle={props.onToggle}
      renderRow={(view) => (
        <McpServerRow
          key={view.row.name}
          view={view}
          threadId={props.threadId}
          reconnecting={props.reconnecting === view.row.name}
          onReconnect={() => props.onReconnect(view)}
          onOpenThread={props.onOpenThread}
        />
      )}
    />
  );
}

/**
 * One MCP server: a status dot beside the status in words, its origin, tool
 * count and uses, expanding to its error, tools and Reconnect. Names, errors
 * and tool names are untrusted text, rendered as plain text only.
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
  const subagentThreadId = subagentThreadIdOf(row, props.threadId);
  const meta = mcpServerMetaLabel(row);

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
      {view.statusLabel === null ? null : (
        <Text className={cn("shrink-0 text-xs", STATUS_WORD_CLASS[view.tone])}>
          {view.statusLabel}
        </Text>
      )}
      {meta ? (
        <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{meta}</Text>
      ) : null}
      {view.hasDetail ? <Chevron open={open} /> : null}
    </>
  );

  return (
    <View className="border-b border-border-subtle">
      {view.hasDetail ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityHint="Shows details"
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
            <Text className="text-xs text-foreground-muted">
              Last used {lastUsedAgo(row.lastUsedAt)}
            </Text>
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
