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
import {
  MCP_SIGN_IN_IDLE,
  MCP_SIGN_IN_POLL_MS,
  MCP_SIGN_IN_TEXT,
  mcpSignInErrorCode,
  mcpSignInErrorText,
  mcpSignInMessage,
  mcpSignInPasteError,
  mcpSignInPolling,
  mcpSignInReducer,
  mcpSignOutText,
  type McpSignInState,
} from "@t3tools/client-runtime/state/mcp-sign-in";
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
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { useProject, useServerConfigs, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import { Input } from "../ui/input";
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
  // Group toggles, the panel's search, Reconnect and sign-in state belong to one thread.
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

  // Sign in and Sign out live here too, for the same reasons. One sign-in runs per panel.
  const controlMcpServerAuth = useAtomCommand(orchestrationEnvironment.controlMcpServerAuth, {
    label: "sign in to MCP server",
    reportFailure: false,
    reportDefect: false,
  });
  const [signIn, dispatchSignIn] = useReducer(mcpSignInReducer, MCP_SIGN_IN_IDLE);
  const [signInLabel, setSignInLabel] = useState("");
  // Bumped by every new or cancelled sign-in, so a late answer can't land on the next one.
  const signInAttempt = useRef(0);
  const signInFailed = (error: unknown) =>
    dispatchSignIn({ type: "failed", code: mcpSignInErrorCode(error) });
  const startSignIn = async (view: McpServerRowView) => {
    if (signIn.phase === "starting" || signIn.phase === "finishing") return;
    const attempt = ++signInAttempt.current;
    setSignInLabel(view.label);
    dispatchSignIn({ type: "start", server: view.row.name });
    const result = await controlMcpServerAuth({
      environmentId,
      input: { threadId, server: view.row.name, action: "sign-in" },
    });
    if (attempt !== signInAttempt.current) return;
    if (result._tag === "Success") {
      // oxlint-disable-next-line react/purity -- A click handler, once the request answers.
      dispatchSignIn({ type: "started", result: result.value, now: Date.now() });
    } else {
      signInFailed(squashAtomCommandFailure(result));
    }
  };
  const finishSignIn = async (callbackUrl: string) => {
    if (signIn.phase !== "waiting" || !signIn.callbackExpected) return false;
    const attempt = signInAttempt.current;
    // oxlint-disable-next-line react/purity -- A submit handler.
    dispatchSignIn({ type: "submit", now: Date.now() });
    const result = await controlMcpServerAuth({
      environmentId,
      input: { threadId, server: signIn.server, action: "finish-sign-in", callbackUrl },
    });
    if (attempt !== signInAttempt.current) return false;
    if (result._tag === "Failure") signInFailed(squashAtomCommandFailure(result));
    query.refresh();
    return result._tag === "Failure";
  };
  // A claude.ai connector has no redirect to paste, and a failed sign-in's fallback happens
  // elsewhere: reconnecting shows whether it took.
  const checkConnection = async (view: McpServerRowView) => {
    if (reconnecting !== null) return;
    const attempt = signInAttempt.current;
    setReconnecting(view.row.name);
    const result = await controlMcpServer({
      environmentId,
      input: { threadId, server: view.row.name, action: "reconnect" },
    });
    setReconnecting(null);
    if (attempt === signInAttempt.current) {
      // A reconnect succeeds only once the server connects; nothing polls these waits.
      if (result._tag === "Success") {
        // oxlint-disable-next-line react/purity -- A click handler, once the request answers.
        dispatchSignIn({ type: "status", status: "connected", now: Date.now() });
      } else {
        signInFailed(squashAtomCommandFailure(result));
      }
    }
    query.refresh();
  };
  // Local only: the server has no cancel, and the provider drops the sign-in after five minutes.
  const cancelSignIn = () => {
    signInAttempt.current += 1;
    dispatchSignIn({ type: "cancel" });
  };
  // The page is http(s) only: mcpSignInReducer drops any other scheme before it sets openUrl.
  const openSignInPage = (url: string) =>
    void readLocalApi()
      ?.shell.openExternal(url)
      .catch(() => setAnnouncement("Could not open the sign-in page."));

  // No event says a sign-in finished, so read the live status while one waits.
  const signInPolling = mcpSignInPolling(signIn);
  const signInStatus =
    signIn.phase === "idle"
      ? undefined
      : [...sections.mcpServers.used, ...sections.mcpServers.unused].find(
          (row) => row.name === signIn.server,
        )?.status;
  const pollSignIn = useEffectEvent(() => {
    dispatchSignIn({ type: "status", status: signInStatus, now: Date.now() });
    query.refresh();
  });
  useEffect(() => {
    if (!signInPolling) return;
    // A changed status counts at once; every tick reads it again, which also runs the expiry.
    dispatchSignIn({ type: "status", status: signInStatus, now: Date.now() });
    const timer = window.setInterval(pollSignIn, MCP_SIGN_IN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [signInPolling, signInStatus]);

  const [signOutTarget, setSignOutTarget] = useState<McpServerRowView | null>(null);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const signOut = async (view: McpServerRowView) => {
    setSignOutTarget(null);
    if (signingOut !== null) return;
    // A finished sign-in's "Signed in" would contradict the sign-out.
    if (signIn.phase !== "idle" && signIn.server === view.row.name) cancelSignIn();
    setSigningOut(view.row.name);
    const result = await controlMcpServerAuth({
      environmentId,
      input: { threadId, server: view.row.name, action: "sign-out" },
    });
    setSigningOut(null);
    setAnnouncement(
      result._tag === "Success"
        ? mcpSignOutText(view.label).done
        : `${view.label}: ${mcpSignInErrorText(mcpSignInErrorCode(squashAtomCommandFailure(result)), "sign-out")}`,
    );
    query.refresh();
  };
  const signOutText = signOutTarget === null ? null : mcpSignOutText(signOutTarget.label);

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
        actions={{
          reconnecting,
          signingOut,
          signIn,
          onReconnect: (view) => void reconnect(view),
          onSignIn: (view) => void startSignIn(view),
          onFinishSignIn: finishSignIn,
          onCheckConnection: (view) => void checkConnection(view),
          onCancelSignIn: cancelSignIn,
          onOpenSignInPage: openSignInPage,
          onSignOut: setSignOutTarget,
        }}
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
  // Mounted in every list, so they announce a request that settles after its row is gone.
  // A sign-in's row shows its other lines, so only "Signed in" shows here.
  const signInAnnouncement = mcpSignInMessage(signIn, signInLabel) ?? "";
  const mcpStatus = (
    <>
      <p
        aria-live="polite"
        className={
          announcement === "" ? "sr-only" : "px-2 text-2xs break-words text-muted-foreground"
        }
      >
        {announcement}
      </p>
      <p
        aria-live="polite"
        className={
          signIn.phase === "done" ? "px-2 text-2xs break-words text-muted-foreground" : "sr-only"
        }
      >
        {signInAnnouncement}
      </p>
      <AlertDialog
        open={signOutTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSignOutTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{signOutText?.title}</AlertDialogTitle>
            <AlertDialogDescription>{signOutText?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (signOutTarget !== null) void signOut(signOutTarget);
              }}
            >
              {signOutText?.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
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
          {mcpStatus}
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
          {mcpStatus}
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
            className="group flex min-w-0 flex-1 flex-col justify-center gap-px rounded-md px-2 py-1 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
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
  readonly actions: McpServerActions;
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
          actions={props.actions}
          onOpenThread={props.onOpenThread}
        />
      )}
    />
  );
}

/** The panel's MCP requests, which outlive the rows that start them. */
interface McpServerActions {
  /** The server a Reconnect or Check connection is in flight for. */
  readonly reconnecting: string | null;
  /** The server a Sign out is in flight for. */
  readonly signingOut: string | null;
  /** The panel's one sign-in; its `server` says which row shows it. */
  readonly signIn: McpSignInState;
  readonly onReconnect: (view: McpServerRowView) => void;
  readonly onSignIn: (view: McpServerRowView) => void;
  /** Takes a pasted address that passed `mcpSignInPasteError`, trimmed; true once it is refused. */
  readonly onFinishSignIn: (callbackUrl: string) => Promise<boolean>;
  readonly onCheckConnection: (view: McpServerRowView) => void;
  readonly onCancelSignIn: () => void;
  readonly onOpenSignInPage: (url: string) => void;
  /** Asks to confirm, then signs out. */
  readonly onSignOut: (view: McpServerRowView) => void;
}

/**
 * One MCP server: a status dot beside the status in words, its origin and
 * tool count, expanding to its error, tools, Reconnect, Sign in and Sign out.
 * Names, errors and tool names are untrusted text, rendered as plain text only.
 */
function McpServerRow(props: {
  readonly view: McpServerRowView;
  readonly threadId: ThreadId;
  readonly actions: McpServerActions;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { view, actions } = props;
  const { row } = view;
  const [showAllTools, setShowAllTools] = useState(false);
  // The pasted address carries the sign-in's code: a password field, emptied once sent.
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const pasteRef = useRef<HTMLInputElement>(null);
  const signInButtonRef = useRef<HTMLButtonElement>(null);
  // Cancel unmounts itself: focus Sign in, rendered enabled again before it moves.
  const cancelSignIn = () => {
    flushSync(actions.onCancelSignIn);
    signInButtonRef.current?.focus();
  };
  const signIn =
    actions.signIn.phase === "idle" || actions.signIn.server !== row.name ? null : actions.signIn;
  const waiting = signIn?.phase === "waiting" || signIn?.phase === "finishing" ? signIn : null;
  // A failure shows only while the row still offers Sign in, beside the way to do it elsewhere.
  const failure = signIn?.phase === "failed" && view.signIn !== null ? view.signIn : null;
  const reconnecting = actions.reconnecting === row.name;
  const signingOut = actions.signingOut === row.name;
  const disabledReason = view.reconnect?.disabledReason ?? view.signOut?.disabledReason ?? null;
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
      {/* Opens on its own when it remounts mid sign-in, as after collapsing its section. */}
      <Collapsible
        defaultOpen={signIn?.phase === "starting" || waiting !== null || failure !== null}
      >
        <div className="flex min-w-0 items-center gap-1">
          <CollapsibleTrigger
            data-nav-item
            className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
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
            {view.reconnect === null && view.signIn === null && view.signOut === null ? null : (
              <div className="flex flex-wrap items-center gap-2">
                {view.signIn === null ? null : (
                  <Button
                    ref={signInButtonRef}
                    size="xs"
                    aria-label={
                      view.signIn.kind === "oauth"
                        ? `Sign in to ${view.label}`
                        : `Authorize on claude.ai for ${view.label}`
                    }
                    // One sign-in per panel; choosing it while one waits starts a fresh one.
                    disabled={
                      actions.signIn.phase === "starting" || actions.signIn.phase === "finishing"
                    }
                    onClick={() => actions.onSignIn(view)}
                  >
                    {view.signIn.label}
                  </Button>
                )}
                {view.reconnect === null ? null : (
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={`Reconnect ${view.label}`}
                    disabled={reconnecting || view.reconnect.disabledReason !== null}
                    onClick={() => actions.onReconnect(view)}
                  >
                    {reconnecting ? "Reconnecting…" : "Reconnect"}
                  </Button>
                )}
                {view.signOut === null ? null : (
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={`Sign out of ${view.label}`}
                    disabled={signingOut || view.signOut.disabledReason !== null}
                    onClick={() => actions.onSignOut(view)}
                  >
                    {signingOut ? "Signing out…" : "Sign out"}
                  </Button>
                )}
                {disabledReason === null ? null : <span>{disabledReason}</span>}
              </div>
            )}
            {/* The request may never answer; a late one is dropped. */}
            {signIn?.phase === "starting" ? (
              <Button size="xs" variant="ghost-muted" onClick={cancelSignIn}>
                {MCP_SIGN_IN_TEXT.cancel}
              </Button>
            ) : null}
            {waiting === null ? null : (
              <div className="flex w-full flex-col items-start gap-1.5">
                <p
                  className={cn(
                    "break-words",
                    waiting.error === null ? "text-foreground" : "text-destructive-foreground",
                  )}
                >
                  {mcpSignInMessage(waiting, view.label)}
                </p>
                {waiting.openUrl === null ? null : (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        if (waiting.openUrl !== null) actions.onOpenSignInPage(waiting.openUrl);
                      }}
                    >
                      {waiting.callbackExpected
                        ? MCP_SIGN_IN_TEXT.openPage
                        : MCP_SIGN_IN_TEXT.openClaudeAi}
                    </Button>
                    {/* The host only: the full address carries the sign-in's state. */}
                    <span className="min-w-0 break-all">{waiting.authUrlHost}</span>
                  </div>
                )}
                {/* Stays while the address is with the provider, so focus stays in it. */}
                {waiting.callbackExpected ? (
                  <form
                    className="flex w-full flex-col items-start gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (waiting.phase === "finishing") return;
                      const error = mcpSignInPasteError(pasted);
                      setPasteError(error);
                      if (error !== null) return;
                      void actions.onFinishSignIn(pasted.trim()).then((refused) => {
                        if (refused) pasteRef.current?.focus();
                      });
                      setPasted("");
                    }}
                  >
                    <label className="flex w-full flex-col gap-1">
                      {MCP_SIGN_IN_TEXT.pastePrompt}
                      <Input
                        ref={pasteRef}
                        size="sm"
                        type="password"
                        autoComplete="off"
                        readOnly={waiting.phase === "finishing"}
                        value={pasted}
                        aria-invalid={pasteError !== null}
                        onChange={(event) => {
                          setPasted(event.currentTarget.value);
                          setPasteError(null);
                        }}
                      />
                    </label>
                    {pasteError === null ? null : (
                      <p role="alert" className="text-destructive-foreground">
                        {pasteError}
                      </p>
                    )}
                    <Button
                      type="submit"
                      size="xs"
                      variant="outline"
                      aria-disabled={waiting.phase === "finishing"}
                    >
                      {MCP_SIGN_IN_TEXT.finish}
                    </Button>
                  </form>
                ) : null}
                {waiting.phase === "waiting" &&
                !waiting.callbackExpected &&
                waiting.openUrl !== null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={reconnecting}
                    onClick={() => actions.onCheckConnection(view)}
                  >
                    {MCP_SIGN_IN_TEXT.checkConnection}
                  </Button>
                ) : null}
                <Button size="xs" variant="ghost-muted" onClick={cancelSignIn}>
                  {MCP_SIGN_IN_TEXT.cancel}
                </Button>
              </div>
            )}
            {failure === null || signIn === null ? null : (
              <>
                <p className="break-words text-destructive-foreground">
                  {mcpSignInMessage(signIn, view.label)}
                </p>
                <p className="break-words">{failure.fallback}</p>
                {/* The session picks up a sign-in made elsewhere only by reconnecting. */}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={reconnecting}
                  onClick={() => actions.onCheckConnection(view)}
                >
                  {MCP_SIGN_IN_TEXT.checkConnection}
                </Button>
              </>
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}
