import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  focusDeadlineLabel,
  focusPresets,
  focusReminderItems,
  focusUrgency,
  resolveFocusSubmission,
  sortFocusProjects,
} from "./focus.logic";

const at = (iso: string) => new Date(iso);
const local = (year: number, month: number, day: number, hour: number, minute = 0) =>
  new Date(year, month - 1, day, hour, minute);

describe("focusUrgency", () => {
  const now = local(2026, 10, 20, 12);

  it("is overdue once the deadline has passed", () => {
    expect(focusUrgency(local(2026, 10, 20, 11).toISOString(), now)).toBe("overdue");
    expect(focusUrgency(now.toISOString(), now)).toBe("overdue");
  });

  it("is today until local midnight, upcoming after", () => {
    expect(focusUrgency(local(2026, 10, 20, 23, 59).toISOString(), now)).toBe("today");
    expect(focusUrgency(local(2026, 10, 21, 0).toISOString(), now)).toBe("upcoming");
  });

  it("treats an unparseable deadline as overdue rather than hiding it", () => {
    expect(focusUrgency("not-a-date", now)).toBe("overdue");
  });
});

describe("focusPresets", () => {
  it("offers today, tomorrow and Friday at 18:00 early in the week", () => {
    // 2026-10-20 is a Tuesday.
    const presets = focusPresets(local(2026, 10, 20, 9));
    expect(presets.map((preset) => preset.label)).toEqual(["Today", "Tomorrow", "Friday"]);
    expect(presets.map((preset) => new Date(preset.until).getDate())).toEqual([20, 21, 23]);
    expect(new Date(presets[0]!.until).getHours()).toBe(18);
  });

  it("drops today after 18:00 and Friday when it is tomorrow", () => {
    const thursdayEvening = local(2026, 10, 22, 19);
    expect(focusPresets(thursdayEvening).map((preset) => preset.label)).toEqual(["Tomorrow"]);
  });

  it("points Friday at next week once this week's has passed", () => {
    const saturday = local(2026, 10, 24, 9);
    const friday = focusPresets(saturday).find((preset) => preset.label === "Friday");
    expect(new Date(friday!.until).getDate()).toBe(30);
  });
});

describe("sortFocusProjects", () => {
  it("keeps only focused projects, nearest deadline first", () => {
    const projects = [
      { id: "later", focus: { until: at("2026-10-24T10:00:00Z").toISOString(), note: null } },
      { id: "none", focus: null },
      { id: "sooner", focus: { until: at("2026-10-21T10:00:00Z").toISOString(), note: null } },
    ];
    expect(sortFocusProjects(projects).map((project) => project.id)).toEqual(["sooner", "later"]);
  });
});

describe("focusDeadlineLabel", () => {
  // 2026-10-20 is a Tuesday.
  const now = local(2026, 10, 20, 12);
  const time = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  it("names today, tomorrow and the coming week by day", () => {
    const today = local(2026, 10, 20, 18);
    const tomorrow = local(2026, 10, 21, 9, 30);
    const friday = local(2026, 10, 23, 18);
    expect(focusDeadlineLabel(today.toISOString(), now)).toBe(`Today ${time(today)}`);
    expect(focusDeadlineLabel(tomorrow.toISOString(), now)).toBe(`Tomorrow ${time(tomorrow)}`);
    expect(focusDeadlineLabel(friday.toISOString(), now)).toBe(
      `${friday.toLocaleDateString(undefined, { weekday: "short" })} ${time(friday)}`,
    );
  });

  it("falls back to the date a week out, and says overdue once passed", () => {
    const later = local(2026, 11, 2, 18);
    expect(focusDeadlineLabel(later.toISOString(), now)).toBe(
      later.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(focusDeadlineLabel(local(2026, 10, 20, 11).toISOString(), now)).toBe("Overdue");
  });
});

describe("resolveFocusSubmission", () => {
  const now = local(2026, 10, 20, 12);

  it("saves a preset with a trimmed note, and no note as null", () => {
    const until = local(2026, 10, 21, 18).toISOString();
    const base = { presetUntil: until, date: now, time: "00:00", now };
    expect(resolveFocusSubmission({ ...base, note: "  Finish checkout \n" })).toEqual({
      until,
      note: "Finish checkout",
    });
    expect(resolveFocusSubmission({ ...base, note: "   " })).toEqual({ until, note: null });
  });

  it("saves a custom local date and time", () => {
    const focus = resolveFocusSubmission({
      presetUntil: null,
      date: local(2026, 10, 25, 0),
      time: "09:30",
      note: "",
      now,
    });
    expect(focus?.until).toBe(local(2026, 10, 25, 9, 30).toISOString());
  });

  it("rejects a deadline in the past, even a preset that lapsed while open", () => {
    const custom = { presetUntil: null, date: now, time: "11:00", note: "", now };
    expect(resolveFocusSubmission(custom)).toBeNull();
    expect(
      resolveFocusSubmission({
        presetUntil: local(2026, 10, 20, 11, 59).toISOString(),
        date: now,
        time: "00:00",
        note: "",
        now,
      }),
    ).toBeNull();
  });
});

describe("focusReminderItems", () => {
  it("lists focused projects by deadline with a key stable across syncs", () => {
    const environmentId = EnvironmentId.make("env-1");
    const items = focusReminderItems([
      {
        environmentId,
        id: ProjectId.make("later"),
        title: "Later",
        focus: { until: "2026-10-24T10:00:00.000Z", note: "Ship" },
      },
      { environmentId, id: ProjectId.make("none"), title: "None", focus: null },
      {
        environmentId,
        id: ProjectId.make("sooner"),
        title: "Sooner",
        focus: { until: "2026-10-21T10:00:00.000Z", note: null },
      },
    ]);
    expect(items).toEqual([
      { key: "env-1:sooner", title: "Sooner", note: null, until: "2026-10-21T10:00:00.000Z" },
      { key: "env-1:later", title: "Later", note: "Ship", until: "2026-10-24T10:00:00.000Z" },
    ]);
  });
});
