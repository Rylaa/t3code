import {
  OrchestrationControlMcpServerError,
  OrchestrationMcpServerAuthError,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MCP_SIGN_IN_IDLE,
  MCP_SIGN_IN_TIMEOUT_MS,
  type McpSignInEvent,
  type McpSignInState,
  mcpSignInErrorCode,
  mcpSignInMessage,
  mcpSignInPasteError,
  mcpSignInPolling,
  mcpSignInReducer,
} from "./mcpSignIn.ts";

const run = (events: ReadonlyArray<McpSignInEvent>, from: McpSignInState = MCP_SIGN_IN_IDLE) =>
  events.reduce(mcpSignInReducer, from);

const PAGE = "https://auth.example/authorize?client_id=c&state=state-secret";
const waiting = run([
  { type: "start", server: "linear" },
  { type: "started", result: { authUrl: PAGE, callbackExpected: true }, now: 1_000 },
]);

describe("mcpSignInReducer", () => {
  it("waits on the page's host, then finishes once the server reads as connected", () => {
    expect(waiting).toEqual({
      phase: "waiting",
      server: "linear",
      authUrlHost: "auth.example",
      openUrl: PAGE,
      startedAt: 1_000,
      callbackExpected: true,
      error: null,
    });
    expect(mcpSignInMessage(waiting, "Linear")).toBe("Waiting for you to approve in your browser…");
    expect(mcpSignInPolling(waiting)).toBe(true);
    // A status read just after the code went in can still show the old status.
    const finishing = run(
      [
        { type: "submit", now: 5_000 },
        { type: "status", status: "needs-auth", now: 8_000 },
        { type: "status", status: "failed", now: 11_000 },
      ],
      waiting,
    );
    expect(finishing).toMatchObject({ phase: "finishing", startedAt: 5_000 });
    expect(mcpSignInMessage(finishing, "Linear")).toBe("Finishing sign-in…");
    const done = mcpSignInReducer(finishing, { type: "status", status: "connected", now: 14_000 });
    expect(done).toEqual({ phase: "done", server: "linear" });
    expect(mcpSignInMessage(done, "Linear")).toBe("Signed in to Linear.");
    expect(mcpSignInPolling(done)).toBe(false);
  });

  it("finishes by itself when the browser's redirect reaches the provider", () => {
    expect(mcpSignInReducer(waiting, { type: "status", status: "connected", now: 4_000 })).toEqual({
      phase: "done",
      server: "linear",
    });
  });

  it("keeps waiting after a refused paste, and fails on anything else", () => {
    const pasted = mcpSignInReducer(waiting, { type: "submit", now: 2_000 });
    const mismatch = mcpSignInReducer(pasted, { type: "failed", code: "state-mismatch" });
    expect(mismatch).toMatchObject({ phase: "waiting", error: "state-mismatch" });
    expect(mcpSignInMessage(mismatch, "Linear")).toBe(
      "That address belongs to a different sign-in. Paste the address from the page this sign-in opened.",
    );
    // Pasting again clears the notice.
    expect(mcpSignInReducer(mismatch, { type: "submit", now: 3_000 })).toMatchObject({
      phase: "finishing",
      error: null,
    });
    expect(
      run(
        [
          { type: "submit", now: 2_000 },
          { type: "failed", code: "flow-expired" },
        ],
        waiting,
      ),
    ).toEqual({ phase: "failed", server: "linear", code: "flow-expired" });
  });

  it("expires five minutes after the wait began", () => {
    const at = (now: number, from: McpSignInState = waiting) =>
      mcpSignInReducer(from, { type: "status", status: "needs-auth", now });
    expect(at(1_000 + MCP_SIGN_IN_TIMEOUT_MS - 1)).toBe(waiting);
    const expired = at(1_000 + MCP_SIGN_IN_TIMEOUT_MS);
    expect(expired).toEqual({ phase: "failed", server: "linear", code: "flow-expired" });
    expect(mcpSignInMessage(expired, "Linear")).toBe("This sign-in expired. Start it again.");
    // Once the code is in, a server that never connects failed to sign in.
    const finishing = mcpSignInReducer(waiting, { type: "submit", now: 60_000 });
    expect(at(60_000 + MCP_SIGN_IN_TIMEOUT_MS, finishing)).toEqual({
      phase: "failed",
      server: "linear",
      code: "request-failed",
    });
  });

  it("starts fresh on Sign in again, but not while a request is in flight", () => {
    expect(mcpSignInReducer(waiting, { type: "start", server: "notion" })).toEqual({
      phase: "starting",
      server: "notion",
    });
    const starting = run([{ type: "start", server: "linear" }]);
    expect(mcpSignInReducer(starting, { type: "start", server: "notion" })).toBe(starting);
    const finishing = mcpSignInReducer(waiting, { type: "submit", now: 2_000 });
    expect(mcpSignInReducer(finishing, { type: "start", server: "linear" })).toBe(finishing);
    expect(mcpSignInReducer(finishing, { type: "cancel" })).toEqual(MCP_SIGN_IN_IDLE);
  });

  it("waits on claude.ai for a connector, and keeps waiting while it is not authorized", () => {
    const connector = run([
      { type: "start", server: "claude.ai Notion" },
      {
        type: "started",
        result: { authUrl: "https://claude.ai/api/mcp/start-auth/s", callbackExpected: false },
        now: 0,
      },
    ]);
    expect(connector).toMatchObject({ authUrlHost: "claude.ai", callbackExpected: false });
    expect(mcpSignInMessage(connector, "Notion")).toBe(
      "Authorize it on claude.ai, then check the connection.",
    );
    // No redirect comes back, so there is nothing to paste.
    expect(mcpSignInReducer(connector, { type: "submit", now: 1 })).toBe(connector);
    const notYet = mcpSignInReducer(connector, { type: "failed", code: "not-authorized" });
    expect(mcpSignInMessage(notYet, "Notion")).toBe(
      "Not authorized yet. Finish on claude.ai, then check the connection again.",
    );
    // Nothing expires on claude.ai, and only Check connection changes the status: no polling.
    expect(mcpSignInPolling(connector)).toBe(false);
    expect(
      mcpSignInReducer(connector, {
        type: "status",
        status: "needs-auth",
        now: 10 * MCP_SIGN_IN_TIMEOUT_MS,
      }),
    ).toBe(connector);
    expect(mcpSignInReducer(connector, { type: "status", status: "connected", now: 1 })).toEqual({
      phase: "done",
      server: "claude.ai Notion",
    });
  });

  it("ends a failed sign-in signed in once Check connection connects the server", () => {
    const failed = run([
      { type: "start", server: "linear" },
      { type: "failed", code: "provider-unsupported" },
    ]);
    // Still not signed in after a terminal sign-in: the failure and its fallback stay.
    expect(mcpSignInReducer(failed, { type: "failed", code: "not-authorized" })).toBe(failed);
    expect(mcpSignInReducer(failed, { type: "status", status: "needs-auth", now: 1 })).toBe(failed);
    expect(mcpSignInReducer(failed, { type: "status", status: "connected", now: 1 })).toEqual({
      phase: "done",
      server: "linear",
    });
  });

  it("says why Check connection was refused, and keeps the text when it is still not authorized", () => {
    const failed = run([
      { type: "start", server: "linear" },
      { type: "failed", code: "provider-unsupported" },
    ]);
    expect(mcpSignInReducer(failed, { type: "failed", code: "run-active" })).toEqual({
      phase: "failed",
      server: "linear",
      code: "run-active",
    });
  });

  it("refuses a sign-in page that is not http(s), and fails the start with its reason", () => {
    for (const authUrl of ["javascript:alert(1)", "data:text/html,x", "not a url"]) {
      expect(
        run([
          { type: "start", server: "linear" },
          { type: "started", result: { authUrl, callbackExpected: true }, now: 0 },
        ]),
      ).toEqual({ phase: "failed", server: "linear", code: "request-failed" });
    }
    const unsupported = run([
      { type: "start", server: "linear" },
      { type: "failed", code: "provider-unsupported" },
    ]);
    expect(mcpSignInMessage(unsupported, "Linear")).toBe(
      "This provider can't sign in to MCP servers from T3 Code.",
    );
  });

  it("waits without a page when no approval is needed", () => {
    const ready = run([
      { type: "start", server: "linear" },
      { type: "started", result: { callbackExpected: false }, now: 0 },
    ]);
    expect(ready).toMatchObject({ phase: "waiting", openUrl: null, authUrlHost: null });
    expect(mcpSignInMessage(ready, "Linear")).toBe("Finishing sign-in…");
  });
});

