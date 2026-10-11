import {
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationControlMcpServerError,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpServerControl from "./McpServerControl.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread-mcp");
const providerThreadId = ProviderThreadId.make("provider-thread-mcp");
const providerSessionId = ProviderSessionId.make("provider-session-mcp");

function makeLayer(input: {
  readonly reconnected: Array<string>;
  readonly runStatus?: OrchestrationV2Run["status"];
  readonly live?: boolean;
  readonly sessionId?: ProviderSessionId | null;
  readonly runtime?: Partial<ProviderAdapterV2SessionRuntime>;
}) {
  const runtime = input.runtime ?? {
    mcpServers: {
      status: () => Effect.succeed([]),
      reconnect: ({ providerThread, server }) =>
        Effect.sync(() => {
          input.reconnected.push(`${providerThread.id}/${server}`);
        }),
    },
  };
  return McpServerControl.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { activeProviderThreadId: providerThreadId },
              runs: input.runStatus === undefined ? [] : [{ status: input.runStatus }],
              providerThreads: [
                {
                  id: providerThreadId,
                  providerSessionId:
                    input.sessionId === undefined ? providerSessionId : input.sessionId,
                } as OrchestrationV2ProviderThread,
              ],
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              input.live === false
                ? Option.none()
                : Option.some(runtime as ProviderAdapterV2SessionRuntime),
            ),
        }),
      ),
    ),
  );
}

const reconnect = (server: string) =>
  McpServerControl.McpServerControl.pipe(
    Effect.flatMap((control) => control.control({ threadId, server, action: "reconnect" })),
  );

const failure = <A, R>(effect: Effect.Effect<A, OrchestrationControlMcpServerError, R>) =>
  effect.pipe(Effect.flip);

describe("McpServerControl", () => {
  it.effect.each([
    { name: "a server", server: "context7", runStatus: undefined },
    { name: "T3's own server", server: "t3-code", runStatus: undefined },
    {
      name: "a server while a finished turn waits on background work",
      server: "context7",
      runStatus: "waiting",
    },
  ] as const)("reconnects $name through the live session", (testCase) => {
    const reconnected: Array<string> = [];
    return Effect.gen(function* () {
      yield* reconnect(testCase.server);
      assert.deepEqual(reconnected, [`${providerThreadId}/${testCase.server}`]);
    }).pipe(
      Effect.provide(
        makeLayer({
          reconnected,
          ...(testCase.runStatus === undefined ? {} : { runStatus: testCase.runStatus }),
        }),
      ),
    );
  });

  it.effect.each([
    { name: "a preparing run", input: { runStatus: "preparing" }, expected: "run-active" },
    { name: "a starting run", input: { runStatus: "starting" }, expected: "run-active" },
    { name: "a running turn", input: { runStatus: "running" }, expected: "run-active" },
    { name: "a thread without a session", input: { sessionId: null }, expected: "session-stopped" },
    { name: "a released session", input: { live: false }, expected: "session-stopped" },
    {
      name: "a provider without MCP control",
      input: { runtime: {} },
      expected: "provider-unsupported",
    },
    {
      name: "a provider that reads MCP status only",
      input: { runtime: { mcpServers: { status: () => Effect.succeed([]) } } },
      expected: "provider-unsupported",
    },
  ] as const)("refuses $name without reconnecting", (testCase) => {
    const reconnected: Array<string> = [];
    return Effect.gen(function* () {
      assert.equal((yield* failure(reconnect("context7"))).reason, testCase.expected);
      assert.deepEqual(reconnected, []);
    }).pipe(Effect.provide(makeLayer({ reconnected, ...testCase.input })));
  });

  it.effect("reports a failed reconnect without forwarding the provider's error", () =>
    Effect.gen(function* () {
      const error = yield* failure(reconnect("broken"));
      assert.equal(error.reason, "request-failed");
      assert.isUndefined(error.cause);
    }).pipe(
      Effect.provide(
        makeLayer({
          reconnected: [],
          runtime: {
            mcpServers: {
              status: () => Effect.succeed([]),
              reconnect: () =>
                Effect.fail(
                  new ProviderAdapterProtocolError({
                    driver: ProviderDriverKind.make("claudeAgent"),
                    detail: "Claude could not reconnect an MCP server",
                    cause: new Error("spawn /secret/bin --token=abc ENOENT"),
                  }),
                ),
            },
          },
        }),
      ),
    ),
  );
});
