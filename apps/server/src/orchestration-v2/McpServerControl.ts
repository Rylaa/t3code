import {
  OrchestrationControlMcpServerError,
  type OrchestrationV2ControlMcpServerInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * Acts on one MCP server of a thread's live provider session. Clients reach
 * it; agents do not, so an agent cannot reset its own servers. A stopped
 * session is reported, never started.
 */
export class McpServerControl extends Context.Service<
  McpServerControl,
  {
    readonly control: (
      input: OrchestrationV2ControlMcpServerInput,
    ) => Effect.Effect<void, OrchestrationControlMcpServerError>;
  }
>()("t3/orchestration-v2/McpServerControl") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

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
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["runs", "providerThreads"])
      .pipe(Effect.mapError((cause) => fail("request-failed", cause)));
    // Reconnecting mid-turn would cut off the turn's tool calls. A run
    // waiting on background work after its turn ended is not mid-turn.
    if (
      records.runs.some(
        (run) =>
          run.status === "preparing" || run.status === "starting" || run.status === "running",
      )
    ) {
      return yield* fail("run-active");
    }
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === records.thread.activeProviderThreadId,
    );
    if (providerThread?.providerSessionId == null) return yield* fail("session-stopped");
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.mapError((cause) => fail("request-failed", cause))),
    );
    if (runtime === undefined) return yield* fail("session-stopped");
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

  return McpServerControl.of({ control });
});

export const layer = Layer.effect(McpServerControl, make);
