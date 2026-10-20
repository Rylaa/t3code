import { useAtomValue } from "@effect/atom-react";
import { TargetIcon } from "lucide-react";

import { ProjectFavicon } from "../components/ProjectFavicon";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../components/ui/menu";
import { SidebarMenuButton } from "../components/ui/sidebar";
import { shortcutLabelForCommand } from "../keybindings";
import { useProjects } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { focusDeadlineLabel, sortFocusProjects } from "./focus.logic";
import { toggleFocusMode, useFocusModeEnabled } from "./focusModeStore";
import { useEditProjectFocus } from "./ProjectFocusDialog";

/** Sidebar header control: turn focus mode on or off, and pick what to focus on. */
export function FocusModeButton() {
  const enabled = useFocusModeEnabled();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "focusMode.toggle");
  const projects = useProjects();
  const editProjectFocus = useEditProjectFocus();
  const focused = sortFocusProjects(projects);
  const unfocused = projects
    .filter((project) => project.focus == null)
    .toSorted((left, right) => left.title.localeCompare(right.title));
  const now = new Date();
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label="Focus mode"
            aria-pressed={enabled}
            className="relative size-7 shrink-0"
          />
        }
      >
        <TargetIcon className={enabled ? "text-info-foreground" : undefined} />
      </MenuTrigger>
      <MenuPopup align="end" className="max-h-96 w-64">
        <MenuCheckboxItem variant="switch" checked={enabled} onCheckedChange={toggleFocusMode}>
          Focus mode
          {shortcut ? <MenuShortcut>{shortcut}</MenuShortcut> : null}
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Focus on a project</MenuGroupLabel>
          {[...focused, ...unfocused].map((project) => (
            <MenuItem
              key={`${project.environmentId}:${project.id}`}
              onClick={() => void editProjectFocus(project)}
            >
              <ProjectFavicon project={project} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{project.title}</span>
              {project.focus ? (
                <MenuShortcut>{focusDeadlineLabel(project.focus.until, now)}</MenuShortcut>
              ) : null}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
