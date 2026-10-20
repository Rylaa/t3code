import { isElectron } from "../env";
import { FocusModeShortcut } from "./FocusModeShortcut";
import { FocusReminderSync } from "./FocusReminderSync";
import { ProjectFocusDialogHost } from "./ProjectFocusDialog";

/** Everything the focus feature mounts once at the app root. */
export function FocusFeature() {
  return (
    <>
      <ProjectFocusDialogHost />
      <FocusModeShortcut />
      {isElectron ? <FocusReminderSync /> : null}
    </>
  );
}
