import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { TargetIcon } from "lucide-react";
import type { AnimationEvent, ReactNode } from "react";

import { ProjectFavicon } from "../components/ProjectFavicon";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { useProjects } from "../state/entities";
import {
  focusDeadlineLabel,
  focusProjectKey,
  focusUrgency,
  sortFocusProjects,
  type FocusUrgency,
} from "./focus.logic";
import { useFocusModeEnabled } from "./focusModeStore";
import { useEditProjectFocus } from "./ProjectFocusDialog";
import { splitFocusThreads } from "./sidebarFocus.logic";

const EMPTY_PROJECTS: readonly EnvironmentProject[] = [];

const TONE: Record<FocusUrgency, { accent: string; lamp: string; label: string }> = {
  upcoming: {
    accent: "bg-info/5 ring-1 ring-inset ring-info/35",
    lamp: "bg-info/12 ring-2 ring-inset ring-info",
    label: "text-info-foreground",
  },
  today: {
    accent: "bg-warning/6 ring-1 ring-inset ring-warning/40",
    lamp: "bg-warning/14 ring-2 ring-inset ring-warning",
    label: "text-warning-foreground",
  },
  overdue: {
    accent: "bg-destructive/5 ring-1 ring-inset ring-destructive/40",
    lamp: "bg-destructive/12 ring-2 ring-inset ring-destructive",
    label: "text-destructive-foreground",
  },
};

/**
 * While focus mode is on, threads of focused projects leave the regular
 * shelves for the Focus section; the rest render as before.
 */
export function useSidebarFocusSplit(
  threads: readonly EnvironmentThreadShell[],
  scopedProjectKeys: ReadonlySet<string> | null,
) {
  const focusModeEnabled = useFocusModeEnabled();
  const projects = useProjects();
  const focusProjects = focusModeEnabled
    ? sortFocusProjects(projects).filter(
        (project) =>
          scopedProjectKeys === null ||
          scopedProjectKeys.has(focusProjectKey(project.environmentId, project.id)),
      )
    : EMPTY_PROJECTS;
  const keys = new Set<string>(
    focusProjects.map((project) => focusProjectKey(project.environmentId, project.id)),
  );
  return {
    focusModeEnabled,
    focusProjects,
    ...splitFocusThreads(threads, keys, new Date().toISOString()),
  };
}

/** The deadline tone on a focused row, and the breathing lamp while it waits on the user. */
export function FocusRowAccent(props: { urgency: FocusUrgency; waiting: boolean }) {
  const tone = TONE[props.urgency];
  return (
    <>
      <span
        aria-hidden
        className={cn("pointer-events-none absolute inset-0 rounded-md", tone.accent)}
      />
      {props.waiting ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 rounded-md motion-safe:animate-status-breathe",
            tone.lamp,
          )}
          onAnimationStart={blinkInStep}
        />
      ) : null}
    </>
  );
}

// Every waiting row breathes on the same beat instead of from whenever it mounted.
function blinkInStep(event: AnimationEvent<HTMLSpanElement>) {
  for (const animation of event.currentTarget.getAnimations()) animation.startTime = 0;
}

export function SidebarFocusSection(props: {
  projects: readonly EnvironmentProject[];
  threads: readonly EnvironmentThreadShell[];
  renderRow: (thread: EnvironmentThreadShell, urgency: FocusUrgency) => ReactNode;
}) {
  const nowMinute = useNowMinute();
  const editProjectFocus = useEditProjectFocus();
  const now = new Date(`${nowMinute}:00.000Z`);
  return (
    <>
      <li className="mx-0.5 flex h-6 list-none items-center gap-1.5 px-2">
        <TargetIcon aria-hidden className="size-3.5 text-info-foreground" />
        <span className="text-xs font-medium text-sidebar-foreground/80">Focus</span>
      </li>
      {props.projects.length === 0 ? (
        <li className="mx-0.5 list-none px-2 pb-1 text-xs text-sidebar-muted-foreground">
          Pick a project from the focus button to keep its work here.
        </li>
      ) : null}
      {props.projects.map((project) => {
        const key = focusProjectKey(project.environmentId, project.id);
        const until = project.focus!.until;
        const urgency = focusUrgency(until, now);
        const deadline = focusDeadlineLabel(until, now);
        const note = project.focus!.note;
        return [
          <li key={`focus:${key}`} className="mx-0.5 list-none pt-1">
            <button
              type="button"
              aria-label={`Edit focus for ${project.title}, due ${deadline}${note ? `: ${note}` : ""}`}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => void editProjectFocus(project)}
            >
              <ProjectFavicon project={project} className="mt-0.5 size-4 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-sidebar-foreground">
                    {project.title}
                  </span>
                  <span
                    className={cn("ml-auto shrink-0 text-xs tabular-nums", TONE[urgency].label)}
                  >
                    {deadline}
                  </span>
                </span>
                {note ? (
                  <span className="truncate text-xs text-sidebar-muted-foreground">{note}</span>
                ) : null}
              </span>
            </button>
          </li>,
          ...props.threads
            .filter((thread) => focusProjectKey(thread.environmentId, thread.projectId) === key)
            .map((thread) => props.renderRow(thread, urgency)),
        ];
      })}
      <li aria-hidden className="mx-2.5 my-1.5 h-px list-none bg-sidebar-foreground/10" />
    </>
  );
}
