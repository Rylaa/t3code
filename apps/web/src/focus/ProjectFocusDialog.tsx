import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { localSnoozeTime } from "@t3tools/client-runtime/state/thread-settled";
import type { ProjectFocus } from "@t3tools/contracts";
import { CalendarIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { focusPresets, resolveFocusSubmission } from "./focus.logic";
import { projectEnvironment } from "../state/projects";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { weekStartsOn } from "../timestampFormat";
import { Button } from "../components/ui/button";
import { Calendar } from "../components/ui/calendar";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";

const NOTE_MAX_LENGTH = 500;

/** `null` clears the focus; `undefined` means the dialog was dismissed. */
type FocusChoice = ProjectFocus | null | undefined;
type Request = {
  readonly projectTitle: string;
  readonly focus: ProjectFocus | null;
  readonly resolve: (choice: FocusChoice) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

function requestProjectFocus(input: Omit<Request, "resolve">): Promise<FocusChoice> {
  useRequest.getState().request?.resolve(undefined);
  return new Promise((resolve) => useRequest.setState({ request: { ...input, resolve } }));
}

function finish(choice: FocusChoice) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function useEditProjectFocus() {
  const updateProject = useOrchestrationCommand(
    projectEnvironment.update,
    "Could not update project focus",
  );
  return async (project: EnvironmentProject) => {
    const focus = await requestProjectFocus({
      projectTitle: project.title,
      focus: project.focus ?? null,
    });
    if (focus === undefined) return;
    await updateProject({
      environmentId: project.environmentId,
      input: { projectId: project.id, focus },
    });
  };
}

export function ProjectFocusDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(undefined), []);
  return request ? <ProjectFocusDialog request={request} /> : null;
}

function ProjectFocusDialog({ request }: { request: Request }) {
  const id = useId();
  const [presets] = useState(() => focusPresets(new Date()));
  const [initial] = useState(() =>
    request.focus ? new Date(request.focus.until) : new Date(presets[0]!.until),
  );
  const [choice, setChoice] = useState(() =>
    request.focus
      ? (presets.find((preset) => preset.until === request.focus?.until)?.label ?? "custom")
      : presets[0]!.label,
  );
  const [date, setDate] = useState(initial);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [note, setNote] = useState(request.focus?.note ?? "");
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(undefined);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const focus = resolveFocusSubmission({
              presetUntil: presets.find((preset) => preset.label === choice)?.until ?? null,
              date,
              time,
              note,
              now: new Date(),
            });
            if (!focus) {
              setError("Choose a deadline in the future.");
              return;
            }
            finish(focus);
          }}
        >
          <DialogHeader>
            <DialogTitle>Focus on {request.projectTitle}</DialogTitle>
            <DialogDescription>
              In focus mode, this project's threads stay on top and keep alerting you until you
              answer them.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Deadline</Label>
                <ToggleGroup
                  aria-label="Deadline"
                  className="w-full *:flex-1"
                  value={[choice]}
                  onValueChange={(next) => {
                    if (next[0]) setChoice(next[0]);
                    setError(null);
                  }}
                >
                  {presets.map((preset) => (
                    <Toggle key={preset.label} value={preset.label}>
                      {preset.label}
                    </Toggle>
                  ))}
                  <Toggle value="custom">Custom</Toggle>
                </ToggleGroup>
              </div>
              {choice === "custom" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`${id}-date`}>Date</Label>
                    <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                      <PopoverTrigger
                        render={
                          <Button
                            id={`${id}-date`}
                            variant="outline"
                            className="w-full justify-between"
                          />
                        }
                      >
                        {date.toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                        <CalendarIcon className="size-4 text-muted-foreground" />
                      </PopoverTrigger>
                      <PopoverPopup align="start" aria-label="Choose deadline date">
                        <Calendar
                          mode="single"
                          required
                          selected={date}
                          defaultMonth={date}
                          {...(weekStartsOn === undefined ? {} : { weekStartsOn })}
                          disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
                          onSelect={(selected) => {
                            setDate(selected);
                            setCalendarOpen(false);
                            setError(null);
                          }}
                        />
                      </PopoverPopup>
                    </Popover>
                  </div>
                  <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-time`}>
                    Time
                    <Input
                      nativeInput
                      id={`${id}-time`}
                      className="h-9 sm:h-8"
                      type="time"
                      required
                      value={time}
                      onChange={(event) => {
                        setTime(event.target.value);
                        setError(null);
                      }}
                    />
                  </Label>
                </div>
              ) : null}
              <Label className="flex flex-col items-stretch" htmlFor={`${id}-note`}>
                What's left to do
                <Textarea
                  id={`${id}-note`}
                  placeholder="Finish the checkout screen"
                  maxLength={NOTE_MAX_LENGTH}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </Label>
            </div>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            {request.focus ? (
              <Button
                type="button"
                variant="destructive-outline"
                className="sm:mr-auto"
                onClick={() => finish(null)}
              >
                Remove focus
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => finish(undefined)}>
              Cancel
            </Button>
            <Button type="submit">Focus</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
