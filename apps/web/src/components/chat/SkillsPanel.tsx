/**
 * Skills & plugins right-panel surface: the MCP servers, skills, plugins and
 * agents the thread used, from `orchestration.getThreadExtensions`, beside
 * what the provider session loaded and the provider's own skill folders hold.
 * The /mcp and /skills dialog renders one section of it.
 *
 * The query is keyed by the thread's run boundaries, so the panel refreshes
 * when a run starts or settles instead of on every item or polling.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  filterThreadExtensionSections,
  MCP_SERVER_TOOL_PREVIEW_LIMIT,
  mcpServerGroups,
  mcpServerMetaLabel,
  mcpServerRows,
  pluginRowView,
  sectionWithMatches,
  skillStartText,
  skillStateBadges,
  THREAD_EXTENSION_SECTION_ORDER,
  THREAD_EXTENSION_SECTION_TITLES,
  threadExtensionDisplayName,
  threadExtensionGroups,
  threadExtensionSectionCountLabel,
  threadExtensionSectionExpandedByDefault,
  threadExtensionSections,
  threadExtensionsEmptyState,
  threadExtensionsFootnotes,
  threadExtensionsInventoryNote,
  threadExtensionsMatchStatus,
  threadExtensionsNoMatchState,
  threadExtensionsProvider,
  threadExtensionsRevision,
  threadExtensionsSummary,
  threadExtensionUsesLabel,
  type McpServerRowView,
  type McpServerStatusTone,
  type PluginRowView,
  type ThreadExtensionGroup,
  type ThreadExtensionRow,
  type ThreadExtensionSection,
  type ThreadExtensionSectionKey,
  type ThreadExtensionsSummaryPart,
} from "@t3tools/client-runtime/state/thread-extensions";
import type {
  OrchestrationV2ThreadExtensions,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { Check, Copy } from "lucide";
import {
  ArrowRightIcon,
  ChevronRightIcon,
  PuzzleIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  Fragment,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useProject, useServerConfigs, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Kbd } from "../ui/kbd";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { extensionListKeyTarget, NAV_ITEM_SELECTOR } from "./extensionListNavigation";

const STATUS_DOT_CLASS: Record<McpServerStatusTone, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/40",
};

/** Failed and Needs sign-in read in their own tone; other statuses stay muted. */
const STATUS_WORD_CLASS: Record<McpServerStatusTone, string | undefined> = {
  ok: undefined,
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
  neutral: undefined,
};

type McpServerRowsContext = Parameters<typeof mcpServerRows>[1];

/** The thread's extensions query, keeping the last result while a new revision loads. */
export function useThreadExtensions(threadRef: ScopedThreadRef) {
  const { environmentId, threadId } = threadRef;
  const shell = useThreadShell(threadRef);
  const config = useServerConfigs().get(environmentId) ?? null;
  const project = useProject(
    shell === null ? null : scopeProjectRef(environmentId, shell.projectId),
  );
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

  // The composer's rules: the runtime's instance first, and the skills for the thread's folder.
  const providers = config?.providers ?? null;
  const instanceId = shell?.runtime?.providerInstanceId ?? shell?.providerInstanceId ?? null;
  const cwd =
    project === null
      ? null
      : projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: shell?.worktreePath ?? null,
        });
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
  return { shell, config, query, data, sections, provider };
}

interface SkillsPanelProps {
  readonly threadRef: ScopedThreadRef;
  /** Show only this section (the dialog); the right panel stacks all four under its own search. */
  readonly section?: ThreadExtensionSectionKey;
  /** The dialog's search. */
  readonly query?: string;
  /** The dialog's search field, which ArrowUp on the first row returns to. */
  readonly searchRef?: RefObject<HTMLInputElement | null>;
  /** Runs before a row opens a subagent thread, so a dialog can close first. */
  readonly onNavigate?: () => void;
  /** "Show {Section}" when the search matches only in another section. */
  readonly onShowSection?: (section: ThreadExtensionSectionKey) => void;
  readonly onClearQuery?: () => void;
}

export function SkillsPanel(props: SkillsPanelProps) {
  // Group toggles, the panel's search and Reconnect state belong to one thread.
  return (
    <ThreadSkillsPanel
      key={`${props.threadRef.environmentId}:${props.threadRef.threadId}`}
      {...props}
    />
  );
}

