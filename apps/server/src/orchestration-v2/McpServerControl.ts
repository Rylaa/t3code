import {
  OrchestrationControlMcpServerError,
  OrchestrationMcpServerAuthError,
  type OrchestrationMcpServerAuthErrorReason,
  type OrchestrationV2ControlMcpServerAuthInput,
  type OrchestrationV2ControlMcpServerInput,
  type OrchestrationV2McpServerAuthResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * Acts on one MCP server of a thread's live provider session: reconnects it,
 * or signs it in or out. Clients reach it; agents do not, so an agent cannot
 * reset its own servers, and an OAuth code never passes through a transcript
 * (sign-in needs a person at a browser anyway). A stopped session is
 * reported, never started.
 */
export class McpServerControl extends Context.Service<
  McpServerControl,
  {
    readonly control: (
      input: OrchestrationV2ControlMcpServerInput,
    ) => Effect.Effect<void, OrchestrationControlMcpServerError>;
    readonly auth: (
      input: OrchestrationV2ControlMcpServerAuthInput,
    ) => Effect.Effect<OrchestrationV2McpServerAuthResult, OrchestrationMcpServerAuthError>;
  }
>()("t3/orchestration-v2/McpServerControl") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  /** The thread's live provider thread and runtime, or `fail` with why there is none. */
  const liveSession = Effect.fn("McpServerControl.liveSession")(function* <E>(
    threadId: ThreadId,
    refuseActiveRun: boolean,
    fail: (reason: "run-active" | "session-stopped" | "request-failed", cause?: unknown) => E,
  ) {
    const records = yield* threadManagement
      .getThreadRecords(threadId, ["runs", "providerThreads"])
      .pipe(Effect.mapError((cause) => fail("request-failed", cause)));
    // Reconnecting mid-turn would cut off the turn's tool calls. A run
    // waiting on background work after its turn ended is not mid-turn.
    if (
      refuseActiveRun &&
      records.runs.some(
        (run) =>
          run.status === "preparing" || run.status === "starting" || run.status === "running",
      )
    ) {
      return yield* Effect.fail(fail("run-active"));
    }
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === records.thread.activeProviderThreadId,
    );
    if (providerThread?.providerSessionId == null) {
      return yield* Effect.fail(fail("session-stopped"));
    }
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.mapError((cause) => fail("request-failed", cause))),
    );
    if (runtime === undefined) return yield* Effect.fail(fail("session-stopped"));
    return { providerThread, runtime };
  });

  const control = Effect.fn("McpServerControl.control")(function* (
    input: OrchestrationV2ControlMcpServerInput,
  ) {
    const fail = (reason: OrchestrationControlMcpServerError["reason"], cause?: unknown) =>
      new OrchestrationControlMcpServerError({
        threadId: input.threadId,
        server: input.server,
        reason,
        ...(cause === undefined ? {} : { cause }),
      });
    const { providerThread, runtime } = yield* liveSession(input.threadId, true, fail);
    const reconnect = runtime.mcpServers?.reconnect;
    if (reconnect === undefined) return yield* fail("provider-unsupported");
    yield* reconnect({ providerThread, server: input.server }).pipe(
      // The provider's error can quote the server's command or URL, so it is
      // logged here and never sent to the client.
      Effect.tapError((cause) =>
        Effect.logWarning("orchestration-v2.mcp-server-control.reconnect-failed", {
          threadId: input.threadId,
          cause,
        }),
      ),
      Effect.mapError(() => fail("request-failed")),
    );
  });

  const auth = Effect.fn("McpServerControl.auth")(function* (
    input: OrchestrationV2ControlMcpServerAuthInput,
  ) {
    // Never a cause: the input's callback URL carries an OAuth code.
    const fail = (reason: OrchestrationMcpServerAuthErrorReason) =>
      new OrchestrationMcpServerAuthError({
        threadId: input.threadId,
        server: input.server,
        action: input.action,
        reason,
      });
    // Signing out reconnects a connected server, which would cut off the
    // turn's tool calls. Signing in only touches a server that is not
    // connected, so it may run mid-turn, as in Claude Code.
    const { providerThread, runtime } = yield* liveSession(
      input.threadId,
      input.action === "sign-out",
      fail,
    );
    const target = { providerThread, server: input.server };
    const servers = runtime.mcpServers;
    // Only sign-in answers with a page; the other actions are done when they return.
    const done = { callbackExpected: false };
    const request =
      input.action === "finish-sign-in"
        ? servers
            ?.completeAuthentication?.({ ...target, callbackUrl: input.callbackUrl })
            .pipe(Effect.as(done))
        : input.action === "sign-in"
          ? servers?.authenticate?.(target)
          : servers?.clearAuthentication?.(target).pipe(Effect.as(done));
    if (request === undefined) return yield* fail("provider-unsupported");
    return yield* request.pipe(
      // Only the outcome: the provider's text and the URLs stay out of logs.
      Effect.tapError((error) =>
        Effect.logWarning("orchestration-v2.mcp-server-auth.failed", {
          threadId: input.threadId,
          action: input.action,
          outcome: error.reason,
        }),
      ),
      Effect.mapError((error) => fail(error.reason)),
    );
  });

  return McpServerControl.of({ control, auth });
});

export const layer = Layer.effect(McpServerControl, make);
