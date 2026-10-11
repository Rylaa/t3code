/**
 * Skills & plugins right-panel surface: the skills, plugins, MCP servers and
 * agents the thread used, from `orchestration.getThreadExtensions`, beside
 * what the active provider session loaded but did not use. The /mcp and
 * /skills dialog renders one section of it.
 *
 * The query is keyed by the thread's run boundaries, so the panel refreshes
 * when a run starts or settles instead of on every item or polling.
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
import type {
  OrchestrationV2ThreadExtensions,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { ArrowRightIcon, PuzzleIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Loaded-but-unused rows past this many start collapsed. */
const UNUSED_PREVIEW_LIMIT = 4;

const STATUS_DOT_CLASS: Record<McpServerStatusTone, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/40",
};

const SECTION_TITLE: Record<ThreadExtensionSectionKey, string> = {
  skills: "Skills",
  plugins: "Plugins",
  mcpServers: "MCP servers",
  agents: "Agents",
};

const SECTION_EMPTY_TEXT: Record<ThreadExtensionSectionKey, string> = {
  skills: "No skills yet",
  plugins: "No plugins yet",
  mcpServers: "No MCP servers yet",
  agents: "No agents yet",
};

/** The thread's extensions query, keeping the last result while a new revision loads. */
export function useThreadExtensions(threadRef: ScopedThreadRef) {
  const { environmentId, threadId } = threadRef;
  const shell = useThreadShell(threadRef);
  const query = useEnvironmentQuery(
    orchestrationEnvironment.threadExtensions({
      environmentId,
      input:
        shell === null ? { threadId } : { threadId, revision: threadExtensionsRevision(shell) },
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
  const data =
    query.data ?? (retained !== null && retained.threadId === threadId ? retained.data : null);
  const sections = useMemo(() => threadExtensionSections(data), [data]);
  return { shell, query, data, sections };
}

/**
 * Pass `section` to show only that section, expanded; the right panel stacks all four.
 * `onNavigate` runs before a row opens a subagent thread, so a dialog can close first.
 */
export function SkillsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly section?: ThreadExtensionSectionKey;
  readonly onNavigate?: () => void;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { shell, query, data, sections } = useThreadExtensions(props.threadRef);

  const navigate = useNavigate();
  const openThread = (childThreadId: ThreadId) => {
    props.onNavigate?.();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, childThreadId)),
    });
  };

  if (data === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        {query.error === null ? (
          <p className="text-xs text-muted-foreground">Loading skills and plugins…</p>
        ) : (
          <>
            <p className="text-sm font-medium">Couldn't load skills and plugins</p>
            <p className="max-w-60 text-xs text-muted-foreground">{query.error}</p>
            <Button size="xs" variant="outline" onClick={query.refresh}>
              Retry
            </Button>
          </>
        )}
      </div>
    );
  }

  const providerNote = threadExtensionsInventoryNote(
    sections.inventoryStatus,
    data.mcpServersLive === true,
  );
  const standalone = props.section !== undefined;

  if (props.section !== undefined) {
    const only = sections[props.section];
    if (only.used.length === 0 && only.unused.length === 0) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm font-medium">{SECTION_EMPTY_TEXT[props.section]}</p>
          {providerNote === null ? null : (
            <p className="max-w-64 text-xs text-muted-foreground">{providerNote}</p>
          )}
        </div>
      );
    }
  } else if (sections.isEmpty) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <PuzzleIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No skills or plugins yet</p>
        <p className="max-w-64 text-xs text-muted-foreground">
          {providerNote ??
            "Skills, plugins, MCP servers and agents show up here once the session loads them or the agent uses them."}
        </p>
      </div>
    );
  }

  const renderRows = (section: ThreadExtensionSection, title: string) => (
    <ExtensionSection
      key={`${threadId}:${title}`}
      title={title}
      section={section}
      standalone={standalone}
      threadId={threadId}
      onOpenThread={openThread}
    />
  );
  const mcpServers = (
    <McpServerSection
      key={`${threadId}:mcp`}
      threadRef={props.threadRef}
      section={sections.mcpServers}
      live={data.mcpServersLive === true}
      standalone={standalone}
      onRefresh={query.refresh}
      onOpenThread={openThread}
    />
  );
  // The dialog states it in its header.
  const freshness = standalone ? null : mcpServerStatusFreshness(data);

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-3 p-2">
        {props.section === undefined ? (
          <>
            {renderRows(sections.skills, SECTION_TITLE.skills)}
            {renderRows(sections.plugins, SECTION_TITLE.plugins)}
            {mcpServers}
            {renderRows(sections.agents, SECTION_TITLE.agents)}
          </>
        ) : props.section === "mcpServers" ? (
          mcpServers
        ) : (
          renderRows(sections[props.section], SECTION_TITLE[props.section])
        )}
        <div className="flex flex-col gap-1 px-2 pb-1 text-2xs text-muted-foreground">
          {providerNote === null ? null : <p>{providerNote}</p>}
          {freshness === null ? null : <p>MCP servers · {freshness}</p>}
          {threadExtensionsFootnotes(shell).map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}

