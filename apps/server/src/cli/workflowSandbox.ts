import * as Effect from "effect/Effect";
import { Command } from "effect/cli";

import { runWorkflowSandboxProcess } from "../workflow/workflowSandboxProcess.ts";

/**
 * `t3 workflow-sandbox` — internal child process that runs one workflow
 * script for the T3 server, speaking newline-delimited JSON on stdio.
 *
 * Real invocations dispatch through the bin.ts fast path before the CLI
 * graph loads; this definition keeps the command wired for help and for
 * anything that drives the full CLI programmatically.
 */
export const workflowSandboxCommand = Command.make("workflow-sandbox").pipe(
  Command.withDescription("Run one workflow script for the T3 Code server."),
  Command.unlisted,
  Command.withHandler(() => Effect.promise(() => runWorkflowSandboxProcess())),
);
