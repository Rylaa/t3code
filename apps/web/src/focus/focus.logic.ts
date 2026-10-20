import { localSnoozeDate, resolveCustomSnooze } from "@t3tools/client-runtime/state/thread-settled";
import type {
  DesktopFocusReminder,
  EnvironmentId,
  ProjectFocus,
  ProjectId,
} from "@t3tools/contracts";

export type FocusUrgency = "overdue" | "today" | "upcoming";

const FOCUS_PRESET_HOUR = 18;

export function focusProjectKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): `${EnvironmentId}:${ProjectId}` {
  return `${environmentId}:${projectId}`;
}

export function focusUrgency(until: string, now: Date): FocusUrgency {
  const deadline = Date.parse(until);
  if (!(deadline > now.getTime())) return "overdue";
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return deadline < midnight.getTime() ? "today" : "upcoming";
}

function atPresetHour(now: Date, addDays: number): Date {
  const date = new Date(now);
  date.setDate(date.getDate() + addDays);
  date.setHours(FOCUS_PRESET_HOUR, 0, 0, 0);
  return date;
}

/** End of today, tomorrow and this week, each at 18:00 local; past slots drop out. */
export function focusPresets(
  now: Date,
): ReadonlyArray<{ readonly label: string; readonly until: string }> {
  const presets: Array<{ label: string; until: string }> = [];
  const today = atPresetHour(now, 0);
  if (today > now) presets.push({ label: "Today", until: today.toISOString() });
  presets.push({ label: "Tomorrow", until: atPresetHour(now, 1).toISOString() });
  // Friday this week, or next week's once today is Friday or later.
  const untilFriday = (5 - now.getDay() + 7) % 7 || 7;
  if (untilFriday > 1) {
    presets.push({ label: "Friday", until: atPresetHour(now, untilFriday).toISOString() });
  }
  return presets;
}

export function focusDeadlineLabel(until: string, now: Date): string {
  const deadline = new Date(until);
  const urgency = focusUrgency(until, now);
  if (urgency === "overdue") return "Overdue";
  const time = deadline.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (urgency === "today") return `Today ${time}`;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((deadline.getTime() - startOfToday.getTime()) / 86_400_000);
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${deadline.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return deadline.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function sortFocusProjects<T extends { readonly focus?: ProjectFocus | null | undefined }>(
  projects: readonly T[],
): T[] {
  return projects
    .filter((project) => project.focus != null)
    .toSorted((left, right) => Date.parse(left.focus!.until) - Date.parse(right.focus!.until));
}

/**
 * The focus a dialog submission saves, or `null` when the deadline is not in
 * the future. A preset can lapse while the dialog stays open, so it is checked too.
 */
export function resolveFocusSubmission(input: {
  readonly presetUntil: string | null;
  readonly date: Date;
  readonly time: string;
  readonly note: string;
  readonly now: Date;
}): ProjectFocus | null {
  const until =
    input.presetUntil ??
    resolveCustomSnooze(
      { mode: "date", date: localSnoozeDate(input.date), time: input.time },
      input.now,
    );
  if (until === null || !(Date.parse(until) > input.now.getTime())) return null;
  const note = input.note.trim();
  return { until, note: note === "" ? null : note };
}

export function focusReminderItems(
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly focus?: ProjectFocus | null | undefined;
  }>,
): DesktopFocusReminder[] {
  return sortFocusProjects(projects).map((project) => ({
    key: focusProjectKey(project.environmentId, project.id),
    title: project.title,
    note: project.focus!.note,
    until: project.focus!.until,
  }));
}