function ThreadSkillsPanel(props: SkillsPanelProps) {
  const { environmentId, threadId } = props.threadRef;
  const { shell, config, query, data, sections, provider } = useThreadExtensions(props.threadRef);
  const [panelQuery, setPanelQuery] = useState("");
  const panelSearchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const search = props.section === undefined ? panelQuery : (props.query ?? "");
  const searching = search.trim() !== "";
  const filtered = useMemo(
    () => filterThreadExtensionSections(sections, search),
    [sections, search],
  );
  // The user's open or closed choice per section and group id; otherwise each one's default.
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const isOpen = (id: string, byDefault: boolean) => toggles.get(id) ?? byDefault;
  const setOpen = (id: string, open: boolean) =>
    setToggles((current) => new Map(current).set(id, open));

  // Reconnect lives here, not in the MCP list: collapsing or searching the list away
  // mid-request must neither lose the result nor allow a second request.
  const permitted = useAtomValue(
    orchestrationEnvironment.controlMcpServer.permissionAtom(environmentId),
  );
  const controlMcpServer = useAtomCommand(orchestrationEnvironment.controlMcpServer, {
    label: "reconnect MCP server",
    reportFailure: false,
  });
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
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
    query.refresh();
  };

  const navigate = useNavigate();
  const openThread = (childThreadId: ThreadId) => {
    props.onNavigate?.();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, childThreadId)),
    });
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = extensionListKeyTarget(event.currentTarget, document.activeElement, event.key);
    if (target === null) return;
    event.preventDefault();
    if (target === "search") (props.searchRef ?? panelSearchRef).current?.focus();
    else target.focus();
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

  const live = data.mcpServersLive === true;
  const providerNote = threadExtensionsInventoryNote(sections.inventoryStatus, live);
  const count = (section: ThreadExtensionSection) => section.used.length + section.unused.length;

  const renderGroups = (key: ThreadExtensionSectionKey) =>
    key === "mcpServers" ? (
      <McpServerGroups
        threadId={threadId}
        section={filtered.mcpServers}
        live={live}
        permitted={permitted}
        config={config}
        shell={shell}
        reconnecting={reconnecting}
        onReconnect={(view) => void reconnect(view)}
        isOpen={isOpen}
        onOpenChange={setOpen}
        onOpenThread={openThread}
      />
    ) : (
      <ExtensionGroups
        groups={threadExtensionGroups(key, filtered[key])}
        isOpen={isOpen}
        onOpenChange={setOpen}
        rowKey={(row) => row.name}
        renderRow={(row, group) => {
          // Only Used in this thread mixes sources, so only its rows say where they come from.
          const inUsedGroup = group.id === `${key}:used`;
          return key === "skills" ? (
            <SkillRow
              row={row}
              sourceBadge={inUsedGroup ? (row.sourceLabel ?? null) : null}
              driver={provider?.driver ?? null}
              threadId={threadId}
              onOpenThread={openThread}
            />
          ) : (
            <ExtensionRow
              row={row}
              badge={key === "agents" && inUsedGroup ? (row.plugin ?? "Other") : null}
              plugin={key === "plugins" ? pluginRowView(row, sections) : null}
              threadId={threadId}
              onOpenThread={openThread}
            />
          );
        }}
      />
    );
  // Mounted in every list, so it announces a Reconnect that settles after its row is gone.
  const reconnectStatus = (
    <p
      aria-live="polite"
      className={
        announcement === "" ? "sr-only" : "px-2 text-2xs break-words text-muted-foreground"
      }
    >
      {announcement}
    </p>
  );
  const footer = (
    <div className="flex flex-col gap-1 px-2 pb-1 text-2xs text-muted-foreground">
      {providerNote === null ? null : <p>{providerNote}</p>}
      {threadExtensionsFootnotes(shell).map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );

  if (props.section !== undefined) {
    const key = props.section;
    const shown = count(filtered[key]);
    // A search, even in an empty section, says what matched here and where else.
    const noMatch = searching
      ? threadExtensionsNoMatchState(key, search, sectionWithMatches(filtered, key))
      : null;
    const notice = noMatch ?? threadExtensionsEmptyState(key, sections.inventoryStatus, live);
    return (
      <ScrollArea className="h-full min-h-0">
        <div ref={listRef} className="flex flex-col gap-3 p-2" onKeyDown={onListKeyDown}>
          {/* Stays mounted so a screen reader announces each new count. */}
          <p
            role="status"
            aria-atomic="true"
            className={searching ? "px-2 text-2xs text-muted-foreground" : "sr-only"}
          >
            {searching ? threadExtensionsMatchStatus(key, shown, count(sections[key])) : ""}
          </p>
          {reconnectStatus}
          {shown > 0 ? (
            renderGroups(key)
          ) : (
            <EmptyState
              title={notice.title}
              description={notice.description}
              {...(noMatch === null
                ? {}
                : {
                    action: {
                      label: noMatch.action.label,
                      onClick: () => {
                        const target = noMatch.action.showSection;
                        if (target === null) props.onClearQuery?.();
                        else props.onShowSection?.(target);
                      },
                    },
                  })}
            />
          )}
          {footer}
        </div>
      </ScrollArea>
    );
  }

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

  const summary = threadExtensionsSummary(sections, data);
  const listed = THREAD_EXTENSION_SECTION_ORDER.filter((key) => count(sections[key]) > 0);
  const matching = listed.filter((key) => count(filtered[key]) > 0);
  const clearPanelSearch = () => {
    setPanelQuery("");
    panelSearchRef.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 px-2 pt-2">
        {summary.length === 0 ? null : (
          <p className="px-2 text-2xs text-muted-foreground">
            <ThreadExtensionsSummary parts={summary} />
          </p>
        )}
        <ThreadExtensionsSearch
          inputRef={panelSearchRef}
          value={panelQuery}
          onValueChange={setPanelQuery}
          onArrowDown={() =>
            listRef.current?.querySelector<HTMLElement>(NAV_ITEM_SELECTOR)?.focus()
          }
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div ref={listRef} className="flex flex-col gap-3 p-2" onKeyDown={onListKeyDown}>
          {/* The section headers show the counts; this announces them. */}
          <p role="status" aria-atomic="true" className="sr-only">
            {searching
              ? listed
                  .map((key) =>
                    threadExtensionsMatchStatus(key, count(filtered[key]), count(sections[key])),
                  )
                  .join(". ")
              : ""}
          </p>
          {reconnectStatus}
          {matching.length === 0 ? (
            <EmptyState
              // No section key names the whole panel, so this title is its own.
              title={`Nothing matches "${search.trim()}"`}
              description={threadExtensionsNoMatchState("skills", search, null).description}
              action={{ label: "Clear search", onClick: clearPanelSearch }}
            />
          ) : (
            matching.map((key) => {
              const section = filtered[key];
              const open = isOpen(
                key,
                searching || threadExtensionSectionExpandedByDefault(section),
              );
              const title = THREAD_EXTENSION_SECTION_TITLES[key].title;
              return (
                <section key={key} aria-label={title} className="flex flex-col">
                  <h2 className="m-0">
                    <CollapsibleSectionHeader
                      data-nav-item
                      tone="emphasized"
                      expanded={open}
                      onClick={() => setOpen(key, !open)}
                      accessory={
                        <span className="text-2xs font-normal tabular-nums text-muted-foreground">
                          {threadExtensionSectionCountLabel(section)}
                        </span>
                      }
                    >
                      {title}
                    </CollapsibleSectionHeader>
                  </h2>
                  {open ? <div className="ps-2">{renderGroups(key)}</div> : null}
                </section>
              );
            })
          )}
          {footer}
        </div>
      </ScrollArea>
    </div>
  );
}

