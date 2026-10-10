/**
 * Thin CLI entry.
 *
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session,
 * terminal-fallback agents run `t3 acp-mcp-call` per tool call, and every
 * workflow run starts its script in `t3 workflow-sandbox`, so their startup
 * sits on latency someone waits for. They dispatch here before the full CLI
 * module graph (seconds of evaluation) loads; everything else defers to the
 * real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (command === "workflow-sandbox") {
    const { runWorkflowSandboxProcess } = await import("./workflow/workflowSandboxProcess.ts");
    await runWorkflowSandboxProcess();
  } else {
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
