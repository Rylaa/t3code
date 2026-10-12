import {
  MCP_SIGN_IN_IDLE,
  mcpSignInReducer,
  type McpSignInEvent,
} from "@t3tools/client-runtime/state/mcp-sign-in";
import {
  mcpServerRows,
  type ThreadExtensionRow,
} from "@t3tools/client-runtime/state/thread-extensions";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  mcpSignInPasteAnnouncement,
  mcpSignInRowView,
  threadExtensionMetaLabel,
} from "./thread-extensions-presentation";

const now = Date.UTC(2026, 9, 11, 12, 0, 0);

describe("threadExtensionMetaLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts uses and says how long ago the last one was", () => {
    expect(
      threadExtensionMetaLabel({ count: 3, lastUsedAt: DateTime.makeUnsafe(now - 5 * 60_000) }),
    ).toBe("3 uses · 5m ago");
    expect(
      threadExtensionMetaLabel({ count: 1, lastUsedAt: DateTime.makeUnsafe(now - 20_000) }),
    ).toBe("1 use · just now");
    expect(threadExtensionMetaLabel({ count: 2, lastUsedAt: null })).toBe("2 uses");
  });

  it("says nothing for something never used", () => {
    expect(threadExtensionMetaLabel({ count: 0, lastUsedAt: null })).toBeNull();
  });
});

