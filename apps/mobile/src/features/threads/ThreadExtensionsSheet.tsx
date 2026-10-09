/**
 * Skills & plugins sheet: the skills, plugins, MCP servers and agents a thread
 * used, from `orchestration.getThreadExtensions`, beside what the active
 * provider session loaded but did not use. Mobile's counterpart of the web
 * right panel's Skills & plugins surface; opened from the thread header.
 *
 * The query is keyed by the thread's run boundaries, so an open sheet
 * refreshes when a run starts or settles instead of on every item or polling.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  mcpServerStatusTone,
  threadExtensionDisplayName,
  threadExtensionSectionCountLabel,
  threadExtensionSections,
  threadExtensionsFootnotes,
  threadExtensionsInventoryNote,
  threadExtensionsRevision,
  type McpServerStatusTone,
  type ThreadExtensionRow,
  type ThreadExtensionSection,
} from "@t3tools/client-runtime/state/thread-extensions";
import type { EnvironmentId, OrchestrationV2ThreadExtensions, ThreadId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadSheetFrame } from "./ThreadAgentsSheet";

/** Loaded-but-unused rows past this many start collapsed. */
const UNUSED_PREVIEW_LIMIT = 4;

const STATUS_DOT_CLASS = {
  ok: "bg-adaptive-emerald-600-400",
  warning: "bg-adaptive-amber-700-400",
  error: "bg-adaptive-rose-600-400",
  neutral: "bg-foreground-muted",
} as const satisfies Record<McpServerStatusTone, string>;

type ExtensionsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

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

  const providerNote = threadExtensionsInventoryNote(sections.inventoryStatus);

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

  const renderSection = (section: ThreadExtensionSection, title: string) => (
    <ExtensionSection
      key={title}
      title={title}
      section={section}
      threadId={threadId}
      onOpenThread={props.onOpenThread}
    />
  );

  return (
    <View className="gap-5 pt-2">
      {renderSection(sections.skills, "Skills")}
      {renderSection(sections.plugins, "Plugins")}
      {renderSection(sections.mcpServers, "MCP servers")}
      {renderSection(sections.agents, "Agents")}
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

function ExtensionSection(props: {
  readonly title: string;
  readonly section: ThreadExtensionSection;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { used, unused } = props.section;
  const collapsible = unused.length > UNUSED_PREVIEW_LIMIT;
  const [showUnused, setShowUnused] = useState(false);
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
      <View accessibilityRole="header" className="flex-row items-center justify-between pb-1">
        <Text className="text-sm font-t3-bold text-foreground">{props.title}</Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {threadExtensionSectionCountLabel(props.section)}
        </Text>
      </View>
      {used.map(renderRow)}
      {!collapsible || showUnused ? unused.map(renderRow) : null}
      {collapsible ? (
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
    row.status,
    row.lastUsedAt === null ? null : lastUsedLabel(row.lastUsedAt),
    (row.tools ?? []).map((tool) => `${tool.name} ×${tool.count}`).join(", ") || null,
  ].filter((part): part is string => part !== null && part !== undefined);

  const body = (
    <View className="gap-0.5 border-b border-border-subtle py-2.5">
      <View className="flex-row items-center gap-2">
        {row.status === undefined ? null : (
          <View
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              STATUS_DOT_CLASS[mcpServerStatusTone(row.status)],
            )}
          />
        )}
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
