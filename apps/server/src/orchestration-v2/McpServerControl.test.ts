import {
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ControlMcpServerAuthInput,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import {
  ProviderAdapterMcpServerAuthError,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2McpServers,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";

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

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.flip);

const driver = ProviderDriverKind.make("claudeAgent");
const CODE = "oauth-code-secret";
const STATE = "oauth-state-secret";

/** A provider whose MCP sign-in records each request and answers like Claude. */
function signInServers(requests: Array<string>): ProviderAdapterV2McpServers {
  return {
    status: () => Effect.succeed([]),
    authenticate: ({ providerThread, server }) =>
      Effect.sync(() => {
        requests.push(`sign-in ${providerThread.id}/${server}`);
        return {
          authUrl: `https://auth.example/authorize?state=${STATE}`,
          callbackExpected: true,
        };
      }),
    completeAuthentication: ({ server, callbackUrl }) =>
      callbackUrl.includes("state=old")
        ? Effect.fail(new ProviderAdapterMcpServerAuthError({ driver, reason: "state-mismatch" }))
        : Effect.sync(() => {
            requests.push(`finish ${server} ${callbackUrl}`);
          }),
    clearAuthentication: ({ server }) =>
      Effect.sync(() => {
        requests.push(`sign-out ${server}`);
      }),
  };
}

const auth = (input: OrchestrationV2ControlMcpServerAuthInput) =>
  McpServerControl.McpServerControl.pipe(Effect.flatMap((control) => control.auth(input)));
const signIn = auth({ threadId, server: "linear", action: "sign-in" });
const finish = (callbackUrl: string) =>
  auth({ threadId, server: "linear", action: "finish-sign-in", callbackUrl });
const signOut = auth({ threadId, server: "linear", action: "sign-out" });

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

  it.effect("signs a server in, finishes and signs it out through the live session", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      assert.deepEqual(yield* signIn, {
        authUrl: `https://auth.example/authorize?state=${STATE}`,
        callbackExpected: true,
      });
      assert.deepEqual(yield* finish(`http://localhost:1/callback?code=${CODE}`), {
        callbackExpected: false,
      });
      assert.deepEqual(yield* signOut, { callbackExpected: false });
      assert.deepEqual(requests, [
        `sign-in ${providerThreadId}/linear`,
        `finish linear http://localhost:1/callback?code=${CODE}`,
        "sign-out linear",
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({ reconnected: [], runtime: { mcpServers: signInServers(requests) } }),
      ),
    );
  });

  it.effect("signs in mid-turn but refuses to sign out until the turn ends", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      yield* signIn;
      yield* finish(`http://localhost:1/callback?code=${CODE}`);
      const refused = yield* failure(signOut);
      assert.equal(refused.reason, "run-active");
      assert.equal(refused.message, "Wait for the current turn to finish, then try again.");
      assert.deepEqual(
        requests.map((request) => request.split(" ")[0]),
        ["sign-in", "finish"],
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          reconnected: [],
          runStatus: "running",
          runtime: { mcpServers: signInServers(requests) },
        }),
      ),
    );
  });

  it.effect.each([
    { name: "a thread without a session", input: { sessionId: null }, expected: "session-stopped" },
    { name: "a released session", input: { live: false }, expected: "session-stopped" },
    {
      name: "a provider that reconnects but cannot sign in",
      input: {},
      expected: "provider-unsupported",
    },
  ] as const)("refuses every sign-in action for $name", (testCase) =>
    Effect.gen(function* () {
      for (const effect of [signIn, finish(`http://localhost:1/callback?code=${CODE}`), signOut]) {
        assert.equal((yield* failure(effect)).reason, testCase.expected);
      }
    }).pipe(Effect.provide(makeLayer({ reconnected: [], ...testCase.input }))),
  );

  it.effect("keeps the OAuth code and state out of logs and errors", () => {
    const logged: Array<string> = [];
    const logger = Logger.make((options) => {
      logged.push(
        JSON.stringify([options.message, options.fiber.getRef(References.CurrentLogAnnotations)]),
      );
    });
    return Effect.gen(function* () {
      yield* signIn;
      const mismatch = yield* failure(finish(`http://localhost:1/callback?code=${CODE}&state=old`));
      assert.equal(mismatch.reason, "state-mismatch");
      assert.equal(
        mismatch.message,
        "That address belongs to a different sign-in. Paste the address from the page this sign-in opened.",
      );
      assert.isNotEmpty(logged);
      // The error is what the client receives; the log is what the server keeps.
      for (const text of [...logged, JSON.stringify(mismatch)]) {
        assert.notInclude(text, CODE);
        assert.notInclude(text, STATE);
        assert.notInclude(text, "callback");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeLayer({ reconnected: [], runtime: { mcpServers: signInServers([]) } }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
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
