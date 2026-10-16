/**
 * The Skills & plugins sheet's groups and rows. Every name, description and
 * path is untrusted text, rendered as plain text only.
 */
import { MCP_SIGN_IN_TEXT, mcpSignInPasteError } from "@t3tools/client-runtime/state/mcp-sign-in";
import {
  skillStartText,
  skillStateBadges,
  threadExtensionDisplayName,
  type PluginRowView,
  type ThreadExtensionGroup,
  type ThreadExtensionRow,
} from "@t3tools/client-runtime/state/thread-extensions";
import type { ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import { AccessibilityInfo, Platform, Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { CopyTextButton } from "./CopyTextButton";
import {
  mcpSignInPasteAnnouncement,
  threadExtensionMetaLabel,
  type McpSignInRowView,
} from "./thread-extensions-presentation";

/** A subagent's own calls live in its child thread; rows link to it. */
export function subagentThreadIdOf(row: ThreadExtensionRow, threadId: ThreadId): ThreadId | null {
  return row.lastItem !== null && row.lastItem.threadId !== threadId ? row.lastItem.threadId : null;
}

export function Chevron(props: { readonly open: boolean }) {
  return (
    <SymbolView
      name="chevron.down"
      size={12}
      tintColorClassName="accent-icon-subtle"
      type="monochrome"
      style={{ transform: [{ rotate: props.open ? "180deg" : "0deg" }] }}
    />
  );
}

function RowBadge(props: { readonly label: string }) {
  return (
    <View className="shrink-0 rounded-md bg-subtle px-1.5 py-0.5">
      <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  );
}

/**
 * A section's groups, each under a header that expands and collapses it. The
 * user's choice per group id outlives searches and tab switches; otherwise a
 * group follows `expandedByDefault`. Collapsed groups render no rows.
 */
export function ExtensionGroups<Row>(props: {
  readonly groups: ReadonlyArray<ThreadExtensionGroup<Row>>;
  readonly toggles: ReadonlyMap<string, boolean>;
  readonly onToggle: (groupId: string, expanded: boolean) => void;
  readonly renderRow: (row: Row, group: ThreadExtensionGroup<Row>) => ReactNode;
}) {
  return (
    <View className="gap-3">
      {props.groups.map((group) => {
        const expanded = props.toggles.get(group.id) ?? group.expandedByDefault;
        return (
          <View key={group.id}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              className="min-h-11 flex-row items-center gap-2 active:opacity-60"
              onPress={() => {
                void Haptics.selectionAsync();
                props.onToggle(group.id, !expanded);
              }}
            >
              <Text className="min-w-0 shrink text-sm font-t3-medium text-foreground">
                {group.label}
              </Text>
              <View className="flex-1" />
              <Text
                className={
                  group.tone === "warning"
                    ? "shrink-0 text-xs tabular-nums text-adaptive-amber-700-400"
                    : "shrink-0 text-xs tabular-nums text-foreground-muted"
                }
              >
                {group.countLabel}
              </Text>
              <Chevron open={expanded} />
            </Pressable>
            {expanded ? group.rows.map((row) => props.renderRow(row, group)) : null}
          </View>
        );
      })}
    </View>
  );
}

/**
 * A skill: its name, source (in Used in this thread), state and uses, with its
 * description below. It expands to the full description, its file, how to
 * start it and what its state means.
 */
export function SkillRow(props: {
  readonly row: ThreadExtensionRow;
  readonly showSource: boolean;
  readonly driver: string | null;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { row } = props;
  const [open, setOpen] = useState(false);
  const badges = skillStateBadges(row);
  const meta = threadExtensionMetaLabel(row);
  const start = skillStartText(row, props.driver);
  const subagentThreadId = subagentThreadIdOf(row, props.threadId);

  return (
    <View className="border-b border-border-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint="Shows details"
        className="min-h-11 justify-center gap-0.5 py-2.5 active:opacity-70"
        onPress={() => {
          void Haptics.selectionAsync();
          setOpen(!open);
        }}
      >
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 shrink text-sm text-foreground" numberOfLines={1}>
            {threadExtensionDisplayName(row)}
          </Text>
          {props.showSource && row.sourceLabel !== undefined ? (
            <RowBadge label={row.sourceLabel} />
          ) : null}
          {badges.map((badge) => (
            <RowBadge key={badge.label} label={badge.label} />
          ))}
          <View className="flex-1" />
          {meta === null ? null : (
            <Text className="shrink-0 text-2xs tabular-nums text-foreground-muted">{meta}</Text>
          )}
          <Chevron open={open} />
        </View>
        {row.description === undefined ? null : (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {row.description}
          </Text>
        )}
      </Pressable>
      {open ? (
        <View className="gap-1.5 pb-3">
          <Text selectable className="text-xs text-foreground">
            {row.description ?? "No description."}
          </Text>
          {row.path === undefined ? null : (
            <Text
              className="text-2xs text-foreground-muted"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {row.path}
            </Text>
          )}
          {start === null ? null : (
            <View className="flex-row items-center gap-1">
              <Text className="min-w-0 shrink text-xs text-foreground-muted">
                Start it with <Text className="font-mono text-xs text-foreground">{start}</Text>
              </Text>
              <CopyTextButton accessibilityLabel={`Copy ${start}`} text={start} buttonSize={44} />
            </View>
          )}
          {badges.map((badge) => (
            <Text key={badge.label} className="text-xs text-foreground-muted">
              {badge.sentence}
            </Text>
          ))}
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
      ) : null}
    </View>
  );
}

/**
 * An agent or plugin: its name, a badge, its version and uses. A plugin adds
 * what it ships and its MCP servers' problems. A row a subagent used last
 * opens that subagent's thread.
 */
export function ExtensionRow(props: {
  readonly row: ThreadExtensionRow;
  readonly badge: string | null;
  readonly plugin: PluginRowView | null;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { row, plugin } = props;
  const meta = threadExtensionMetaLabel(row);
  const subagentThreadId = subagentThreadIdOf(row, props.threadId);

  const body = (
    <View className="min-h-11 justify-center gap-0.5 border-b border-border-subtle py-2.5">
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 shrink text-sm text-foreground" numberOfLines={1}>
          {threadExtensionDisplayName(row)}
        </Text>
        {props.badge === null ? null : <RowBadge label={props.badge} />}
        {row.version === undefined ? null : (
          <Text className="shrink-0 text-2xs text-foreground-muted">v{row.version}</Text>
        )}
        <View className="flex-1" />
        {meta === null ? null : (
          <Text className="shrink-0 text-2xs tabular-nums text-foreground-muted">{meta}</Text>
        )}
      </View>
      {plugin === null ? null : (
        <Text className="text-xs text-foreground-muted">
          {plugin.contents}
          {plugin.problems === null ? null : (
            <Text className="text-xs text-adaptive-amber-700-400">{` · ${plugin.problems}`}</Text>
          )}
        </Text>
      )}
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

/**
 * The sign-in a row waits on: its page's host and a button to open it, then
 * the paste field or, for a claude.ai connector, Check connection. The pasted
 * address carries the sign-in's code: it leaves the field once sent.
 */
export function McpSignInWaiting(props: {
  readonly waiting: NonNullable<McpSignInRowView["waiting"]>;
  readonly checking: boolean;
  readonly onOpen: () => void;
  readonly onFinish: (callbackUrl: string) => void;
  readonly onCheck: () => void;
  readonly onCancel: () => void;
}) {
  const { waiting } = props;
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const finish = () => {
    const error = mcpSignInPasteError(pasted);
    setPasteError(error);
    const spoken = mcpSignInPasteAnnouncement(error, Platform.OS);
    if (spoken !== null) AccessibilityInfo.announceForAccessibility(spoken);
    if (error !== null) return;
    props.onFinish(pasted.trim());
    setPasted("");
  };
  return (
    <View className="gap-2 pt-1">
      {waiting.host === null ? null : (
        <Text className="text-xs text-foreground-muted">Sign-in page: {waiting.host}</Text>
      )}
      <View className="flex-row flex-wrap items-center gap-2">
        {waiting.openLabel === null ? null : (
          <RowButton
            label={waiting.openLabel}
            accessibilityHint={waiting.host === null ? undefined : `Opens ${waiting.host}`}
            onPress={props.onOpen}
          />
        )}
        {waiting.checkConnection ? (
          <RowButton
            label={props.checking ? "Checking…" : MCP_SIGN_IN_TEXT.checkConnection}
            disabled={props.checking}
            busy={props.checking}
            onPress={props.onCheck}
          />
        ) : null}
        <RowButton label={MCP_SIGN_IN_TEXT.cancel} onPress={props.onCancel} />
      </View>
      {waiting.paste ? (
        <View className="gap-2">
          <Text className="text-xs text-foreground-muted">{MCP_SIGN_IN_TEXT.pastePrompt}</Text>
          <TextInput
            accessibilityLabel="Address from your browser"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            placeholder="Paste the address"
            placeholderTextColorClassName="accent-placeholder"
            selectionColorClassName="accent-focus/32"
            cursorColorClassName="accent-focus"
            selectionHandleColorClassName="accent-focus"
            className="min-h-11 rounded-xl bg-input px-3 py-0 font-sans text-sm text-foreground"
            editable={!waiting.finishing}
            value={pasted}
            onChangeText={(text) => {
              setPasted(text);
              setPasteError(null);
            }}
            onSubmitEditing={finish}
          />
          {/* Stays mounted, so Android reads the error when it appears. */}
          <Text accessibilityLiveRegion="polite" className="text-xs text-adaptive-rose-600-400">
            {pasteError ?? ""}
          </Text>
          <View className="flex-row">
            <RowButton
              label={MCP_SIGN_IN_TEXT.finish}
              disabled={waiting.finishing}
              busy={waiting.finishing}
              onPress={finish}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** An MCP row's outlined action, at least 44pt tall. */
export function RowButton(props: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly onPress: () => void;
}) {
  const disabled = props.disabled === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled, busy: props.busy === true }}
      disabled={disabled}
      onPress={props.onPress}
      className="min-h-11 flex-row items-center rounded-full border border-border px-4 active:opacity-70 disabled:opacity-50"
    >
      <Text className="text-xs font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
