import { assert, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpWorkflowResult,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/ai";
import * as NodeURL from "node:url";

import { runWorkflowScript } from "../../../workflow/WorkflowEngine.ts";
import * as WorkflowRunner from "../../../workflow/WorkflowRunner.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import {
  CreateThreadsTool,
  DelegateTaskTool,
  OrchestratorToolkit,
  ScheduleTaskTool,
  ThreadUpdateTool,
  WorkflowRunTool,
} from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("directs subagent requests to delegation instead of ordinary threads", () => {
    assert.include(DelegateTaskTool.description ?? "", "child agent/subagent");
    assert.include(DelegateTaskTool.description ?? "", "cross-provider");
    assert.include(CreateThreadsTool.description ?? "", "not delegation");
    assert.include(CreateThreadsTool.description ?? "", "call delegate_task");
    assert.include(DelegateTaskTool.description ?? "", "waitTimedOut");
    assert.include(DelegateTaskTool.description ?? "", "does not cancel the child");
    assert.include(DelegateTaskTool.description ?? "", "keep that taskId");
    assert.include(DelegateTaskTool.description ?? "", "call delegate_task again");
    assert.include(DelegateTaskTool.description ?? "", "childThreadId is backing storage");
    assert.include(
      OrchestratorToolkit.tools.t3_thread_send.description ?? "",
      "Do not use a delegated task's childThreadId to start another review round",
    );
    assert.include(
      OrchestratorToolkit.tools.task_cancel.description ?? "",
      "This includes later child-thread runs, even after the task is terminal",
    );
  });

  it("documents wait timeout as a parent budget, not a child failure", () => {
    const schema = Tool.getJsonSchema(DelegateTaskTool) as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly description?: unknown;
            readonly anyOf?: ReadonlyArray<{ readonly description?: unknown }>;
          }
        >
      >;
    };
    const mode = schema.properties?.mode;
    const timeoutMs = schema.properties?.timeoutMs;
    const modeText = [mode?.description, ...(mode?.anyOf ?? []).map((entry) => entry.description)]
      .filter((value) => typeof value === "string")
      .join(" ");
    const timeoutText = [
      timeoutMs?.description,
      ...(timeoutMs?.anyOf ?? []).map((entry) => entry.description),
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
    assert.include(modeText, "Defaults to async");
    assert.include(timeoutText, "does not cancel the child");
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.isString(schema.properties?.schedule?.description);
    assert.isAtLeast(schema.properties?.schedule?.anyOf?.length ?? 0, 2);
    assert.include(ScheduleTaskTool.description ?? "", "STRUCTURED OBJECT");
    assert.include(ScheduleTaskTool.description ?? "", "nextRunAt");
  });

  it("publishes thread metadata actions from an object-root schema", () => {
    const schema = Tool.getJsonSchema(ThreadUpdateTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.hasAllKeys(schema.properties ?? {}, [
      "threadId",
      "action",
      "title",
      "pullRequest",
      "clientRequestId",
    ]);
    assert.include(ThreadUpdateTool.description ?? "", "Workspace and branch changes");
  });
});

