import {
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationStopSubagentError,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as SubagentControl from "./SubagentControl.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread-workflow");
const subagentId = NodeId.make("node-workflow");
const providerThreadId = ProviderThreadId.make("provider-thread-workflow");
const providerSessionId = ProviderSessionId.make("provider-session-workflow");

const workflowSubagent = (
  overrides: Partial<OrchestrationV2Subagent> = {},
): Partial<OrchestrationV2Subagent> => ({
  id: subagentId,
  origin: "provider_native",
  status: "running",
  providerThreadId: null,
  nativeTaskRef: { driver: "claudeAgent" as never, nativeId: "wf-task", strength: "strong" },
  ...overrides,
});

function makeLayer(input: {
  readonly subagent: Partial<OrchestrationV2Subagent>;
  readonly live?: boolean;
  readonly stopped: Array<string>;
  readonly supportsStop?: boolean;
}) {
  const runtime: Partial<ProviderAdapterV2SessionRuntime> =
    input.supportsStop === false
      ? {}
      : {
          stopSubagent: ({ nativeTaskId }) =>
            Effect.sync(() => {
              input.stopped.push(nativeTaskId);
            }),
        };
  return SubagentControl.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { activeProviderThreadId: providerThreadId },
              subagents: [input.subagent],
              providerThreads: [
                { id: providerThreadId, providerSessionId } as OrchestrationV2ProviderThread,
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

const reason = <A, R>(effect: Effect.Effect<A, OrchestrationStopSubagentError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("SubagentControl", () => {
  it.effect("stops a running provider-native subagent by its native task id", () => {
    const stopped: Array<string> = [];
    return Effect.gen(function* () {
      const control = yield* SubagentControl.SubagentControl;
      yield* control.stop({ threadId, subagentId });
      assert.deepEqual(stopped, ["wf-task"]);
    }).pipe(Effect.provide(makeLayer({ subagent: workflowSubagent(), stopped })));
  });

  it.effect.each([
    {
      name: "a missing subagent",
      subagent: workflowSubagent({ id: NodeId.make("other") }),
      expected: "not-found",
    },
    {
      name: "a settled subagent",
      subagent: workflowSubagent({ status: "completed" }),
      expected: "not-running",
    },
    {
      name: "an app-owned subagent",
      subagent: workflowSubagent({ origin: "app_owned" }),
      expected: "provider-unsupported",
    },
    {
      name: "a stopped session",
      subagent: workflowSubagent(),
      live: false,
      expected: "session-stopped",
    },
    {
      name: "a provider without task stop",
      subagent: workflowSubagent(),
      supportsStop: false,
      expected: "provider-unsupported",
    },
  ] as const)("refuses $name without stopping anything", (testCase) => {
    const stopped: Array<string> = [];
    return Effect.gen(function* () {
      const control = yield* SubagentControl.SubagentControl;
      assert.equal(yield* reason(control.stop({ threadId, subagentId })), testCase.expected);
      assert.deepEqual(stopped, []);
    }).pipe(
      Effect.provide(
        makeLayer({
          subagent: testCase.subagent,
          stopped,
          ...("live" in testCase ? { live: testCase.live } : {}),
          ...("supportsStop" in testCase ? { supportsStop: testCase.supportsStop } : {}),
        }),
      ),
    );
  });
});
