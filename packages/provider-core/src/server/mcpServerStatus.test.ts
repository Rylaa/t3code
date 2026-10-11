import { describe, expect, it } from "@effect/vitest";
import { mcpServerStatusEntry } from "./mcpServerStatus.ts";

describe("mcpServerStatusEntry", () => {
  it("keeps only each URL's origin in the error, before trimming it", () => {
    const error = (text: string) =>
      mcpServerStatusEntry({ name: "remote", status: "failed", error: text }).error;
    // Recorded from codex app-server 0.162.1 for a server it could not reach.
    expect(
      error(
        "MCP startup failed: handshaking with MCP server failed: error sending request for url (http://127.0.0.1:9/mcp?token=query-secret), when send initialize request",
      ),
    ).toBe(
      "MCP startup failed: handshaking with MCP server failed: error sending request for url (http://127.0.0.1:9 when send initialize request",
    );
    expect(
      error("Could not reach https://user:pass-secret@example.com/mcp#frag-secret (ECONNREFUSED)"),
    ).toBe("Could not reach https://example.com (ECONNREFUSED)");
    // Hosted MCP servers put the secret in the path.
    expect(error("403 from https://actions.zapier.com/api/mcp/s/path-secret/mcp")).toBe(
      "403 from https://actions.zapier.com",
    );
    // A URL glued to a digit or underscore is still a URL.
    expect(error("HTTP 401https://user:pw-secret@a.example/x and ERR_https://b.example/s")).toBe(
      "HTTP 401https://a.example and ERR_https://b.example",
    );
    // Every URL of a comma-joined list, not only the first.
    expect(error("Tried https://a.example/x,https://user:pw-secret@b.example/mcp")).toBe(
      "Tried https://a.example",
    );
    // A URL that straddles the cap must lose its secrets, not be cut before them.
    const long = mcpServerStatusEntry({
      name: "remote",
      status: "failed",
      // Character 300 falls right after the password.
      error: `${"x".repeat(275)} https://user:pass-secret@example.com/?token=query-secret and the rest of the message`,
    }).error;
    expect(long).toHaveLength(300);
    expect(long).not.toContain("secret");
  });

  it("keeps at most 100 capped tool names and omits empty fields", () => {
    const entry = mcpServerStatusEntry({
      name: ` ${"n".repeat(250)} `,
      status: "connected",
      source: "  ",
      error: null,
      tools: [`${"t".repeat(250)}`, ...Array.from({ length: 150 }, (_, index) => `tool_${index}`)],
    });
    expect(entry.name).toBe("n".repeat(200));
    expect(entry.tools).toHaveLength(100);
    expect(entry.tools?.[0]).toBe("t".repeat(200));
    expect(entry.tools?.[99]).toBe("tool_98");
    expect(Object.keys(entry).toSorted()).toEqual(["name", "status", "tools"]);
    expect(mcpServerStatusEntry({ name: "idle", status: "pending", tools: [] })).toEqual({
      name: "idle",
      status: "pending",
    });
  });
});