/** A collapsible section's header with its used and unused counts. */
function ExtensionSectionHeader(props: {
  readonly title: string;
  readonly section: ThreadExtensionSection;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <CollapsibleSectionHeader
      expanded={props.expanded}
      onClick={props.onToggle}
      accessory={
        <span className="text-2xs font-normal tabular-nums text-muted-foreground">
          {threadExtensionSectionCountLabel(props.section)}
        </span>
      }
    >
      {props.title}
    </CollapsibleSectionHeader>
  );
}

function ExtensionSection(props: {
  readonly title: string;
  readonly section: ThreadExtensionSection;
  readonly standalone: boolean;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { used, unused } = props.section;
  const collapsible = unused.length > UNUSED_PREVIEW_LIMIT;
  const [showUnused, setShowUnused] = useState(false);
  // Expansion follows the data until the user picks a side; the key resets it per thread.
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
  const expanded =
    props.standalone || (expandedChoice ?? threadExtensionSectionExpandedByDefault(props.section));
  if (used.length === 0 && unused.length === 0) return null;

  return (
    <section aria-label={props.title} className="flex flex-col">
      {props.standalone ? null : (
        <ExtensionSectionHeader
          title={props.title}
          section={props.section}
          expanded={expanded}
          onToggle={() => setExpandedChoice(!expanded)}
        />
      )}
      {expanded ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {used.map((row) => (
            <ExtensionRow
              key={row.name}
              row={row}
              threadId={props.threadId}
              onOpenThread={props.onOpenThread}
            />
          ))}
          {!collapsible || showUnused
            ? unused.map((row) => (
                <ExtensionRow
                  key={row.name}
                  row={row}
                  threadId={props.threadId}
                  onOpenThread={props.onOpenThread}
                />
              ))
            : null}
        </ul>
      ) : null}
      {expanded && collapsible ? (
        <Button
          size="micro"
          variant="ghost-muted"
          className="self-start"
          aria-expanded={showUnused}
          onClick={() => setShowUnused(!showUnused)}
        >
          {showUnused ? "Hide unused" : `Show ${unused.length} loaded but unused`}
        </Button>
      ) : null}
    </section>
  );
}

