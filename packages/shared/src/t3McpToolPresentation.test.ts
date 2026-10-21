import { describe, expect, it } from "vite-plus/test";

import {
  T3_MCP_TOOL_NAMES,
  isT3McpServerName,
  resolveT3McpToolPresentation,
  resolveT3McpToolDefinition,
} from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
  it("recognizes every T3 tool across provider prefixes and completion suffixes", () => {
    for (const tool of T3_MCP_TOOL_NAMES) {
      const presentation = resolveT3McpToolPresentation(tool);
      for (const prefix of [
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "T3-code.",
        "t3_code/",
        "t3code:",
        "mcp_t3-code_",
        "T3 Code ",
        "t3-code · ",
      ]) {
        expect(resolveT3McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveT3McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("presents workflow tools under one workflow summary", () => {
    expect(resolveT3McpToolPresentation("mcp__t3-code__workflow_run")?.displayName).toBe(
      "Run a workflow",
    );
    expect(resolveT3McpToolDefinition("t3-code.workflow_run")?.summaryAction).toBe("workflow");
    expect(resolveT3McpToolPresentation("mcp__t3-code__workflow_wait")?.displayName).toBe(
      "Wait for a workflow",
    );
    expect(resolveT3McpToolDefinition("t3-code.workflow_wait")?.summaryAction).toBe("workflow");
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveT3McpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveT3McpToolPresentation("t3-code-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });
});

describe("isT3McpServerName", () => {
  it("recognizes T3's own server under every provider's name for it", () => {
    for (const name of ["t3-code", "T3_Code", "t3code", "t3-code-thread_opencode2-adapter"]) {
      expect(isT3McpServerName(name)).toBe(true);
    }
    for (const name of ["github", "t3", "my-t3-code", "t3-codex", "plugin:t3-code"]) {
      expect(isT3McpServerName(name)).toBe(false);
    }
  });
});
