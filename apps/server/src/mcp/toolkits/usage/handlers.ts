import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { UsageToolkit } from "./tools.ts";

const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return yield* UsageLimitSources.UsageLimitSources;
});

export const layer = McpToolAccess.toLayer(UsageToolkit, {
  t3_usage_limit_accounts_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const sources = yield* access;
      return { sources: yield* sources.current };
    }),
  ),
  t3_claude_account_switch: McpToolAccess.writesEnvironment((params, check) =>
    Effect.gen(function* () {
      const sources = yield* access;
      const sourceId = UsageLimitSources.CLAUDE_SWAP_SOURCE_ID;
      const accountId = params.accountId?.trim();
      const email = params.email?.trim();
      const input =
        params.strategy !== undefined
          ? { sourceId, strategy: params.strategy }
          : accountId && email
            ? { sourceId, accountId, email }
            : undefined;
      if (input === undefined || (params.strategy !== undefined && (accountId || email))) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass either accountId and email, or strategy: best.",
        });
      }
      // The turn may end, or the thread's modes change, while the switch waits for claude-swap.
      return yield* sources.switchAccount(input, { beforeSwitch: check.pipe(Effect.asVoid) }).pipe(
        Effect.catchTags({
          UsageLimitSourceError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "provider_unavailable", message: error.detail }),
            ),
        }),
      );
    }),
  ),
});