function ExtensionRow(props: {
  readonly row: ThreadExtensionRow;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { row } = props;
  const used = row.count > 0;
  const lastUsed =
    row.lastUsedAt === null ? null : formatRelativeTimeLabel(DateTime.formatIso(row.lastUsedAt));
  const subagentThreadId =
    row.lastItem !== null && row.lastItem.threadId !== props.threadId
      ? row.lastItem.threadId
      : null;
  const tools = row.tools ?? [];
  const toolsLabel = tools.map((tool) => `${tool.name} ×${tool.count}`).join(", ");

  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1",
        used ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm">{threadExtensionDisplayName(row)}</span>
        {row.plugin === null ? null : (
          <Badge size="sm" variant="outline">
            {row.plugin}
          </Badge>
        )}
        {row.version === undefined ? null : (
          <span className="shrink-0 text-2xs text-muted-foreground">v{row.version}</span>
        )}
        <span className="ms-auto flex shrink-0 items-center gap-1 text-2xs tabular-nums text-muted-foreground">
          {used ? <span>Used ×{row.count}</span> : null}
          {subagentThreadId === null ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label="Open the subagent thread that used it last"
                    onClick={() => props.onOpenThread(subagentThreadId)}
                  />
                }
              >
                <ArrowRightIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="left">Last used in a subagent. Open its thread.</TooltipPopup>
            </Tooltip>
          )}
        </span>
      </div>
      {lastUsed ? <p className="text-2xs text-muted-foreground">Last used {lastUsed}</p> : null}
      {toolsLabel ? (
        <p className="text-2xs break-words text-muted-foreground">{toolsLabel}</p>
      ) : null}
    </li>
  );
}

