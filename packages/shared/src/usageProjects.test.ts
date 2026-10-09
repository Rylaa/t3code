import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MergedProjectUsage } from "./usageMerge.ts";
import {
  claudeProjectKey,
  claudeWeeklyProjectsInput,
  resolveClaudeWeeklyWindow,
  weeklyProjectRows,
} from "./usageProjects.ts";

const NOW = Date.parse("2026-10-08T12:30:00.000Z");

function claude(checkedAt: string, resetsAt: string, usedPercent: number): ServerProvider {
  return {
    driver: "claudeAgent",
    usageLimits: {
      checkedAt,
      windows: [
        { id: "five_hour", kind: "session", label: "Session", usedPercent: 90 },
        { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent, resetsAt },
      ],
    },
  } as unknown as ServerProvider;
}

function usage(project: string, costUsd: number, totalTokens = 1000): MergedProjectUsage {
  return { provider: "claude", project, costUsd, totalTokens, records: 1 };
}

describe("resolveClaudeWeeklyWindow", () => {
  it("uses the freshest Claude week that has not reset", () => {
    const window = resolveClaudeWeeklyWindow(
      [
        claude("2026-10-08T10:00:00.000Z", "2026-10-10T09:00:00.000Z", 20),
        claude("2026-10-08T12:00:00.000Z", "2026-10-10T09:00:00.000Z", 42),
        // Already reset: stale.
        claude("2026-10-08T12:20:00.000Z", "2026-10-08T09:00:00.000Z", 99),
      ],
      NOW,
    );
    expect(window).toEqual({
      startMs: Date.parse("2026-10-03T09:00:00.000Z"),
      resetsAtMs: Date.parse("2026-10-10T09:00:00.000Z"),
      usedPercent: 42,
    });
  });

  it("falls back to the last seven days, hour-aligned, without a reported week", () => {
    expect(resolveClaudeWeeklyWindow([], NOW)).toEqual({
      startMs: Date.parse("2026-10-01T12:00:00.000Z"),
      resetsAtMs: null,
      usedPercent: null,
    });
  });
});

describe("claudeWeeklyProjectsInput", () => {
  it("covers the week's days in the viewer's zone and totals from its start", () => {
    const input = claudeWeeklyProjectsInput(
      { startMs: Date.parse("2026-10-03T22:00:00.000Z"), resetsAtMs: null, usedPercent: null },
      NOW,
      "Europe/Istanbul",
    );
    expect(input).toEqual({
      sinceDay: "2026-10-04",
      untilDay: "2026-10-08",
      timeZone: "Europe/Istanbul",
      resolution: "day",
      projectsSinceTime: "2026-10-03T22:00:00.000Z",
    });
  });
});

describe("weeklyProjectRows", () => {
  const roots = [
    { path: "/Users/me/Projects/t3code", name: "t3code" },
    { path: "/Users/me/.t3/worktrees/t3code/t3-1a2b", name: "t3code" },
    { path: "/Users/me/Projects/muvi", name: "muvi" },
  ];

  it("encodes working directories the way Claude Code names them", () => {
    expect(claudeProjectKey("/Users/me/.t3/worktrees/t3code/t3-1a2b")).toBe(
      "-Users-me--t3-worktrees-t3code-t3-1a2b",
    );
  });

  it("groups subdirectories and worktrees under their project and splits the week by cost", () => {
    const rows = weeklyProjectRows(
      [
        usage("-Users-me-Projects-t3code", 30),
        usage("-Users-me-Projects-t3code-apps-web", 10),
        usage("-Users-me--t3-worktrees-t3code-t3-1a2b", 20),
        usage("-Users-me-Projects-muvi", 20),
        usage("-Users-me-Downloads", 20),
      ],
      roots,
      50,
    );
    expect(rows.map((row) => [row.name, row.known, row.costUsd, row.limitPercent])).toEqual([
      ["t3code", true, 60, 30],
      ["-Users-me-Downloads", false, 20, 10],
      ["muvi", true, 20, 10],
    ]);
  });

  it("weighs by tokens when nothing is priced, and leaves the limit unknown without a week", () => {
    const rows = weeklyProjectRows(
      [usage("-Users-me-Projects-muvi", 0, 300), usage("-Users-me-Projects-t3code", 0, 100)],
      roots,
      null,
    );
    expect(rows.map((row) => [row.name, row.share, row.limitPercent])).toEqual([
      ["muvi", 0.75, null],
      ["t3code", 0.25, null],
    ]);
  });
});
