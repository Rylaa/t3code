import {
  OrchestratorMcpFailure,
  UsageLimitSourceSnapshot,
  UsageLimitSourceSwitchAccountResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    UsageLimitSources.UsageLimitSources,
  ],
};

const UsageLimitAccountsListTool = Tool.make("t3_usage_limit_accounts_list", {
  ...shared,
  description:
    "List the subscription accounts this environment's usage-limit sources report (CLIProxyAPI hubs, claude-swap), with each account's session and weekly windows. For claude-swap, `active` marks the machine's current Claude login and `id` is the slot t3_claude_account_switch takes.",
  success: Schema.Struct({ sources: Schema.Array(UsageLimitSourceSnapshot) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ClaudeAccountSwitchTool = Tool.make("t3_claude_account_switch", {
  ...shared,
  description:
    'Switch this machine\'s Claude login to another claude-swap account. Pass `accountId` and `email` from t3_usage_limit_accounts_list, or `strategy: "best"` to let claude-swap pick the account with the most headroom. Every Claude thread using the default Claude home moves to the new account on its next request, or within about 30 seconds on macOS. Requires claude-swap to be enabled in Settings and a live full-access/default calling thread.',
  parameters: Schema.Struct({
    accountId: Schema.optionalKey(Schema.String),
    email: Schema.optionalKey(Schema.String),
    strategy: Schema.optionalKey(Schema.Literal("best")),
  }),
  success: UsageLimitSourceSwitchAccountResult,
}).annotate(Tool.Destructive, true);

export const UsageToolkit = Toolkit.make(UsageLimitAccountsListTool, ClaudeAccountSwitchTool);
