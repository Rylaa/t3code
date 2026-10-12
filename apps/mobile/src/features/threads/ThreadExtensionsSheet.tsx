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
 * refreshes when a run starts or settles instead of on every item, and polls
 * only while an MCP sign-in waits.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  MCP_SIGN_IN_IDLE,
  MCP_SIGN_IN_POLL_MS,
  MCP_SIGN_IN_TEXT,
  mcpSignInErrorCode,
  mcpSignInErrorText,
  mcpSignInMessage,
  mcpSignInPolling,
  mcpSignInReducer,
  mcpSignOutText,
  type McpSignInState,
} from "@t3tools/client-runtime/state/mcp-sign-in";
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
import { Fragment, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { SegmentedControl } from "../../components/SegmentedControl";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadSheetFrame } from "./ThreadAgentsSheet";
import {
  Chevron,
  ExtensionGroups,
  ExtensionRow,
  McpSignInWaiting,
  RowButton,
  SkillRow,
  subagentThreadIdOf,
} from "./ThreadExtensionsRows";
import { lastUsedAgo, mcpSignInRowView } from "./thread-extensions-presentation";

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

  // The one MCP sign-in lives here for the same reasons. Cancel only closes it here: the
  // server has no cancel, and the provider drops an unfinished sign-in after five minutes.
  const controlMcpServerAuth = useAtomCommand(orchestrationEnvironment.controlMcpServerAuth, {
    label: "sign in to MCP server",
    reportFailure: false,
    reportDefect: false,
  });
  const [signIn, dispatchSignIn] = useReducer(mcpSignInReducer, MCP_SIGN_IN_IDLE);
  // Bumped by each new sign-in and by Cancel, so a late answer for an earlier one is dropped.
  const signInAttempt = useRef(0);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const live = data?.mcpServersLive === true;
  // Read from every row, not the search's matches: a search must not hide the status.
  const signInView =
    signIn.phase === "idle"
      ? null
      : (mcpServerRows(sections.mcpServers, { live, permitted, config, shell }).find(
          (view) => view.row.name === signIn.server,
        ) ?? null);
  const signInStatus = signInView?.row.status;
  const polling = mcpSignInPolling(signIn);
  // No event reports a server that signed in: read the status again until it does or expires.
  const pollSignIn = useEffectEvent(() => {
    dispatchSignIn({ type: "status", status: signInStatus, now: Date.now() });
    query.refresh();
  });
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(pollSignIn, MCP_SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);
  // A read that shows Connected ends the sign-in without waiting for the next poll.
  useEffect(() => {
    if (polling && signInStatus === "connected") {
      dispatchSignIn({ type: "status", status: signInStatus, now: Date.now() });
    }
  }, [polling, signInStatus]);
  const signInMessage =
    signIn.phase === "idle" ? null : mcpSignInMessage(signIn, signInView?.label ?? signIn.server);
  // Android reads the row's live region; iOS has none, and the row may be scrolled or tabbed away.
  useEffect(() => {
    if (Platform.OS === "ios" && signInMessage !== null) {
      AccessibilityInfo.announceForAccessibility(signInMessage);
    }
  }, [signInMessage]);

  const signInFailed = (error: unknown) =>
    dispatchSignIn({ type: "failed", code: mcpSignInErrorCode(error) });
  const cancelSignIn = () => {
    signInAttempt.current += 1;
    dispatchSignIn({ type: "cancel" });
  };
  const signInActions: McpSignInActions = {
    state: signIn,
    signingOut,
    onStart: async (view) => {
      if (signIn.phase === "starting" || signIn.phase === "finishing") return;
      void Haptics.selectionAsync();
      signInAttempt.current += 1;
      const attempt = signInAttempt.current;
      dispatchSignIn({ type: "start", server: view.row.name });
      const result = await controlMcpServerAuth({
        environmentId,
        input: { threadId, server: view.row.name, action: "sign-in" },
      });
      if (attempt !== signInAttempt.current) return;
      if (result._tag === "Success") {
        dispatchSignIn({ type: "started", result: result.value, now: Date.now() });
      } else {
        signInFailed(squashAtomCommandFailure(result));
      }
    },
    // Only from a tap, and only the http(s) page the reducer kept.
    onOpen: () => {
      if ((signIn.phase === "waiting" || signIn.phase === "finishing") && signIn.openUrl !== null) {
        void tryOpenExternalUrl(signIn.openUrl, "provider-auth");
      }
    },
    onFinish: async (callbackUrl) => {
      if (signIn.phase !== "waiting") return;
      const attempt = signInAttempt.current;
      dispatchSignIn({ type: "submit", now: Date.now() });
      const result = await controlMcpServerAuth({
        environmentId,
        input: { threadId, server: signIn.server, action: "finish-sign-in", callbackUrl },
      });
      if (attempt !== signInAttempt.current) return;
      // The T3 server reconnects the MCP server once the code is in; the status read shows it.
      if (result._tag === "Success") query.refresh();
      else signInFailed(squashAtomCommandFailure(result));
    },
    // A claude.ai connector is authorized on claude.ai, and a failed sign-in's fallback
    // happens elsewhere: reconnecting shows whether it took.
    onCheck: async (view) => {
      if (reconnecting !== null) return;
      void Haptics.selectionAsync();
      const attempt = signInAttempt.current;
      setReconnecting(view.row.name);
      const result = await controlMcpServer({
        environmentId,
        input: { threadId, server: view.row.name, action: "reconnect" },
      });
      setReconnecting(null);
      query.refresh();
      if (attempt !== signInAttempt.current) return;
      // A reconnect succeeds only once the server connects; nothing polls these waits.
      if (result._tag === "Success") {
        dispatchSignIn({ type: "status", status: "connected", now: Date.now() });
      } else {
        signInFailed(squashAtomCommandFailure(result));
      }
    },
    onCancel: cancelSignIn,
    onSignOut: (view) => {
      if (signingOut !== null) return;
      const text = mcpSignOutText(view.label);
      confirmSignOut(text, async () => {
        // Its "Signed in" line would go stale.
        if (signIn.phase !== "idle" && signIn.server === view.row.name) cancelSignIn();
        setSigningOut(view.row.name);
        const result = await controlMcpServerAuth({
          environmentId,
          input: { threadId, server: view.row.name, action: "sign-out" },
        });
        setSigningOut(null);
        announce(
          result._tag === "Success"
            ? text.done
            : `${view.label}: ${mcpSignInErrorText(mcpSignInErrorCode(squashAtomCommandFailure(result)), "sign-out")}`,
        );
        query.refresh();
      });
    },
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
          signIn={signInActions}
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

/** iOS's own alert already matches the app; Android's themed one can't color one button. */
function confirmSignOut(text: ReturnType<typeof mcpSignOutText>, onConfirm: () => void) {
  if (Platform.OS === "ios") {
    Alert.alert(text.title, text.description, [
      { text: "Cancel", style: "cancel" },
      { text: text.confirm, style: "destructive", onPress: onConfirm },
    ]);
    return;
  }
  showConfirmDialog({
    title: text.title,
    message: text.description,
    confirmText: text.confirm,
    destructive: true,
    onConfirm,
  });
}

/** The sheet's one MCP sign-in and Sign out, held above the list like Reconnect. */
interface McpSignInActions {
  readonly state: McpSignInState;
  /** The server a Sign out is in flight for. */
  readonly signingOut: string | null;
  readonly onStart: (view: McpServerRowView) => void;
  readonly onOpen: () => void;
  /** Takes a pasted address that passed `mcpSignInPasteError`, trimmed. */
  readonly onFinish: (callbackUrl: string) => void;
  readonly onCheck: (view: McpServerRowView) => void;
  readonly onCancel: () => void;
  readonly onSignOut: (view: McpServerRowView) => void;
}

function McpServerSection(props: {
  readonly threadId: ThreadId;
  readonly section: ThreadExtensionSection;
  readonly live: boolean;
  readonly permitted: boolean;
  readonly config: ServerConfig | null;
  readonly shell: EnvironmentThreadShell | null;
  /** The server a Reconnect or Check connection is in flight for. */
  readonly reconnecting: string | null;
  readonly onReconnect: (view: McpServerRowView) => void;
  readonly signIn: McpSignInActions;
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
          signIn={props.signIn}
          onOpenThread={props.onOpenThread}
        />
      )}
    />
  );
}

