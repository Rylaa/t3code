/**
 * The /mcp and /skills dialog: one section of the thread's Skills & plugins
 * at a time, with live MCP status where the session reports it. Opened from
 * the composer's slash commands and the command palette, and rendered once by
 * the chat view so it outlives a palette that closes the moment its command runs.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  filterThreadExtensionSections,
  THREAD_EXTENSION_SECTION_ORDER,
  THREAD_EXTENSION_SECTION_TITLES,
  threadExtensionsSummary,
  type ThreadExtensionSectionKey,
} from "@t3tools/client-runtime/state/thread-extensions";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { RefreshIcon } from "../ui/refresh-icon";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useComposerMenuProps } from "./composerEventScope";
import { NAV_ITEM_SELECTOR } from "./extensionListNavigation";
import {
  SkillsPanel,
  ThreadExtensionsSearch,
  ThreadExtensionsSummary,
  useThreadExtensions,
} from "./SkillsPanel";

const threadExtensionsDialogAtom = Atom.make<{
  readonly threadRef: ScopedThreadRef;
  readonly section: ThreadExtensionSectionKey;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("thread-extensions:dialog"));

export function openThreadExtensionsDialog(
  threadRef: ScopedThreadRef,
  section: ThreadExtensionSectionKey,
): void {
  appAtomRegistry.set(threadExtensionsDialogAtom, { threadRef, section });
}

/** Mounted once per chat view; shows the dialog for whichever thread asked for it. */
export function ThreadExtensionsDialogHost() {
  const target = useAtomValue(threadExtensionsDialogAtom);
  if (target === null) return null;
  return (
    <ThreadExtensionsDialog
      key={`${target.threadRef.environmentId}:${target.threadRef.threadId}`}
      threadRef={target.threadRef}
      initialSection={target.section}
    />
  );
}

function ThreadExtensionsDialog(props: {
  readonly threadRef: ScopedThreadRef;
  readonly initialSection: ThreadExtensionSectionKey;
}) {
  const [section, setSection] = useState(props.initialSection);
  // One search for every section; it goes when the dialog closes.
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { query, data, sections } = useThreadExtensions(props.threadRef);
  const filtered = filterThreadExtensionSections(sections, search);
  const summary = data === null ? [] : threadExtensionsSummary(sections, data);
  const composerMenuProps = useComposerMenuProps();

  // Opening shows what the session reports now, not a read cached by the panel.
  const refreshCached = useEffectEvent(() => {
    if (query.data !== null) query.refresh();
  });
  useEffect(() => refreshCached(), []);

  // Totals, or matches while searching.
  const count = (key: ThreadExtensionSectionKey) =>
    data === null ? null : filtered[key].used.length + filtered[key].unused.length;
  // The atom outlives the route, so the dialog would reopen over a thread a row navigates to.
  const close = () => appAtomRegistry.set(threadExtensionsDialogAtom, null);
  const clearSearch = () => {
    setSearch("");
    searchRef.current?.focus();
  };

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        // Esc clears a search before it closes the dialog.
        if (!open && details.reason === "escape-key" && search !== "") {
          details.cancel();
          setSearch("");
          return;
        }
        if (!open) close();
      }}
    >
      <DialogPopup
        className="h-[min(80vh,40rem)] max-w-2xl"
        {...composerMenuProps}
        // A focused field would raise the on-screen keyboard over a touch screen.
        initialFocus={() =>
          window.matchMedia("(pointer: fine)").matches ? searchRef.current : true
        }
        onKeyDown={(event) => {
          const target = event.target;
          if (
            event.key !== "/" ||
            (target instanceof HTMLElement &&
              (target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable))
          ) {
            return;
          }
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Skills & plugins</DialogTitle>
          {summary.length === 0 ? null : (
            <DialogDescription>
              <ThreadExtensionsSummary parts={summary} />
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-6 pb-3">
          <ToggleGroup
            aria-label="Sections"
            variant="segmented"
            value={[section]}
            onValueChange={(next) => {
              // A segmented control always keeps one section; ignore deselecting it.
              const value = THREAD_EXTENSION_SECTION_ORDER.find((key) => key === next[0]);
              if (value !== undefined) setSection(value);
            }}
          >
            {THREAD_EXTENSION_SECTION_ORDER.map((key) => (
              <Toggle key={key} value={key}>
                {key === "mcpServers" ? (
                  // Four sections with counts fit a 375px screen only as "MCP".
                  <span>
                    MCP<span className="max-sm:hidden"> servers</span>
                  </span>
                ) : (
                  THREAD_EXTENSION_SECTION_TITLES[key].title
                )}
                {count(key) === null ? null : (
                  <span className="text-muted-foreground tabular-nums">{count(key)}</span>
                )}
              </Toggle>
            ))}
          </ToggleGroup>
          <div className="min-w-0 flex-1 basis-40 max-sm:order-last max-sm:basis-full">
            <ThreadExtensionsSearch
              inputRef={searchRef}
              value={search}
              onValueChange={setSearch}
              onArrowDown={() =>
                bodyRef.current?.querySelector<HTMLElement>(NAV_ITEM_SELECTOR)?.focus()
              }
              shortcutHint
            />
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            className="ms-auto"
            aria-label="Refresh"
            disabled={query.isPending}
            onClick={query.refresh}
          >
            <RefreshIcon refreshing={query.isPending} />
          </Button>
        </div>
        <div ref={bodyRef} className="min-h-0 flex-1 border-t">
          <SkillsPanel
            threadRef={props.threadRef}
            section={section}
            query={search}
            searchRef={searchRef}
            onNavigate={close}
            onShowSection={setSection}
            onClearQuery={clearSearch}
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
