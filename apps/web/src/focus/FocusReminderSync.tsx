import type { DesktopFocusReminder } from "@t3tools/contracts";
import { useEffect } from "react";

import { focusReminderItems } from "./focus.logic";
import { useAllEnvironmentProjectSnapshotsReady, useProjects } from "../state/entities";

/** Mirrors focused projects into Apple Reminders and Calendar through the desktop shell. */
export function FocusReminderSync() {
  const projects = useProjects();
  const ready = useAllEnvironmentProjectSnapshotsReady();
  // Serialized so the effect only fires when a deadline or note actually changes.
  const payload = JSON.stringify(focusReminderItems(projects));
  useEffect(() => {
    // A partial snapshot would read as unfocused projects and delete their reminders.
    if (!ready) return;
    void window.desktopBridge
      ?.syncFocusReminders?.(JSON.parse(payload) as DesktopFocusReminder[])
      .catch(() => undefined);
  }, [payload, ready]);
  return null;
}
