import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import { focusProjectKey } from "./focus.logic";
import { splitFocusThreads } from "./sidebarFocus.logic";

const environmentId = EnvironmentId.make("env-1");
const focused = ProjectId.make("focused");
const other = ProjectId.make("other");
const keys = new Set<string>([focusProjectKey(environmentId, focused)]);
const NOW = "2026-10-20T12:00:00.000Z";

const thread = (id: string, overrides: ThreadFixtureOverrides = {}) =>
  makeThreadFixture({
    environmentId,
    projectId: focused,
    id: ThreadId.make(id),
    ...overrides,
  });

const ids = (threads: readonly { readonly id: string }[]) => threads.map((entry) => entry.id);

describe("splitFocusThreads", () => {
  it("moves only the focused project's threads", () => {
    const split = splitFocusThreads(
      [thread("mine"), thread("theirs", { projectId: other })],
      keys,
      NOW,
    );
    expect(ids(split.focusThreads)).toEqual(["mine"]);
    expect(ids(split.otherThreads)).toEqual(["theirs"]);
  });

  it("leaves archived, settled, snoozed and subagent threads where they were", () => {
    const threads = [
      thread("archived", { archivedAt: "2026-10-19T00:00:00.000Z" }),
      thread("settled", { settledOverride: "settled" }),
      thread("snoozed", {
        snoozedAt: "2026-10-20T11:00:00.000Z",
        snoozedUntil: "2026-10-21T09:00:00.000Z",
      }),
      thread("subagent", {
        lineage: {
          rootThreadId: ThreadId.make("root"),
          parentThreadId: ThreadId.make("root"),
          relationshipToParent: "subagent",
        },
      }),
      thread("active"),
    ];
    const split = splitFocusThreads(threads, keys, NOW);
    expect(ids(split.focusThreads)).toEqual(["active"]);
    expect(ids(split.otherThreads)).toEqual(["archived", "settled", "snoozed", "subagent"]);
  });

  it("brings a snoozed thread back once its wake time passes", () => {
    const snoozed = thread("snoozed", {
      snoozedAt: "2026-10-20T08:00:00.000Z",
      snoozedUntil: "2026-10-20T10:00:00.000Z",
    });
    expect(ids(splitFocusThreads([snoozed], keys, NOW).focusThreads)).toEqual(["snoozed"]);
  });

  it("puts threads waiting on the user first", () => {
    const split = splitFocusThreads(
      [
        thread("quiet"),
        thread("question", { hasPendingUserInput: true }),
        thread("approval", { hasPendingApprovals: true }),
      ],
      keys,
      NOW,
    );
    expect(ids(split.focusThreads).slice(0, 2).toSorted()).toEqual(["approval", "question"]);
    expect(split.focusThreads.at(-1)?.id).toBe("quiet");
  });

  it("returns the input untouched when nothing is focused", () => {
    const threads = [thread("a"), thread("b")];
    const split = splitFocusThreads(threads, new Set(), NOW);
    expect(split.focusThreads).toEqual([]);
    expect(split.otherThreads).toBe(threads);
  });
});
