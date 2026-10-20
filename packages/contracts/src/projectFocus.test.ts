import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopFocusReminderSchema } from "./ipc.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
import { ProjectFocus, ProjectMutation } from "./project.ts";

const decodeFocus = Schema.decodeUnknownSync(ProjectFocus);
const decodeMutation = Schema.decodeUnknownSync(ProjectMutation);
const decodeShell = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodeReminder = Schema.decodeUnknownSync(DesktopFocusReminderSchema);

const focus = { until: "2026-10-24T15:00:00.000Z", note: "Finish checkout" };
const shell = {
  id: "project-1",
  title: "Project",
  workspaceRoot: "/tmp/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
};

describe("ProjectFocus", () => {
  it("accepts a deadline with or without a note", () => {
    expect(decodeFocus(focus)).toEqual(focus);
    expect(decodeFocus({ ...focus, note: null })).toEqual({ ...focus, note: null });
  });

  it("rejects an empty or overlong note and a missing deadline", () => {
    expect(() => decodeFocus({ ...focus, note: "" })).toThrow();
    expect(() => decodeFocus({ ...focus, note: "x".repeat(501) })).toThrow();
    expect(decodeFocus({ ...focus, note: "x".repeat(500) }).note).toHaveLength(500);
    expect(() => decodeFocus({ note: null })).toThrow();
  });

  it("travels on project.update, which agents reach through t3_project_update", () => {
    const base = { type: "project.update", commandId: "command-1", projectId: "project-1" };
    expect(decodeMutation({ ...base, focus })).toMatchObject({ focus });
    expect(decodeMutation({ ...base, focus: null })).toMatchObject({ focus: null });
    expect(decodeMutation(base)).not.toHaveProperty("focus");
  });

  it("keeps project shells from servers without focus decodable", () => {
    expect(decodeShell(shell).focus).toBeUndefined();
    expect(decodeShell({ ...shell, focus }).focus).toEqual(focus);
  });
});

describe("DesktopFocusReminderSchema", () => {
  it("validates what the renderer sends to the desktop shell", () => {
    const reminder = { key: "env:project", title: "Project", note: null, until: focus.until };
    expect(decodeReminder(reminder)).toEqual(reminder);
    expect(() => decodeReminder({ ...reminder, key: "" })).toThrow();
    expect(() => decodeReminder({ ...reminder, note: "x".repeat(501) })).toThrow();
  });
});
