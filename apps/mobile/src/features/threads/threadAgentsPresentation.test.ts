import { describe, expect, it } from "vite-plus/test";

import { resolveSubagentRowPresentation, workflowTotalsLine } from "./threadAgentsPresentation";

const base = {
  title: null,
  prompt: "Audit the timestamps",
  status: "running" as const,
  result: null,
  childThreadId: "thread-child" as never,
};

describe("resolveSubagentRowPresentation", () => {
  it("leads with progress while the agent is working", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      progress: "Reading files",
      result: "stale result",
    });

    expect(row.detail).toBe("Reading files");
    expect(row.tone).toBe("working");
    expect(row.live).toBe(true);
  });

  it("leads with the result once the agent has settled", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "completed",
      progress: "Reading files",
      result: "Found two\n  problems",
    });

    expect(row.detail).toBe("Found two problems");
    expect(row.tone).toBe("completed");
    expect(row.statusLabel).toBe("Completed");
  });

  it("shows a failure's text, since that is where the error lands", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "failed", result: "Timed out" });

    expect(row.detail).toBe("Timed out");
    expect(row.tone).toBe("failed");
  });

  it("falls back to a trimmed prompt when the agent has no title", () => {
    const long = resolveSubagentRowPresentation({ ...base, prompt: "x".repeat(200) });
    const titled = resolveSubagentRowPresentation({ ...base, title: "Subagent: /root/my_worker" });

    expect(long.title).toHaveLength(80);
    expect(long.title.endsWith("...")).toBe(true);
    expect(titled.title).toBe("My Worker");
  });

  it("only offers a thread to open when the agent has one", () => {
    expect(resolveSubagentRowPresentation(base).canOpenThread).toBe(true);
    expect(resolveSubagentRowPresentation({ ...base, childThreadId: null }).canOpenThread).toBe(
      false,
    );
  });

  it("uses the status label when there is nothing to report yet", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "pending" });

    expect(row.detail).toBeNull();
    expect(row.statusLabel).toBe("Working");
  });

  it("bounds long result previews without dropping the agent's status", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "failed",
      result: "x".repeat(400),
    });
    expect(row.detail).toBe(`${"x".repeat(280)}…`);
    expect(row.statusLabel).toBe("Failed");
  });
});

describe("workflowTotalsLine", () => {
  it("leads the run totals with the settled agent count", () => {
    expect(workflowTotalsLine({ settled: 3, total: 12 }, "1.23M tok · 273 tools")).toBe(
      "3/12 agents · 1.23M tok · 273 tools",
    );
  });

  it("shows no line when the server reported no totals", () => {
    expect(workflowTotalsLine({ settled: 3, total: 12 }, null)).toBeNull();
  });

  it("drops the agent count before any agent is known", () => {
    expect(workflowTotalsLine({ settled: 0, total: 0 }, "4.1K tok")).toBe("4.1K tok");
  });
});