describe("workflow tools", () => {
  const decodeRunInput = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.workflow_run.parametersSchema,
  );
  const decodeWaitInput = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.workflow_wait.parametersSchema,
  );

  it("decodes workflow_run and workflow_wait parameters", () => {
    assert.isTrue(
      Exit.isSuccess(
        decodeRunInput({ script: "return 1", args: '{"n":1}', title: "Count", waitMs: 1000 }),
      ),
    );
    assert.isTrue(Exit.isFailure(decodeRunInput({})));
    assert.isTrue(Exit.isFailure(decodeRunInput({ script: "   " })));
    assert.isTrue(Exit.isFailure(decodeRunInput({ script: "x".repeat(120_001) })));
    assert.isTrue(Exit.isFailure(decodeRunInput({ script: "return 1", waitMs: "soon" })));
    assert.isTrue(Exit.isSuccess(decodeWaitInput({ runId: "workflow-1", resultOffset: 30_000 })));
    assert.isTrue(Exit.isFailure(decodeWaitInput({ resultOffset: 0 })));
    assert.isTrue(Exit.isFailure(decodeWaitInput({ runId: "workflow-1", resultOffset: -1 })));
  });

  it("documents the script API, the lifetime and result paging", () => {
    const description = WorkflowRunTool.description ?? "";
    for (const global of [
      "agent(prompt, {label, phase, model, schema})",
      "parallel(thunks)",
      "pipeline(items, ...stages)",
      "stage(prev, item, index)",
      "phase(title)",
      "log(message)",
      "- args:",
    ]) {
      assert.include(description, global);
    }
    assert.include(description, "null when the agent fails");
    assert.include(description, "Default to pipeline");
    assert.include(description, "Full access");
    assert.include(description, "Not available to subagents");
    assert.include(description, "1000 agent() calls");
    for (const limit of [
      "a prompt over 120000 characters",
      "trim results or reduce them in batches",
      "at most 4096 items",
      "cancelled and returns null",
      "cut to 200 characters",
      "WebAssembly, Intl or Temporal",
      "at most 4 MB",
    ]) {
      assert.include(description, limit);
    }
    assert.include(description, "keep calling workflow_wait");
    assert.include(description, "a turn that ends first interrupts the workflow");
    assert.include(description, "default 45000");
    assert.include(description, "resultOffset set to resultOffset plus the length of result");
    const waitDescription = OrchestratorToolkit.tools.workflow_wait.description ?? "";
    assert.include(waitDescription, "resultOffset");
    assert.include(waitDescription, "Call it again while status is running");
  });

  // 475 files is the most the 1000-agent cap allows: 950 reviews and checks, 48 batch
  // merges and the final merge, whose prompt is the largest at about 96000 characters.
  it.each([0, 25, 475])("runs the example within the prompt cap for %i files", async (files) => {
    const description = WorkflowRunTool.description ?? "";
    const example = description.slice(
      description.indexOf("\n", description.indexOf("EXAMPLE")) + 1,
    );
    const promptLengths: Array<number> = [];
    const result = await runWorkflowScript(
      {
        script: example,
        args: { files: Array.from({ length: files }, (_, index) => `src/file${index}.ts`) },
        sandbox: {
          command: process.execPath,
          args: [
            NodeURL.fileURLToPath(new URL("../../../bin.ts", import.meta.url)),
            "workflow-sandbox",
          ],
        },
        runAgent: async (request) => {
          promptLengths.push(request.prompt.length);
          return "r".repeat(3000);
        },
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, value: "r".repeat(3000) });
    expect(Math.max(...promptLengths)).toBeLessThanOrEqual(120_000);
  });

  const workflowResult: OrchestratorMcpWorkflowResult = {
    runId: "workflow-1",
    status: "running",
    title: "Count",
    result: null,
    resultChars: 0,
    resultOffset: 0,
    resultTruncated: false,
    error: null,
    progress: {
      phase: "Review",
      recentLog: ["reviewing"],
      agents: { started: 2, running: 2, completed: 0, failed: 0 },
    },
    elapsedMs: 1000,
  };
  const runnerCalls: Array<unknown> = [];
  const threadId = ThreadId.make("thread:workflow-caller");
  const threadCaller: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "provider:workflow",
    thread: {
      threadId,
      providerSessionId: "provider:workflow",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  };
  const clientCaller: McpInvocationContext.McpInvocationScope = {
    ...threadCaller,
    requestNamespace: "client:session",
    thread: undefined,
    client: { sessionId: "session", label: "Claude Code", access: "full-access" },
  };
  const mcpClient = McpSchema.McpServerClient.of({
    clientId: 1,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
    clientInfo: { name: "workflow-test", version: "1" },
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "workflow-test", version: "1" },
    },
    getClient: Effect.die("unused"),
  });
  const layerWorkflowTools = McpHttpServer.toolkitRegistration(
    OrchestratorToolkit,
    OrchestratorHandlers.layer,
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(liveThreadsLayer),
    Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
    Layer.provide(Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({})),
    Layer.provide(
      Layer.succeed(
        WorkflowRunner.WorkflowRunner,
        WorkflowRunner.WorkflowRunner.of({
          start: (scope, input) =>
            Effect.sync(() => {
              runnerCalls.push({ method: "start", threadId: scope.thread?.threadId, input });
              return workflowResult;
            }),
          wait: (scope, input) =>
            input.runId === "workflow-unknown"
              ? Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "run_not_found",
                    message: "No workflow workflow-unknown.",
                  }),
                )
              : Effect.sync(() => {
                  runnerCalls.push({ method: "wait", threadId: scope.thread?.threadId, input });
                  return { ...workflowResult, resultOffset: input.resultOffset ?? 0 };
                }),
        }),
      ),
    ),
  );
  const call = (
    scope: McpInvocationContext.McpInvocationScope,
    name: string,
    args: Record<string, unknown>,
  ) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: args })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
    );
  // Effect returns a declared tool failure as `isError` with its encoded
  // payload as JSON text.
  const declaredFailure = (result: McpSchema.CallToolResult) => {
    const text = result.content[0];
    return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
  };

  it.effect("hands the decoded input to the workflow runner as the calling thread", () =>
    Effect.gen(function* () {
      runnerCalls.length = 0;
      const run = yield* call(threadCaller, "workflow_run", {
        script: "return 1",
        args: '{"n":1}',
        title: "Count",
        waitMs: 1000,
      });
      expect(run.isError).toBe(false);
      expect(run.structuredContent).toEqual(workflowResult);
      const wait = yield* call(threadCaller, "workflow_wait", {
        runId: "workflow-1",
        resultOffset: 30_000,
      });
      expect(wait.structuredContent).toMatchObject({ runId: "workflow-1", resultOffset: 30_000 });
      expect(runnerCalls).toEqual([
        {
          method: "start",
          threadId,
          input: { script: "return 1", args: '{"n":1}', title: "Count", waitMs: 1000 },
        },
        {
          method: "wait",
          threadId,
          input: { runId: "workflow-1", waitMs: undefined, resultOffset: 30_000 },
        },
      ]);

      const unknown = yield* call(threadCaller, "workflow_wait", { runId: "workflow-unknown" });
      expect(declaredFailure(unknown)).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "run_not_found",
      });
    }).pipe(Effect.provide(layerWorkflowTools)),
  );

  it.effect("refuses a caller that is not a T3 thread before the runner sees it", () =>
    Effect.gen(function* () {
      runnerCalls.length = 0;
      const run = yield* call(clientCaller, "workflow_run", { script: "return 1" });
      expect(declaredFailure(run)).toMatchObject({ code: "thread_credential_required" });
      const wait = yield* call(clientCaller, "workflow_wait", { runId: "workflow-1" });
      expect(declaredFailure(wait)).toMatchObject({ code: "thread_credential_required" });
      expect(runnerCalls).toEqual([]);
    }).pipe(Effect.provide(layerWorkflowTools)),
  );
});
