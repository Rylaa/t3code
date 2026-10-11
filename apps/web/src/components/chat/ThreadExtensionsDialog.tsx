/**
 * The /mcp and /skills dialog: one section of the thread's Skills & plugins
 * at a time, with live MCP status where the session reports it. Opened from
 * the composer's slash commands and the command palette, and rendered once by
 * the chat view so it outlives a palette that closes the moment its command runs.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  mcpServerStatusFreshness,
  type ThreadExtensionSectionKey,
} from "@t3tools/client-runtime/state/thread-extensions";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { RefreshIcon } from "../ui/refresh-icon";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useComposerMenuProps } from "./composerEventScope";
import { SkillsPanel, useThreadExtensions } from "./SkillsPanel";

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

const SECTIONS = ["mcpServers", "skills", "plugins", "agents"] as const;

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
  const { query, data, sections } = useThreadExtensions(props.threadRef);
  const composerMenuProps = useComposerMenuProps();
  const freshness = mcpServerStatusFreshness(data);

  // Opening shows what the session reports now, not a read cached by the panel.
  const refreshCached = useEffectEvent(() => {
    if (query.data !== null) query.refresh();
  });
  useEffect(() => refreshCached(), []);

  const count = (key: ThreadExtensionSectionKey) =>
    data === null ? null : sections[key].used.length + sections[key].unused.length;
  // The atom outlives the route, so the dialog would reopen over a thread a row navigates to.
  const close = () => appAtomRegistry.set(threadExtensionsDialogAtom, null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="h-[min(80vh,40rem)] max-w-2xl" {...composerMenuProps}>
        <DialogHeader>
          <DialogTitle>MCP servers & skills</DialogTitle>
          {freshness === null ? null : <DialogDescription>{freshness}</DialogDescription>}
        </DialogHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-6 pb-3">
          <ToggleGroup
            aria-label="Section"
            variant="segmented"
            value={[section]}
            onValueChange={(next) => {
              // A segmented control always keeps one section; ignore deselecting it.
              const value = SECTIONS.find((key) => key === next[0]);
              if (value !== undefined) setSection(value);
            }}
          >
            {SECTIONS.map((key) => (
              <Toggle key={key} value={key}>
                {key === "mcpServers" ? (
                  // Four sections with counts fit a 375px screen only as "MCP".
                  <span>
                    MCP<span className="max-sm:hidden"> servers</span>
                  </span>
                ) : (
                  SECTION_LABEL[key]
                )}
                {count(key) === null ? null : (
                  <span className="text-muted-foreground tabular-nums">{count(key)}</span>
                )}
              </Toggle>
            ))}
          </ToggleGroup>
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
        <div className="min-h-0 flex-1 border-t">
          <SkillsPanel threadRef={props.threadRef} section={section} onNavigate={close} />
        </div>
      </DialogPopup>
    </Dialog>
  );
}

const SECTION_LABEL = {
  skills: "Skills",
  plugins: "Plugins",
  agents: "Agents",
} as const;
