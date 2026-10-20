import type { DesktopFocusReminder } from "@t3tools/contracts";

// The functions below are embedded into the osascript source by `String(fn)`, so they must stay
// self-contained: no imports, no module constants, nothing a bundler could rename underneath them.

export function focusNotes(item: Pick<DesktopFocusReminder, "key" | "note">): string {
  return item.note ? `${item.note}\n\nt3code-focus:${item.key}` : `t3code-focus:${item.key}`;
}

export function focusKeyFromNotes(notes: string | null): string | null {
  const line = notes?.trimEnd().split("\n").at(-1);
  return line?.startsWith("t3code-focus:") ? line.slice("t3code-focus:".length) : null;
}

/** Matches items we own by marker; unmarked items belong to the user and are left alone. */
export function planFocusSync<T extends { readonly key: string }>(
  desired: ReadonlyArray<T>,
  existingKeys: ReadonlyArray<string | null>,
): {
  readonly upserts: ReadonlyArray<{ readonly item: T; readonly index: number | null }>;
  readonly removals: ReadonlyArray<number>;
} {
  const wanted = new Set(desired.map((item) => item.key));
  const matched = new Map<string, number>();
  const removals: number[] = [];
  existingKeys.forEach((key, index) => {
    if (key === null) return;
    if (!wanted.has(key) || matched.has(key)) removals.push(index);
    else matched.set(key, index);
  });
  return {
    upserts: desired.map((item) => ({ item, index: matched.get(item.key) ?? null })),
    removals,
  };
}

/** One sync in flight; calls made meanwhile collapse into one more run with the latest value. */
export function makeCoalescingSync<T>(
  apply: (value: T) => Promise<boolean>,
  keyOf: (value: T) => string,
): (value: T) => Promise<void> {
  let latest: { readonly value: T } | null = null;
  let running = false;
  let applied: string | null = null;
  return async (value) => {
    latest = { value };
    if (running) return;
    running = true;
    try {
      while (latest !== null) {
        const next = latest.value;
        latest = null;
        const key = keyOf(next);
        if (key !== applied && (await apply(next))) applied = key;
      }
    } finally {
      running = false;
    }
  };
}

/**
 * JXA over EventKit, so Reminders.app and Calendar.app never launch. Reads the desired items as
 * JSON from argv and prints `{reminders, events}` statuses: ok, skipped, denied or `error: …`.
 * EventKit status 3 is full access; 0 is not determined, the only state that may prompt.
 */
