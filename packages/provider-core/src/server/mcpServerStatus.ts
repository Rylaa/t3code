import type { OrchestrationV2ProviderInventory } from "@t3tools/contracts";

/** T3's MCP status vocabulary; adapters map their provider's statuses onto it. */
export type McpServerStatus = "connected" | "pending" | "needs-auth" | "failed" | "disabled";

const TEXT_CAP = 200;
const ERROR_CAP = 300;
const TOOL_CAP = 100;

const capText = (value: string, cap: number) => value.trim().slice(0, cap);

/**
 * One server of `ProviderAdapterV2McpServers.status` in its sanitized shape.
 * The error keeps only each URL's origin (paths, credentials, queries and
 * fragments can all carry secrets) before it is trimmed to 300 characters, so
 * a URL the trim would cut is still reduced; at most 100 tool names of 200
 * characters each are kept. Callers pass only these fields: never config,
 * commands, URLs, headers, env or tool schemas; `signIn` is derived from the
 * config instead. `unknown` is for a status the provider reported outside
 * T3's vocabulary.
 */
export function mcpServerStatusEntry(input: {
  readonly name: string;
  readonly status: McpServerStatus | "unknown";
  readonly source?: string | null | undefined;
  readonly error?: string | null | undefined;
  readonly tools?: ReadonlyArray<string> | undefined;
  readonly signIn?: "oauth" | "claude-ai" | undefined;
}): OrchestrationV2ProviderInventory["mcpServers"][number] {
  const source = input.source == null ? "" : capText(input.source, TEXT_CAP);
  const error =
    input.error == null
      ? ""
      : capText(
          // No `\b`: "401https://..." is still a URL. A comma-joined list is one
          // match, so only its first origin survives.
          input.error.replace(/[a-z][a-z\d+.-]*:\/\/[^\s'"<>]*/giu, (url) =>
            url.replace(/^([^:]+:\/\/)(?:[^/?#\s]*@)?([^/?#@]*).*$/su, "$1$2"),
          ),
          ERROR_CAP,
        );
  const tools = (input.tools ?? []).slice(0, TOOL_CAP).map((tool) => capText(tool, TEXT_CAP));
  return {
    name: capText(input.name, TEXT_CAP),
    status: input.status,
    ...(source === "" ? {} : { source }),
    ...(error === "" ? {} : { error }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(input.signIn === undefined ? {} : { signIn: input.signIn }),
  };
}