describe("mcpSignInPasteError", () => {
  it("accepts a redirect address with a code or an error, and nothing else", () => {
    expect(mcpSignInPasteError(" http://localhost:51234/callback?code=c&state=s ")).toBeNull();
    expect(mcpSignInPasteError("http://localhost:51234/callback?error=access_denied")).toBeNull();
    for (const pasted of [
      "",
      "c0de",
      "http://localhost:51234/callback?state=s",
      `http://localhost/callback?code=${"c".repeat(20_000)}`,
    ]) {
      expect(mcpSignInPasteError(pasted)).toBe("Paste the full address, including the code.");
    }
  });
});

describe("mcpSignInErrorCode", () => {
  const threadId = ThreadId.make("thread-mcp");

  it("reads a sign-in error's reason, and a failed claude.ai check as not authorized", () => {
    expect(
      mcpSignInErrorCode(
        new OrchestrationMcpServerAuthError({
          threadId,
          server: "linear",
          action: "finish-sign-in",
          reason: "missing-code",
        }),
      ),
    ).toBe("missing-code");
    const check = (reason: OrchestrationControlMcpServerError["reason"]) =>
      mcpSignInErrorCode(new OrchestrationControlMcpServerError({ threadId, server: "n", reason }));
    expect(check("request-failed")).toBe("not-authorized");
    expect(check("run-active")).toBe("run-active");
    expect(mcpSignInErrorCode(new Error("socket closed"))).toBe("request-failed");
  });
});
