/**
 * Skills & plugins right-panel surface: the skills, plugins, MCP servers and
 * agents the thread used, from `orchestration.getThreadExtensions`, beside
 * what the active provider session loaded but did not use.
 *
 * The query is keyed by the thread's run boundaries, so the panel refreshes
 * when a run starts or settles instead of on every item or polling.
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
import { useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Loaded-but-unused rows past this many start collapsed. */
const UNUSED_PREVIEW_LIMIT = 4;

const STATUS_BADGE_VARIANT: Record<
  McpServerStatusTone,
  "success" | "warning" | "error" | "outline"
> = {
  ok: "success",
  warning: "warning",
  error: "error",
  neutral: "outline",
};

export function SkillsPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = props.threadRef;
  const shell = useThreadShell(props.threadRef);
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

  const navigate = useNavigate();
  const openThread = (childThreadId: ThreadId) => {
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

  const providerNote = threadExtensionsInventoryNote(sections.inventoryStatus);

  if (sections.isEmpty) {
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
      key={title}
      title={title}
      section={section}
      threadId={threadId}
      onOpenThread={openThread}
    />
  );

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-3 p-2">
        {renderRows(sections.skills, "Skills")}
        {renderRows(sections.plugins, "Plugins")}
        {renderRows(sections.mcpServers, "MCP servers")}
        {renderRows(sections.agents, "Agents")}
        <div className="flex flex-col gap-1 px-2 pb-1 text-2xs text-muted-foreground">
          {providerNote === null ? null : <p>{providerNote}</p>}
          {threadExtensionsFootnotes(shell).map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      </div>
    </ScrollArea>
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

  return (
    <section aria-label={props.title} className="flex flex-col">
      <h3 className="flex h-7 items-center justify-between gap-2 px-2 text-xs font-medium text-muted-foreground">
        <span>{props.title}</span>
        <span className="text-2xs font-normal tabular-nums">
          {threadExtensionSectionCountLabel(props.section)}
        </span>
      </h3>
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
      {collapsible ? (
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
        {row.status === undefined ? null : (
          <Badge size="sm" variant={STATUS_BADGE_VARIANT[mcpServerStatusTone(row.status)]}>
            {row.status}
          </Badge>
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
