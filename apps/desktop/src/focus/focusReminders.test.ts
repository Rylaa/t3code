import { describe, expect, it } from "vite-plus/test";

import {
  FOCUS_SYNC_SCRIPT,
  focusKeyFromNotes,
  focusNotes,
  makeCoalescingSync,
  planFocusSync,
} from "./focusReminders.ts";

describe("focus reminder markers", () => {
  it("round-trips the key through the notes, with or without a note", () => {
    expect(focusKeyFromNotes(focusNotes({ key: "env/project", note: "Ship it\nsoon" }))).toBe(
      "env/project",
    );
    expect(focusKeyFromNotes(focusNotes({ key: "env/project", note: null }))).toBe("env/project");
    expect(focusKeyFromNotes("A reminder the user wrote")).toBeNull();
    expect(focusKeyFromNotes(null)).toBeNull();
  });
});

describe("planFocusSync", () => {
  it("updates matches, creates the rest, removes stale and duplicate items, keeps unmarked ones", () => {
    const plan = planFocusSync([{ key: "a" }, { key: "b" }], ["a", null, "stale", "a"]);
    expect(plan.upserts).toEqual([
      { item: { key: "a" }, index: 0 },
      { item: { key: "b" }, index: null },
    ]);
    expect(plan.removals).toEqual([2, 3]);
  });
});

describe("makeCoalescingSync", () => {
  it("runs once more with only the latest value and skips what already synced", async () => {
    const applied: string[] = [];
    let release = () => {};
    const sync = makeCoalescingSync(
      async (value: string) => {
        applied.push(value);
        if (value === "first") await new Promise<void>((resolve) => (release = resolve));
        return value !== "fails";
      },
      (value) => value,
    );

    const first = sync("first");
    void sync("second");
    void sync("third");
    release();
    await first;
    await sync("third");
    expect(applied).toEqual(["first", "third"]);

    await sync("fails");
    await sync("fails");
    expect(applied).toEqual(["first", "third", "fails", "fails"]);
  });
});

it("embeds the helpers into a script that parses", () => {
  expect(() => new Function(FOCUS_SYNC_SCRIPT)).not.toThrow();
});
