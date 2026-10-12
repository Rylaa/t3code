/**
 * Signing in to an MCP server from the Skills & plugins panel, shared by web
 * and mobile: the state of the panel's one sign-in, its texts, and how a
 * pasted redirect address is checked. The server runs the sign-in through
 * `orchestration.controlMcpServerAuth`; this only tracks it. Never show or
 * log the full sign-in page address or a pasted address: the first carries
 * the sign-in's state, the second its code.
 */
import {
  MCP_SERVER_AUTH_URL_MAX_LENGTH,
  mcpServerAuthErrorMessage,
  OrchestrationControlMcpServerError,
  OrchestrationMcpServerAuthError,
  type OrchestrationMcpServerAuthErrorReason,
  type OrchestrationV2McpServerAuthResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Claude Code drops a sign-in it has waited on this long. */
export const MCP_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** How often to read the live MCP status again while a sign-in waits: no event reports the change. */
export const MCP_SIGN_IN_POLL_MS = 3_000;

/**
 * Why a sign-in failed: the server's reasons, plus `not-authorized` for a
 * claude.ai connector that still is not authorized when its connection is checked.
 */
export type McpSignInErrorCode = OrchestrationMcpServerAuthErrorReason | "not-authorized";

interface McpSignInPending {
  readonly server: string;
  /** The sign-in page's host, shown instead of its address. Null when no approval is needed. */
  readonly authUrlHost: string | null;
  /** The page to open, from a click or tap only. Null when no approval is needed. */
  readonly openUrl: string | null;
  /** When this wait began; it expires `MCP_SIGN_IN_TIMEOUT_MS` later. */
  readonly startedAt: number;
  /**
   * True when the provider waits for the browser's redirect: offer the paste
   * field. False for a claude.ai connector: offer Check connection, which
   * reconnects the server (controlMcpServer).
   */
  readonly callbackExpected: boolean;
  /** A refusal that leaves the sign-in waiting, such as a pasted address from another sign-in. */
  readonly error: McpSignInErrorCode | null;
}

/**
 * idle → starting → waiting → finishing → done, or failed from any of them;
 * failed → done once Check connection connects the server.
 * `server` is the MCP server's name, as the row's `row.name`.
 */
export type McpSignInState =
  | { readonly phase: "idle" }
  | { readonly phase: "starting"; readonly server: string }
  | ({ readonly phase: "waiting" } & McpSignInPending)
  | ({ readonly phase: "finishing" } & McpSignInPending)
  | { readonly phase: "done"; readonly server: string }
  | { readonly phase: "failed"; readonly server: string; readonly code: McpSignInErrorCode };

export type McpSignInEvent =
  /** Sign in was chosen; send `sign-in`. Ignored while a request is in flight. */
  | { readonly type: "start"; readonly server: string }
  /** The `sign-in` request answered. */
  | {
      readonly type: "started";
      readonly result: OrchestrationV2McpServerAuthResult;
      readonly now: number;
    }
  /** A pasted address passed `mcpSignInPasteError`; send it with `finish-sign-in`. */
  | { readonly type: "submit"; readonly now: number }
  /** A request failed, as `mcpSignInErrorCode` reads its error. */
  | { readonly type: "failed"; readonly code: McpSignInErrorCode }
  /**
   * A live status read for the sign-in's server, after every poll while it
   * waits; `connected` too once Check connection's reconnect succeeds.
   */
  | { readonly type: "status"; readonly status: string | undefined; readonly now: number }
  /**
   * Closes the panel locally. The server has no cancel: the provider drops an
   * unfinished sign-in on its own after five minutes.
   */
  | { readonly type: "cancel" };

export const MCP_SIGN_IN_IDLE: McpSignInState = { phase: "idle" };

/** Failures that leave the sign-in waiting, so the user can paste again or check again. */
const RETRYABLE: ReadonlySet<McpSignInErrorCode> = new Set([
  "state-mismatch",
  "missing-code",
  "not-authorized",
  "run-active",
]);

/** The page as host and address, or null unless it is an http(s) URL. */
function signInPage(authUrl: string): { readonly host: string; readonly url: string } | null {
  try {
    const url = new URL(authUrl);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host !== ""
      ? { host: url.host, url: authUrl }
      : null;
  } catch {
    return null;
  }
}

/**
 * A claude.ai connector's wait: nothing expires on that side and its status
 * changes only when Check connection reconnects it, so it neither expires nor polls.
 */
function awaitsCheck(state: McpSignInPending): boolean {
  return !state.callbackExpected && state.openUrl !== null;
}

export function mcpSignInReducer(state: McpSignInState, event: McpSignInEvent): McpSignInState {
  switch (event.type) {
    case "start":
      // Choosing Sign in again starts a fresh sign-in; the provider replaces the old one.
      return state.phase === "starting" || state.phase === "finishing"
        ? state
        : { phase: "starting", server: event.server };
    case "started": {
      if (state.phase !== "starting") return state;
      const { authUrl, callbackExpected } = event.result;
      const page = authUrl === undefined ? null : signInPage(authUrl);
      if (authUrl !== undefined && page === null) {
        return { phase: "failed", server: state.server, code: "request-failed" };
      }
      return {
        phase: "waiting",
        server: state.server,
        authUrlHost: page?.host ?? null,
        openUrl: page?.url ?? null,
        startedAt: event.now,
        callbackExpected: page !== null && callbackExpected,
        error: null,
      };
    }
    case "submit":
      // The code is in: the provider's own wait no longer bounds this one.
      return state.phase === "waiting" && state.callbackExpected
        ? { ...state, phase: "finishing", startedAt: event.now, error: null }
        : state;
    case "failed":
      if (state.phase === "starting") {
        return { phase: "failed", server: state.server, code: event.code };
      }
      // A refused Check connection (say, run-active) says why; a still-unauthorized one keeps the text.
      if (state.phase === "failed") {
        return event.code === "not-authorized" ? state : { ...state, code: event.code };
      }
      if (state.phase !== "waiting" && state.phase !== "finishing") return state;
      return RETRYABLE.has(event.code)
        ? { ...state, phase: "waiting", error: event.code }
        : { phase: "failed", server: state.server, code: event.code };
    case "status":
      // A failed sign-in still ends signed in when a sign-in from the fallback connects it.
      if (state.phase === "failed") {
        return event.status === "connected" ? { phase: "done", server: state.server } : state;
      }
      if (state.phase !== "waiting" && state.phase !== "finishing") return state;
      // Only Connected ends a sign-in early: a status read just after the code
      // went in can still show the server's old status.
      if (event.status === "connected") return { phase: "done", server: state.server };
      if (awaitsCheck(state) || event.now - state.startedAt < MCP_SIGN_IN_TIMEOUT_MS) return state;
      return {
        phase: "failed",
        server: state.server,
        code: state.phase === "finishing" ? "request-failed" : "flow-expired",
      };
    case "cancel":
      return MCP_SIGN_IN_IDLE;
  }
}

/** Whether to read the live status every `MCP_SIGN_IN_POLL_MS`. */
export function mcpSignInPolling(state: McpSignInState): boolean {
  return (state.phase === "waiting" || state.phase === "finishing") && !awaitsCheck(state);
}

const isMcpServerAuthError = Schema.is(OrchestrationMcpServerAuthError);
const isControlMcpServerError = Schema.is(OrchestrationControlMcpServerError);

/**
 * The code for a failed `controlMcpServerAuth` request, or for a failed
 * Check connection (controlMcpServer reconnect) on a claude.ai connector.
 */
export function mcpSignInErrorCode(error: unknown): McpSignInErrorCode {
  if (isMcpServerAuthError(error)) return error.reason;
  if (isControlMcpServerError(error)) {
    return error.reason === "request-failed" ? "not-authorized" : error.reason;
  }
  return "request-failed";
}

/** The fixed text for a failed sign-in or, with `sign-out`, a failed Sign out. */
export function mcpSignInErrorText(
  code: McpSignInErrorCode,
  action: "sign-in" | "sign-out" = "sign-in",
): string {
  return code === "not-authorized"
    ? "Not authorized yet. Finish on claude.ai, then check the connection again."
    : mcpServerAuthErrorMessage(code, action);
}

/** The texts both clients show for a sign-in. */
export const MCP_SIGN_IN_TEXT = {
  openPage: "Open sign-in page",
  openClaudeAi: "Open claude.ai",
  waiting: "Waiting for you to approve in your browser…",
  claudeAiWaiting: "Authorize it on claude.ai, then check the connection.",
  checkConnection: "Check connection",
  pastePrompt:
    "If the redirect page shows a connection error, paste the address from your browser's address bar:",
  pasteInvalid: "Paste the full address, including the code.",
  finish: "Finish sign-in",
  finishing: "Finishing sign-in…",
  cancel: "Cancel",
} as const;

/** The line a sign-in shows and announces (aria-live) for its state; null when idle or starting. */
export function mcpSignInMessage(state: McpSignInState, label: string): string | null {
  switch (state.phase) {
    case "idle":
    case "starting":
      return null;
    case "waiting":
      if (state.error !== null) return mcpSignInErrorText(state.error);
      if (state.openUrl === null) return MCP_SIGN_IN_TEXT.finishing;
      return state.callbackExpected ? MCP_SIGN_IN_TEXT.waiting : MCP_SIGN_IN_TEXT.claudeAiWaiting;
    case "finishing":
      return MCP_SIGN_IN_TEXT.finishing;
    case "done":
      return `Signed in to ${label}.`;
    case "failed":
      return mcpSignInErrorText(state.code);
  }
}

/**
 * Null when a pasted address can finish the sign-in: a URL with a `code` or
 * `error` parameter, under the length cap. Else the text to show by the field.
 * Send it trimmed, then clear the field.
 */
export function mcpSignInPasteError(pasted: string): string | null {
  const text = pasted.trim();
  if (text === "" || text.length > MCP_SERVER_AUTH_URL_MAX_LENGTH) {
    return MCP_SIGN_IN_TEXT.pasteInvalid;
  }
  try {
    const { searchParams } = new URL(text);
    return searchParams.has("code") || searchParams.has("error")
      ? null
      : MCP_SIGN_IN_TEXT.pasteInvalid;
  } catch {
    return MCP_SIGN_IN_TEXT.pasteInvalid;
  }
}

/**
 * The Sign out confirmation and its result. Claude Code keeps one sign-in
 * per server on the computer that runs T3 Code, shared by every session there.
 */
export function mcpSignOutText(label: string) {
  return {
    title: `Sign out of ${label}?`,
    description:
      "This removes the server's sign-in from Claude Code on the computer that runs T3 Code, for every session there, terminal ones included. Sign in again to reconnect.",
    confirm: "Sign out",
    done: `Signed out of ${label}.`,
  } as const;
}