/** The summary line's parts, split by a dot screen readers skip; a warning carries an icon. */
export function ThreadExtensionsSummary(props: {
  readonly parts: ReadonlyArray<ThreadExtensionsSummaryPart>;
}) {
  return (
    <>
      {props.parts.map((part, index) => (
        <Fragment key={part.text}>
          {index === 0 ? null : (
            <>
              {" "}
              <span aria-hidden>·</span>{" "}
            </>
          )}
          {part.tone === "warning" ? (
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-warning-foreground">
              <TriangleAlertIcon aria-hidden className="size-3" />
              {part.text}
            </span>
          ) : (
            <span className="whitespace-nowrap">{part.text}</span>
          )}
        </Fragment>
      ))}
    </>
  );
}

/** Searches every section; ArrowDown moves into the list. The dialog shows its "/" shortcut. */
export function ThreadExtensionsSearch({
  inputRef,
  value,
  onValueChange,
  onArrowDown,
  shortcutHint = false,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onArrowDown: () => void;
  readonly shortcutHint?: boolean;
}) {
  return (
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon aria-hidden className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="search"
        size="sm"
        placeholder="Search"
        aria-label="Search MCP servers, skills, plugins and agents"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          onArrowDown();
        }}
      />
      {value !== "" ? (
        <InputGroupAddon align="inline-end">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Clear search"
            onClick={() => {
              onValueChange("");
              inputRef.current?.focus();
            }}
          >
            <XIcon aria-hidden />
          </Button>
        </InputGroupAddon>
      ) : shortcutHint ? (
        <InputGroupAddon align="inline-end">
          <Kbd aria-hidden>/</Kbd>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

/** An empty or no-match section: what is missing, why, and what to do. */
function EmptyState(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.action === undefined ? null : (
        <Button size="xs" variant="outline" onClick={props.action.onClick}>
          {props.action.label}
        </Button>
      )}
    </Empty>
  );
}