export const FOCUS_SYNC_SCRIPT = `
ObjC.import("EventKit");
const plan = ${String(planFocusSync)};
const notesFor = ${String(focusNotes)};
const keyOf = ${String(focusKeyFromNotes)};
const LIST = "T3 Code";
const REMINDER = 1;
const EVENT = 0;

function pump(isDone, ms) {
  const deadline = Date.now() + ms;
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error("EventKit did not respond");
    $.NSRunLoop.currentRunLoop.runModeBeforeDate(
      $.NSDefaultRunLoopMode,
      $.NSDate.dateWithTimeIntervalSinceNow(0.05),
    );
  }
}

function fail(what, error) {
  const cause = error[0];
  throw new Error(what + ": " + (cause && !cause.isNil() ? cause.localizedDescription.js : "unknown"));
}

function dateOf(iso, offsetSeconds) {
  return $.NSDate.dateWithTimeIntervalSince1970(Date.parse(iso) / 1000 + offsetSeconds);
}

// JXA bridges the EKAuthorizationStatus enum as a string, so compare it as a number.
function statusOf(type) {
  return Number($.EKEventStore.authorizationStatusForEntityType(type));
}

function access(store, type, mayPrompt) {
  if (statusOf(type) === 3) return true;
  if (statusOf(type) !== 0 || !mayPrompt) return false;
  let done = false;
  const callback = () => {
    done = true;
  };
  if (type === REMINDER && store.respondsToSelector("requestFullAccessToRemindersWithCompletion:"))
    store.requestFullAccessToRemindersWithCompletion(callback);
  else if (type === EVENT && store.respondsToSelector("requestFullAccessToEventsWithCompletion:"))
    store.requestFullAccessToEventsWithCompletion(callback);
  else store.requestAccessToEntityTypeCompletion(type, callback);
  // The prompt waits on the user. Under osascript the completion block may never reach the JS
  // thread, so the status itself also ends the wait.
  pump(() => done || statusOf(type) !== 0, 150000);
  return statusOf(type) === 3;
}

function ownCalendar(store, type, create) {
  const calendars = store.calendarsForEntityType(type);
  for (let i = 0; i < calendars.count; i++) {
    const calendar = calendars.objectAtIndex(i);
    if (calendar.title.js === LIST && calendar.allowsContentModifications) return calendar;
  }
  if (!create) return null;
  const fallback =
    type === REMINDER ? store.defaultCalendarForNewReminders : store.defaultCalendarForNewEvents;
  if (fallback.isNil()) throw new Error("no default account to create the T3 Code list in");
  const calendar = $.EKCalendar.calendarForEntityTypeEventStore(type, store);
  calendar.setTitle(LIST);
  calendar.setSource(fallback.source);
  const error = Ref();
  if (!store.saveCalendarCommitError(calendar, true, error)) fail("create T3 Code list", error);
  return calendar;
}

function toArray(objects) {
  const result = [];
  if (!objects.isNil()) for (let i = 0; i < objects.count; i++) result.push(objects.objectAtIndex(i));
  return result;
}

function sync(store, type, items) {
  if (!access(store, type, items.length > 0)) return items.length > 0 ? "denied" : "skipped";
  const calendar = ownCalendar(store, type, items.length > 0);
  if (calendar === null) return "ok";
  const calendars = $.NSArray.arrayWithObject(calendar);
  let existing;
  if (type === REMINDER) {
    let found = null;
    store.fetchRemindersMatchingPredicateCompletion(
      store.predicateForRemindersInCalendars(calendars),
      (reminders) => {
        found = reminders;
      },
    );
    pump(() => found !== null, 20000);
    existing = toArray(found);
  } else {
    const day = 86400;
    existing = toArray(
      store.eventsMatchingPredicate(
        store.predicateForEventsWithStartDateEndDateCalendars(
          $.NSDate.dateWithTimeIntervalSinceNow(-300 * day),
          $.NSDate.dateWithTimeIntervalSinceNow(3 * 365 * day),
          calendars,
        ),
      ),
    );
  }
  const { upserts, removals } = plan(
    items,
    existing.map((entry) => keyOf(ObjC.unwrap(entry.notes) ?? null)),
  );
  const error = Ref();
  for (const index of removals) {
    const removed =
      type === REMINDER
        ? store.removeReminderCommitError(existing[index], false, error)
        : store.removeEventSpanCommitError(existing[index], 0, false, error);
    if (!removed) fail("remove", error);
  }
  for (const { item, index } of upserts) {
    const entry =
      index !== null
        ? existing[index]
        : type === REMINDER
          ? $.EKReminder.reminderWithEventStore(store)
          : $.EKEvent.eventWithEventStore(store);
    entry.setCalendar(calendar);
    entry.setTitle(item.title);
    entry.setNotes(notesFor(item));
    let saved;
    if (type === REMINDER) {
      const due = dateOf(item.until, 0);
      // Year, month, day, hour and minute.
      entry.setDueDateComponents($.NSCalendar.currentCalendar.componentsFromDate(124, due));
      entry.setAlarms($.NSArray.arrayWithObject($.EKAlarm.alarmWithAbsoluteDate(due)));
      saved = store.saveReminderCommitError(entry, false, error);
    } else {
      entry.setStartDate(dateOf(item.until, -30 * 60));
      entry.setEndDate(dateOf(item.until, 0));
      entry.setAlarms($.NSArray.arrayWithObject($.EKAlarm.alarmWithRelativeOffset(0)));
      saved = store.saveEventSpanCommitError(entry, 0, false, error);
    }
    if (!saved) fail("save", error);
  }
  if (!store.commit(error)) fail("commit", error);
  return "ok";
}

function attempt(run) {
  try {
    return run();
  } catch (error) {
    return "error: " + error.message;
  }
}

function run(argv) {
  const items = JSON.parse(argv[0]);
  const store = $.EKEventStore.alloc.init;
  return JSON.stringify({
    reminders: attempt(() => sync(store, REMINDER, items)),
    events: attempt(() => sync(store, EVENT, items)),
  });
}
`;