function McpServerSection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly section: ThreadExtensionSection;
  readonly live: boolean;
  readonly standalone: boolean;
  readonly onRefresh: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, threadId } = props.threadRef;
  const shell = useThreadShell(props.threadRef);
  const config = useServerConfigs().get(environmentId) ?? null;
  const permitted = useAtomValue(
    orchestrationEnvironment.controlMcpServer.permissionAtom(environmentId),
  );
  const controlMcpServer = useAtomCommand(orchestrationEnvironment.controlMcpServer, {
    label: "reconnect MCP server",
    reportFailure: false,
  });
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [showUnused, setShowUnused] = useState(false);
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
  const expanded =
    props.standalone || (expandedChoice ?? threadExtensionSectionExpandedByDefault(props.section));
  if (props.section.used.length === 0 && props.section.unused.length === 0) return null;
  const rows = mcpServerRows(props.section, { live: props.live, permitted, config, shell });
  // The dialog lists every server; the right panel folds loaded-but-unused ones past the limit.
  const foldedCount = rows.filter((view) => view.foldable).length;
  const collapsible = !props.standalone && foldedCount > UNUSED_PREVIEW_LIMIT;

  const reconnect = async (view: McpServerRowView) => {
    if (reconnecting !== null) return;
    setReconnecting(view.row.name);
    setAnnouncement(`Reconnecting ${view.label}…`);
    const result = await controlMcpServer({
      environmentId,
      input: { threadId, server: view.row.name, action: "reconnect" },
    });
    setReconnecting(null);
    if (result._tag === "Success") {
      setAnnouncement(`Reconnected ${view.label}.`);
    } else {
      const error = squashAtomCommandFailure(result);
      setAnnouncement(
        `${view.label}: ${error instanceof Error ? error.message : "Could not reconnect the MCP server."}`,
      );
    }
    props.onRefresh();
  };

  return (
    <section aria-label={SECTION_TITLE.mcpServers} className="flex flex-col">
      {props.standalone ? null : (
        <ExtensionSectionHeader
          title={SECTION_TITLE.mcpServers}
          section={props.section}
          expanded={expanded}
          onToggle={() => setExpandedChoice(!expanded)}
        />
      )}
      {expanded ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {(collapsible && !showUnused ? rows.filter((view) => !view.foldable) : rows).map(
            (view) => (
              <McpServerRow
                key={view.row.name}
                view={view}
                threadId={threadId}
                reconnecting={reconnecting === view.row.name}
                onReconnect={() => void reconnect(view)}
                onOpenThread={props.onOpenThread}
              />
            ),
          )}
        </ul>
      ) : null}
      {expanded && collapsible ? (
        <Button
          size="micro"
          variant="ghost-muted"
          className="self-start"
          aria-expanded={showUnused}
          onClick={() => setShowUnused(!showUnused)}
        >
          {showUnused ? "Hide unused" : `Show ${foldedCount} loaded but unused`}
        </Button>
      ) : null}
      <p aria-live="polite" className="px-2 text-2xs break-words text-muted-foreground">
        {announcement}
      </p>
    </section>
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
  const [showAllTools, setShowAllTools] = useState(false);
  const tools = row.availableTools ?? [];
  const lastUsed =
    row.lastUsedAt === null ? null : formatRelativeTimeLabel(DateTime.formatIso(row.lastUsedAt));
  const calls = (row.tools ?? []).map((tool) => `${tool.name} ×${tool.count}`).join(", ");
  const subagentThreadId =
    row.lastItem !== null && row.lastItem.threadId !== props.threadId
      ? row.lastItem.threadId
      : null;

  const summary = (
    <>
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", STATUS_DOT_CLASS[view.tone])}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "min-w-0 truncate text-sm",
                row.count > 0 ? "text-foreground" : "text-muted-foreground",
              )}
            />
          }
        >
          {view.label}
        </TooltipTrigger>
        <TooltipPopup side="top">{view.label}</TooltipPopup>
      </Tooltip>
      {view.badge === null ? null : (
        <Badge size="sm" variant="outline">
          {view.badge}
        </Badge>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-1.5 text-2xs tabular-nums text-muted-foreground">
        {view.statusLabel === null ? null : <span>{view.statusLabel}</span>}
        {tools.length > 0 ? (
          <span>{tools.length === 1 ? "1 tool" : `${tools.length} tools`}</span>
        ) : null}
        {row.count > 0 ? <span>Used ×{row.count}</span> : null}
      </span>
    </>
  );
  const subagentLink =
    subagentThreadId === null ? null : (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label="Open the subagent thread that used it last"
              onClick={() => props.onOpenThread(subagentThreadId)}
            />
          }
        >
          <ArrowRightIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="left">Last used in a subagent. Open its thread.</TooltipPopup>
      </Tooltip>
    );
  // Always in view, like the other sections' rows: what this thread did with the server.
  const usage =
    lastUsed === null && !calls ? null : (
      <div className="flex flex-col gap-0.5 px-2 pb-1 ps-5.5 text-2xs text-muted-foreground">
        {lastUsed === null ? null : <p>Last used {lastUsed}</p>}
        {calls ? <p className="break-words">Called {calls}</p> : null}
      </div>
    );

  if (!view.hasDetail) {
    return (
      <li className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5 px-2 py-1">
          {summary}
          {subagentLink}
        </div>
        {usage}
      </li>
    );
  }

  return (
    <li className="min-w-0">
      <Collapsible>
        <div className="flex min-w-0 items-center gap-1">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            {summary}
          </CollapsibleTrigger>
          {subagentLink}
        </div>
        {usage}
        <CollapsiblePanel>
          <div className="flex flex-col items-start gap-1.5 px-2 pt-0.5 pb-2 ps-5.5 text-2xs text-muted-foreground">
            {row.error === undefined ? null : (
              <p className="break-words text-destructive-foreground">{row.error}</p>
            )}
            {view.hint === null ? null : <p>{view.hint}</p>}
            {tools.length === 0 ? null : (
              <p className="break-words">
                {(showAllTools ? tools : tools.slice(0, MCP_SERVER_TOOL_PREVIEW_LIMIT)).join(", ")}
              </p>
            )}
            {tools.length > MCP_SERVER_TOOL_PREVIEW_LIMIT ? (
              <Button
                size="micro"
                variant="ghost-muted"
                aria-expanded={showAllTools}
                onClick={() => setShowAllTools(!showAllTools)}
              >
                {showAllTools ? "Show fewer" : `Show all ${tools.length}`}
              </Button>
            ) : null}
            {view.reconnect === null ? null : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`Reconnect ${view.label}`}
                  disabled={props.reconnecting || view.reconnect.disabledReason !== null}
                  onClick={props.onReconnect}
                >
                  {props.reconnecting ? "Reconnecting…" : "Reconnect"}
                </Button>
                {view.reconnect.disabledReason === null ? null : (
                  <span>{view.reconnect.disabledReason}</span>
                )}
              </div>
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}