describe("mcpSignInRowView", () => {
  const server = (name: string, overrides: Partial<ThreadExtensionRow>): ThreadExtensionRow => ({
    name,
    plugin: null,
    count: 0,
    lastUsedAt: null,
    lastItem: null,
    ...overrides,
  });
  const [linear, gmail, local] = mcpServerRows(
    {
      used: [],
      unused: [
        server("linear", { status: "needs-auth", signIn: "oauth" }),
        server("claude.ai Gmail", {
          status: "needs-auth",
          signIn: "claude-ai",
          source: "claudeai",
        }),
        server("files", { status: "connected" }),
      ],
    },
    {
      live: true,
      permitted: true,
      config: {
        environment: { capabilities: { threadMcpControl: true, threadMcpSignIn: true } },
        providers: [{ instanceId: "claude", driver: "claudeAgent" }],
      },
      shell: { providerInstanceId: "claude", runtime: null },
    },
  );
  const run = (...events: ReadonlyArray<McpSignInEvent>) =>
    events.reduce(mcpSignInReducer, MCP_SIGN_IN_IDLE);
  const started = (authUrl: string | undefined, callbackExpected: boolean): McpSignInEvent => ({
    type: "started",
    result: authUrl === undefined ? { callbackExpected } : { authUrl, callbackExpected },
    now,
  });

  it("drops a failed sign-in once its row no longer offers Sign in", () => {
    const failed = run(
      { type: "start", server: "files" },
      { type: "failed", code: "request-failed" },
    );
    expect(mcpSignInRowView(local!, failed)).toEqual({
      button: null,
      message: null,
      cancel: false,
      waiting: null,
      fallback: null,
    });
    // The row that still offers Sign in keeps the failure.
    const failedLinear = run(
      { type: "start", server: "linear" },
      { type: "failed", code: "request-failed" },
    );
    expect(mcpSignInRowView(linear!, failedLinear).message).not.toBeNull();
  });

  it("offers the row's sign-in only while no request is out", () => {
    expect(mcpSignInRowView(linear!, MCP_SIGN_IN_IDLE)).toEqual({
      button: { label: "Sign in", busy: false, disabled: false },
      message: null,
      cancel: false,
      waiting: null,
      fallback: null,
    });
    expect(mcpSignInRowView(gmail!, MCP_SIGN_IN_IDLE).button?.label).toBe("Authorize on claude.ai");
    expect(mcpSignInRowView(local!, MCP_SIGN_IN_IDLE).button).toBeNull();

    const starting = run({ type: "start", server: "linear" });
    // The request may never answer, so it can be cancelled.
    expect(mcpSignInRowView(linear!, starting)).toMatchObject({
      button: { label: "Signing in…", busy: true, disabled: true },
      cancel: true,
    });
    // One sign-in at a time: the other row waits, and shows nothing of this one.
    expect(mcpSignInRowView(gmail!, starting)).toEqual({
      button: { label: "Authorize on claude.ai", busy: false, disabled: true },
      message: null,
      cancel: false,
      waiting: null,
      fallback: null,
    });
  });

  it("shows only the sign-in page's host and always offers the paste field for a redirect", () => {
    const waiting = run(
      { type: "start", server: "linear" },
      started("https://auth.linear.app/authorize?state=secret-state&client_id=x", true),
    );
    const view = mcpSignInRowView(linear!, waiting);
    expect(view).toEqual({
      button: { label: "Sign in", busy: false, disabled: false },
      message: "Waiting for you to approve in your browser…",
      cancel: false,
      waiting: {
        host: "auth.linear.app",
        openLabel: "Open sign-in page",
        paste: true,
        checkConnection: false,
        finishing: false,
      },
      fallback: null,
    });
    expect(JSON.stringify(view)).not.toContain("secret-state");
    // Another row's sign-in replaces a waiting one.
    expect(mcpSignInRowView(gmail!, waiting).button?.disabled).toBe(false);

    const finishing = mcpSignInReducer(waiting, { type: "submit", now });
    expect(mcpSignInRowView(linear!, finishing)).toMatchObject({
      button: { disabled: true },
      message: "Finishing sign-in…",
      waiting: { paste: true, finishing: true },
    });

    const done = mcpSignInReducer(finishing, { type: "status", status: "connected", now });
    expect(mcpSignInRowView(linear!, done)).toMatchObject({
      message: "Signed in to linear.",
      waiting: null,
      fallback: null,
    });
  });

  it("checks the connection of a claude.ai connector instead of taking a paste", () => {
    const waiting = run(
      { type: "start", server: "claude.ai Gmail" },
      started("https://claude.ai/settings/connectors", false),
    );
    expect(mcpSignInRowView(gmail!, waiting)).toMatchObject({
      message: "Authorize it on claude.ai, then check the connection.",
      waiting: {
        host: "claude.ai",
        openLabel: "Open claude.ai",
        paste: false,
        checkConnection: true,
      },
    });
    const refused = mcpSignInReducer(waiting, { type: "failed", code: "not-authorized" });
    expect(mcpSignInRowView(gmail!, refused)).toMatchObject({
      message: "Not authorized yet. Finish on claude.ai, then check the connection again.",
      waiting: { checkConnection: true },
    });
  });

  it("opens nothing for a sign-in page that is not http(s), and points at the terminal", () => {
    for (const authUrl of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd"]) {
      const view = mcpSignInRowView(
        linear!,
        run({ type: "start", server: "linear" }, started(authUrl, true)),
      );
      expect(view.waiting).toBeNull();
      expect(view.message).toBe("Could not sign in to the MCP server.");
      expect(view.fallback).toBe(
        "Sign in on the computer that runs T3 Code: claude mcp login linear --no-browser, then check the connection.",
      );
    }
  });

  it("finishes by itself when no approval is needed", () => {
    const waiting = run({ type: "start", server: "linear" }, started(undefined, false));
    expect(mcpSignInRowView(linear!, waiting)).toMatchObject({
      message: "Finishing sign-in…",
      waiting: { host: null, openLabel: null, paste: false, checkConnection: false },
    });
  });
});

describe("mcpSignInPasteAnnouncement", () => {
  it("says a refused paste aloud on iOS only, where no live region reads it", () => {
    const refused = "Paste the full address, including the code.";
    expect(mcpSignInPasteAnnouncement(refused, "ios")).toBe(refused);
    expect(mcpSignInPasteAnnouncement(refused, "android")).toBeNull();
    expect(mcpSignInPasteAnnouncement(null, "ios")).toBeNull();
  });
});