/** A section's groups under their headers. Only open groups render rows. */
function ExtensionGroups<Row>(props: {
  readonly groups: ReadonlyArray<ThreadExtensionGroup<Row>>;
  readonly isOpen: (id: string, byDefault: boolean) => boolean;
  readonly onOpenChange: (id: string, open: boolean) => void;
  readonly rowKey: (row: Row) => string;
  readonly renderRow: (row: Row, group: ThreadExtensionGroup<Row>) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      {props.groups.map((group) => {
        const open = props.isOpen(group.id, group.expandedByDefault);
        return (
          <div key={group.id} className="flex flex-col">
            <h3 className="m-0">
              <CollapsibleSectionHeader
                data-nav-item
                tone="emphasized"
                expanded={open}
                onClick={() => props.onOpenChange(group.id, !open)}
                accessory={
                  <span
                    className={cn(
                      "text-2xs font-normal tabular-nums",
                      group.tone === "warning"
                        ? "text-warning-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {group.countLabel}
                  </span>
                }
              >
                {group.label}
              </CollapsibleSectionHeader>
            </h3>
            {open ? (
              <ul className="m-0 flex list-none flex-col p-0">
                {group.rows.map((row) => (
                  <Fragment key={props.rowKey(row)}>{props.renderRow(row, group)}</Fragment>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** "3 uses · 5m ago", or null for something never used. */
function usesMeta(row: ThreadExtensionRow): string | null {
  const uses = threadExtensionUsesLabel(row.count);
  if (uses === null || row.lastUsedAt === null) return uses;
  return `${uses} · ${formatRelativeTimeLabel(DateTime.formatIso(row.lastUsedAt))}`;
}

/** Points right, and down once its trigger's panel opens. */
function RowChevron() {
  return (
    <ChevronRightIcon
      aria-hidden
      className="size-3 shrink-0 transition-transform motion-reduce:transition-none group-data-panel-open:rotate-90"
    />
  );
}

/** Opens the subagent's thread when a subagent made the row's latest use. */
function SubagentLink(props: {
  readonly row: ThreadExtensionRow;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const lastItem = props.row.lastItem;
  if (lastItem === null || lastItem.threadId === props.threadId) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Open the subagent thread that used it last"
            onClick={() => props.onOpenThread(lastItem.threadId)}
          />
        }
      >
        <ArrowRightIcon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="left">Last used in a subagent. Open its thread.</TooltipPopup>
    </Tooltip>
  );
}

/** Copies how to start a skill, confirmed by the anchored "Copied!" toast. */
function CopyInvocationButton(props: { readonly text: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            size="icon-micro"
            variant="ghost-muted"
            aria-label={`Copy ${props.text}`}
            onClick={() => copyToClipboard(props.text, undefined)}
          />
        }
      >
        <MorphIcon
          className={cn("size-3", isCopied && "text-success")}
          icon={isCopied ? Check : Copy}
        />
      </TooltipTrigger>
      <TooltipPopup>Copy</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One skill: its name, where it comes from (in Used in this thread), its
 * state and uses over one line of what it does. It opens to the full text,
 * its file, how to start it and what its state means.
 */
function SkillRow(props: {
  readonly row: ThreadExtensionRow;
  readonly sourceBadge: string | null;
  readonly driver: string | null;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { row } = props;
  const badges = skillStateBadges(row);
  const meta = usesMeta(row);
  const startText = skillStartText(row, props.driver);

  return (
    <li className="min-w-0">
      <Collapsible>
        <div className="flex min-w-0 items-center gap-1">
          <CollapsibleTrigger
            data-nav-item
            className="group flex min-w-0 flex-1 flex-col justify-center gap-px rounded-md px-2 py-1 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
          >
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-sm text-foreground">
                {threadExtensionDisplayName(row)}
              </span>
              {props.sourceBadge === null ? null : (
                <Badge size="sm" variant="outline">
                  {props.sourceBadge}
                </Badge>
              )}
              {badges.map((badge) => (
                <Badge key={badge.label} size="sm" variant="outline">
                  {badge.label}
                </Badge>
              ))}
              <span className="ms-auto flex shrink-0 items-center gap-1.5 text-2xs tabular-nums text-muted-foreground">
                {meta === null ? null : <span>{meta}</span>}
                <RowChevron />
              </span>
            </span>
            {row.description === undefined ? null : (
              <span className="w-full truncate text-xs text-muted-foreground">
                {row.description}
              </span>
            )}
          </CollapsibleTrigger>
          <SubagentLink row={row} threadId={props.threadId} onOpenThread={props.onOpenThread} />
        </div>
        <CollapsiblePanel>
          <div className="flex flex-col items-start gap-1.5 px-2 pt-0.5 pb-2 text-xs text-muted-foreground">
            <p className="max-w-prose break-words text-foreground">
              {row.description ?? "No description."}
            </p>
            {row.path === undefined ? null : (
              <p className="flex max-w-full text-2xs">
                <MiddleTruncate value={row.path} />
              </p>
            )}
            {startText === null ? null : (
              <p className="flex items-center gap-1.5">
                Start it with
                <code className="rounded border bg-muted px-1 font-mono text-2xs text-foreground">
                  {startText}
                </code>
                <CopyInvocationButton text={startText} />
              </p>
            )}
            {badges.map((badge) => (
              <p key={badge.label}>{badge.sentence}</p>
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

/** An agent or plugin: its name, source (in Used in this thread), version and uses; a plugin adds what it ships. */
function ExtensionRow(props: {
  readonly row: ThreadExtensionRow;
  readonly badge: string | null;
  readonly plugin: PluginRowView | null;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { row, plugin } = props;
  const meta = usesMeta(row);

  return (
    <li className="flex min-w-0 flex-col gap-px rounded-md px-2 py-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm text-foreground">
          {threadExtensionDisplayName(row)}
        </span>
        {props.badge === null ? null : (
          <Badge size="sm" variant="outline">
            {props.badge}
          </Badge>
        )}
        {row.version === undefined ? null : (
          <span className="shrink-0 text-2xs text-muted-foreground">v{row.version}</span>
        )}
        <span className="ms-auto flex shrink-0 items-center gap-1 text-2xs tabular-nums text-muted-foreground">
          {meta === null ? null : <span>{meta}</span>}
          <SubagentLink row={row} threadId={props.threadId} onOpenThread={props.onOpenThread} />
        </span>
      </div>
      {plugin === null ? null : (
        <p className="break-words text-xs text-muted-foreground">
          {plugin.contents}
          {plugin.problems === null ? null : (
            <>
              {" · "}
              <span className="text-warning-foreground">{plugin.problems}</span>
            </>
          )}
        </p>
      )}
    </li>
  );
}

function McpServerGroups(props: {
  readonly threadId: ThreadId;
  readonly section: ThreadExtensionSection;
  readonly live: boolean;
  readonly permitted: boolean;
  readonly config: McpServerRowsContext["config"];
  readonly shell: McpServerRowsContext["shell"];
  /** The server a Reconnect is in flight for. */
  readonly reconnecting: string | null;
  readonly onReconnect: (view: McpServerRowView) => void;
  readonly isOpen: (id: string, byDefault: boolean) => boolean;
  readonly onOpenChange: (id: string, open: boolean) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const rows = mcpServerRows(props.section, {
    live: props.live,
    permitted: props.permitted,
    config: props.config,
    shell: props.shell,
  });
  return (
    <ExtensionGroups
      groups={mcpServerGroups(rows)}
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      rowKey={(view) => view.row.name}
      renderRow={(view) => (
        <McpServerRow
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
  const meta = mcpServerMetaLabel(row);

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
        {view.statusLabel === null ? null : (
          <span className={STATUS_WORD_CLASS[view.tone]}>{view.statusLabel}</span>
        )}
        {meta === null ? null : <span>{meta}</span>}
        {view.hasDetail ? <RowChevron /> : null}
      </span>
    </>
  );
  const subagentLink = (
    <SubagentLink row={row} threadId={props.threadId} onOpenThread={props.onOpenThread} />
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
          <CollapsibleTrigger
            data-nav-item
            className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
          >
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
