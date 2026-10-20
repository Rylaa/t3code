import { BookmarkIcon, BookmarkPlusIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** What the stash control does right now, mirroring the `composer.stash` shortcut. */
export function composerStashAction(input: {
  hasDraft: boolean;
  stashCount: number;
}): "stash" | "restore" | "open" | null {
  if (input.hasDraft) return "stash";
  if (input.stashCount === 1) return "restore";
  if (input.stashCount > 1) return "open";
  return null;
}

const ACTION_LABELS = {
  stash: "Stash prompt",
  restore: "Restore stashed prompt",
  open: "Open stash",
} as const;

export const ComposerStashButton = memo(function ComposerStashButton(props: {
  hasDraft: boolean;
  stashCount: number;
  shortcutLabel: string | null;
  onTrigger: () => void;
}) {
  const action = composerStashAction(props);
  const label = action === null ? "Nothing to stash" : ACTION_LABELS[action];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={action === null}
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onTrigger}
            aria-label={label}
          />
        }
      >
        {action === "stash" || action === null ? <BookmarkPlusIcon /> : <BookmarkIcon />}
      </TooltipTrigger>
      <TooltipPopup>
        {props.shortcutLabel ? `${label} · ${props.shortcutLabel}` : label}
      </TooltipPopup>
    </Tooltip>
  );
});
