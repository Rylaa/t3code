/**
 * The Skills & plugins sheet's own wording on top of the shared view-models
 * in `@t3tools/client-runtime/state/thread-extensions`.
 */
import {
  MCP_SIGN_IN_TEXT,
  mcpSignInMessage,
  type McpSignInState,
} from "@t3tools/client-runtime/state/mcp-sign-in";
import {
  threadExtensionUsesLabel,
  type McpServerRowView,
  type ThreadExtensionRow,
} from "@t3tools/client-runtime/state/thread-extensions";
import * as DateTime from "effect/DateTime";

import { relativeTime } from "../../lib/time";

/** "5m ago", or "just now" under a minute. */
export function lastUsedAgo(lastUsedAt: DateTime.Utc): string {
  const elapsed = relativeTime(DateTime.formatIso(lastUsedAt));
  return elapsed === "<1m" ? "just now" : `${elapsed} ago`;
}

/** A row's meta: "3 uses · 5m ago", or null for something never used. */
export function threadExtensionMetaLabel(
  row: Pick<ThreadExtensionRow, "count" | "lastUsedAt">,
): string | null {
  const uses = threadExtensionUsesLabel(row.count);
  if (uses === null || row.lastUsedAt === null) return uses;
  return `${uses} · ${lastUsedAgo(row.lastUsedAt)}`;
}

/** What an MCP server row shows of the sheet's one sign-in. */
export interface McpSignInRowView {
  /** Sign in or Authorize on claude.ai; null when the row offers neither. */
  readonly button: {
    readonly label: string;
    readonly busy: boolean;
    readonly disabled: boolean;
  } | null;
  /** The row's sign-in in words, shown and announced; null when none is open for it. */
  readonly message: string | null;
  /** Cancel while the sign-in's first request is out, which may never answer; `waiting` has its own. */
  readonly cancel: boolean;
  /** While the sign-in waits on the user. */
  readonly waiting: {
    /** The sign-in page's host: its full address carries the sign-in's state and is never shown. */
    readonly host: string | null;
    /** The open button's label; null when there is no page to open. */
    readonly openLabel: string | null;
    /**
     * The paste field and Finish sign-in, whenever the provider waits for the
     * redirect: a phone's browser never reaches the provider's loopback on the
     * computer that runs T3 Code, so pasting is how a sign-in finishes here.
     */
    readonly paste: boolean;
    /** Check connection: a claude.ai connector is authorized on claude.ai. */
    readonly checkConnection: boolean;
    /** The pasted address is with the provider. */
    readonly finishing: boolean;
  } | null;
  /** How to sign in outside T3 Code, under a failed attempt. */
  readonly fallback: string | null;
}

/** A row's part in the sign-in `state`, which is the sheet's only one. */
export function mcpSignInRowView(view: McpServerRowView, state: McpSignInState): McpSignInRowView {
  const own = state.phase !== "idle" && state.server === view.row.name;
  const starting = own && state.phase === "starting";
  const button =
    view.signIn === null
      ? null
      : {
          label: starting ? "Signing in…" : view.signIn.label,
          busy: starting,
          // A new sign-in replaces a waiting one, but not one with a request out.
          disabled: state.phase === "starting" || state.phase === "finishing",
        };
  // A failed attempt on a row that no longer offers Sign in is stale (web hides it too).
  if (!own || (state.phase === "failed" && view.signIn === null)) {
    return { button, message: null, cancel: false, waiting: null, fallback: null };
  }
  return {
    button,
    message: mcpSignInMessage(state, view.label),
    cancel: starting,
    waiting:
      state.phase === "waiting" || state.phase === "finishing"
        ? {
            host: state.authUrlHost,
            openLabel:
              state.openUrl === null
                ? null
                : state.callbackExpected
                  ? MCP_SIGN_IN_TEXT.openPage
                  : MCP_SIGN_IN_TEXT.openClaudeAi,
            paste: state.callbackExpected,
            checkConnection: !state.callbackExpected && state.openUrl !== null,
            finishing: state.phase === "finishing",
          }
        : null,
    fallback: state.phase === "failed" ? (view.signIn?.fallback ?? null) : null,
  };
}

/**
 * What to say aloud when Finish sign-in refuses a paste (`mcpSignInPasteError`),
 * on `Platform.OS`: Android reads the error's live region, iOS has none.
 */
export function mcpSignInPasteAnnouncement(error: string | null, os: string): string | null {
  return os === "ios" ? error : null;
}