/**
 * One MCP server: a status dot beside the status in words, its origin, tool
 * count and uses, expanding to its error, tools, Reconnect, Sign in and Sign
 * out. Names, errors and tool names are untrusted text, rendered as plain text only.
 */
function McpServerRow(props: {
  readonly view: McpServerRowView;
  readonly threadId: ThreadId;
  readonly reconnecting: boolean;
  readonly onReconnect: () => void;
  readonly signIn: McpSignInActions;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { view, signIn } = props;
  const { row } = view;
  const signInView = mcpSignInRowView(view, signIn.state);
  const signingOut = signIn.signingOut === row.name;
  // Reconnect and Sign out wait for the same thing.
  const waitReason = view.reconnect?.disabledReason ?? view.signOut?.disabledReason ?? null;
  // A row that comes back with its sign-in open (a tab switch, a collapsed group) shows it.
  const [open, setOpen] = useState(
    signIn.state.phase !== "idle" && signIn.state.server === row.name,
  );
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
            {signInView.button === null || view.signIn === null ? null : (
              <RowButton
                label={signInView.button.label}
                accessibilityLabel={
                  view.signIn.kind === "oauth"
                    ? `Sign in to ${view.label}`
                    : `Authorize on claude.ai for ${view.label}`
                }
                disabled={signInView.button.disabled}
                busy={signInView.button.busy}
                onPress={() => signIn.onStart(view)}
              />
            )}
            {signInView.cancel ? (
              <RowButton label={MCP_SIGN_IN_TEXT.cancel} onPress={signIn.onCancel} />
            ) : null}
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
            {view.signOut === null ? null : (
              <RowButton
                label={signingOut ? "Signing out…" : "Sign out"}
                accessibilityLabel={`Sign out of ${view.label}`}
                disabled={signingOut || view.signOut.disabledReason !== null}
                busy={signingOut}
                onPress={() => signIn.onSignOut(view)}
              />
            )}
          </View>
          {waitReason === null ? null : (
            <Text className="text-xs text-foreground-muted">{waitReason}</Text>
          )}
          {signInView.button === null && signInView.message === null ? null : (
            // Stays mounted, so Android reads each step of the sign-in.
            <Text accessibilityLiveRegion="polite" className="text-xs text-foreground">
              {signInView.message ?? ""}
            </Text>
          )}
          {signInView.waiting === null ? null : (
            <McpSignInWaiting
              waiting={signInView.waiting}
              checking={props.reconnecting}
              onOpen={signIn.onOpen}
              onFinish={signIn.onFinish}
              onCheck={() => signIn.onCheck(view)}
              onCancel={signIn.onCancel}
            />
          )}
          {signInView.fallback === null ? null : (
            <>
              <Text className="text-xs text-foreground-muted">{signInView.fallback}</Text>
              {/* The session picks up a sign-in made elsewhere only by reconnecting. */}
              <View className="flex-row">
                <RowButton
                  label={props.reconnecting ? "Checking…" : MCP_SIGN_IN_TEXT.checkConnection}
                  disabled={props.reconnecting}
                  busy={props.reconnecting}
                  onPress={() => signIn.onCheck(view)}
                />
              </View>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}
