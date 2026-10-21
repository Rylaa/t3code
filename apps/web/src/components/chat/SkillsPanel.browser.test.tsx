import {
  EnvironmentId,
  OrchestrationControlMcpServerError,
  OrchestrationMcpServerAuthError,
  ThreadId,
} from "@t3tools/contracts";
import { MCP_SIGN_IN_TIMEOUT_MS } from "@t3tools/client-runtime/state/mcp-sign-in";
import * as Cause from "effect/Cause";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { act, fakeTimers, render, stubGlobal, type Screen } from "../../../test/render";

const threadId = ThreadId.make("thread-1");

// The live MCP servers of a Claude session this thread used `sentry` from. Each
// request waits in `requests` until the test settles it.
const state = vi.hoisted(() => ({
  servers: [] as ReadonlyArray<Record<string, unknown>>,
  signInCapable: true,
  requests: [] as Array<{
    readonly command: string;
    readonly input: Record<string, unknown>;
    readonly settle: (result: unknown) => void;
  }>,
  refreshes: 0,
}));

vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({
    projectId: "project-1",
    providerInstanceId: "claude",
    runtime: { providerInstanceId: "claude", activeRunId: null },
    worktreePath: null,
    latestRun: null,
    activeProviderThreadId: null,
    forkedFrom: null,
  }),
  useServerConfigs: () => ({
    get: () => ({
      environment: {
        capabilities: { threadMcpControl: true, threadMcpSignIn: state.signInCapable },
      },
    }),
  }),
  useProject: () => null,
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentProviders: () => ({
    get: () => [{ instanceId: "claude", driver: "claudeAgent", skills: [], slashCommands: [] }],
  }),
}));
vi.mock("../../state/query", async () => {
  const { ThreadId, TurnItemId } = await import("@t3tools/contracts");
  const DateTime = await import("effect/DateTime");
  // New data only when the servers change, like a query that read the same result again.
  let cached: { readonly servers: unknown; readonly data: unknown } | null = null;
  const read = () => {
    if (cached?.servers === state.servers) return cached.data;
    const data = {
      used: [
        {
          kind: "mcp",
          name: "sentry",
          plugin: null,
          count: 1,
          lastUsedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 11)),
          lastItem: { threadId: ThreadId.make("thread-1"), itemId: TurnItemId.make("item-1") },
        },
      ],
      inventoryStatus: "available",
      inventory: { skills: [], plugins: [], agents: [], mcpServers: state.servers },
      mcpServersLive: true,
    };
    cached = { servers: state.servers, data };
    return data;
  };
  return {
    useEnvironmentQuery: () => ({
      data: read(),
      error: null,
      isPending: false,
      refresh: () => {
        state.refreshes += 1;
      },
    }),
  };
});
vi.mock("../../state/orchestration", async () => {
  const { Atom } = await import("effect/reactivity");
  const permitted = Atom.make(true);
  return {
    orchestrationEnvironment: {
      threadExtensions: () => null,
      controlMcpServer: { tag: "reconnect", permissionAtom: () => permitted },
      controlMcpServerAuth: { tag: "auth", permissionAtom: () => permitted },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (command: { readonly tag: string }) =>
    ({ input }: { readonly input: Record<string, unknown> }) =>
      new Promise((settle) => {
        state.requests.push({ command: command.tag, input, settle });
      }),
}));

import { SkillsPanel } from "./SkillsPanel";

// The mocked modules read `state`, so every test starts by resetting it. Tests change it
// before their first render, so rendering is left to them.
function setup() {
  state.servers = [{ name: "sentry", status: "failed", error: "boom" }];
  state.signInCapable = true;
  state.requests = [];
  state.refreshes = 0;
  const stack = new AsyncDisposableStack();
  const container = document.createElement("div");
  let screen: Screen | undefined;
  return {
    container,
    async renderPanel(props: Partial<ComponentProps<typeof SkillsPanel>> = {}) {
      const ui = (
        <AppAtomRegistryProvider>
          <SkillsPanel
            threadRef={{ environmentId: EnvironmentId.make("env-1"), threadId }}
            {...props}
          />
        </AppAtomRegistryProvider>
      );
      if (screen) return screen.rerender(ui);
      screen = stack.use(await render(ui, { container }));
      stack.use(fakeTimers());
    },
    button: (text: string) =>
      [...container.querySelectorAll("button")].find((element) =>
        element.textContent?.startsWith(text),
      ),
    reconnectButton: () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Reconnect sentry"]'),
    liveRegions: () => [...container.querySelectorAll('[aria-live="polite"]')],
    stubGlobal: (name: string, value: unknown) => stack.use(stubGlobal(name, value)),
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

async function click(element: Element | null | undefined) {
  expect(element).toBeInstanceOf(HTMLElement);
  await act(() => (element as HTMLElement).click());
  await act(() => vi.advanceTimersByTimeAsync(0));
}

const labelled = (label: string) =>
  document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

async function settleRequest(index: number, result: unknown) {
  await act(async () => state.requests[index]!.settle(result));
}

const authFailure = (reason: OrchestrationMcpServerAuthError["reason"]) => ({
  _tag: "Failure",
  cause: Cause.fail(
    new OrchestrationMcpServerAuthError({ reason, action: "sign-in", threadId, server: "sentry" }),
  ),
});

async function type(input: HTMLInputElement | null, value: string) {
  expect(input).toBeInstanceOf(HTMLInputElement);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(() => {
    setValue.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("keeps a Reconnect's result and its in-flight state while the MCP list is collapsed", async () => {
  await using test = setup();
  const { container, renderPanel, button, reconnectButton } = test;
  await renderPanel();
  const liveRegion = container.querySelector('[aria-live="polite"]');
  expect(liveRegion?.textContent).toBe("");

  await click(button("sentry"));
  await click(reconnectButton());
  expect(state.requests).toHaveLength(1);
  expect(liveRegion?.textContent).toBe("Reconnecting sentry…");

  // Collapsing the section unmounts every MCP row while the request is in flight.
  await click(button("MCP servers"));
  expect(reconnectButton()).toBeNull();

  // Back open, the row still knows its request is pending, so it can't send a second one.
  await click(button("MCP servers"));
  await click(button("sentry"));
  expect(reconnectButton()?.disabled).toBe(true);
  expect(reconnectButton()?.textContent).toBe("Reconnecting…");

  await click(button("MCP servers"));
  await settleRequest(0, { _tag: "Success", value: undefined });

  expect(liveRegion?.isConnected).toBe(true);
  expect(liveRegion?.textContent).toBe("Reconnected sentry.");
  expect(state.requests).toHaveLength(1);
});

it("searches an empty dialog section: counts its matches and offers the section that has some", async () => {
  await using test = setup();
  const { container, renderPanel, button } = test;
  const onShowSection = vi.fn();
  const render = (query: string) => renderPanel({ section: "plugins", query, onShowSection });
  await render("");
  const status = container.querySelector('[role="status"]');
  expect(status?.textContent).toBe("");
  expect(container.textContent).toContain("No plugins");

  await render("sentry");
  // The same status element, so a screen reader announces the count.
  expect(status?.isConnected).toBe(true);
  expect(status?.textContent).toBe("Showing 0 of 0 plugins");
  await click(button("Show MCP servers"));
  expect(onShowSection).toHaveBeenCalledWith("mcpServers");
});

const SIGN_IN_PAGE = "https://auth.example.com/authorize?client_id=t3&state=state-secret";

it("signs in from a pasted address without ever showing the page's or the pasted address", async () => {
  await using test = setup();
  const { container, renderPanel, button, reconnectButton, liveRegions, stubGlobal } = test;
  state.servers = [{ name: "sentry", status: "needs-auth", signIn: "oauth" }];
  const open = vi.fn();
  stubGlobal("open", open);
  await renderPanel();
  await click(button("sentry"));
  // Like Claude Code's /mcp: Sign in instead of a Reconnect that can only fail.
  expect(reconnectButton()).toBeNull();

  await click(labelled("Sign in to sentry"));
  expect(state.requests.map((request) => request.input)).toEqual([
    { threadId, server: "sentry", action: "sign-in" },
  ]);
  await settleRequest(0, {
    _tag: "Success",
    value: { authUrl: SIGN_IN_PAGE, callbackExpected: true },
  });
  expect(container.textContent).toContain("Waiting for you to approve in your browser…");
  expect(container.textContent).toContain("auth.example.com");
  expect(container.textContent).not.toContain("state-secret");

  await click(button("Open sign-in page"));
  expect(open).toHaveBeenCalledWith(SIGN_IN_PAGE, "_blank", "noopener,noreferrer");

  const field = container.querySelector<HTMLInputElement>('input[type="password"]');
  await type(field, "http://localhost:4567/callback");
  await click(button("Finish sign-in"));
  expect(container.textContent).toContain("Paste the full address, including the code.");
  expect(state.requests).toHaveLength(1);

  // An address from another sign-in leaves this one waiting, with the field emptied.
  await type(field, "http://localhost:4567/callback?code=old-code-secret&state=old-secret");
  await click(button("Finish sign-in"));
  expect(container.textContent).toContain("Finishing sign-in…");
  await settleRequest(1, authFailure("state-mismatch"));
  expect(container.textContent).toContain("That address belongs to a different sign-in.");
  const emptied = container.querySelector<HTMLInputElement>('input[type="password"]');
  expect(emptied?.value).toBe("");

  await type(
    emptied,
    "  http://localhost:4567/callback?code=oauth-code-secret&state=state-secret ",
  );
  await click(button("Finish sign-in"));
  expect(state.requests[2]?.input).toEqual({
    threadId,
    server: "sentry",
    action: "finish-sign-in",
    callbackUrl: "http://localhost:4567/callback?code=oauth-code-secret&state=state-secret",
  });
  await settleRequest(2, { _tag: "Success", value: { callbackExpected: false } });
  expect(container.textContent).toContain("Finishing sign-in…");
  state.servers = [{ name: "sentry", status: "connected", signIn: "oauth" }];
  await renderPanel();
  expect(liveRegions().map((region) => region.textContent)).toContain("Signed in to sentry.");
  expect(document.body.textContent).not.toContain("secret");
});

it("keeps a waiting sign-in while its section is collapsed, then expires it after five minutes", async () => {
  await using test = setup();
  const { container, renderPanel, button } = test;
  state.servers = [{ name: "sentry", status: "needs-auth", signIn: "oauth" }];
  await renderPanel();
  await click(button("sentry"));
  await click(labelled("Sign in to sentry"));
  await settleRequest(0, {
    _tag: "Success",
    value: { authUrl: SIGN_IN_PAGE, callbackExpected: true },
  });

  await click(button("MCP servers"));
  expect(container.textContent).not.toContain("auth.example.com");
  // The row opens on its own when it comes back.
  await click(button("MCP servers"));
  expect(container.textContent).toContain("auth.example.com");

  // While it waits, the panel reads the live status again; nothing marks the server connected.
  await act(() => vi.advanceTimersByTimeAsync(MCP_SIGN_IN_TIMEOUT_MS));
  expect(state.refreshes).toBeGreaterThan(0);
  expect(container.textContent).toContain("This sign-in expired. Start it again.");
  expect(container.textContent).toContain(
    "Sign in on the computer that runs T3 Code: claude mcp login sentry --no-browser, then check the connection.",
  );
  expect(container.textContent).not.toContain("auth.example.com");

  // Expired, it stops reading.
  const refreshes = state.refreshes;
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(state.refreshes).toBe(refreshes);
});

it("drops the answer of a sign-in that was cancelled and started again", async () => {
  await using test = setup();
  const { container, renderPanel, button } = test;
  state.servers = [{ name: "sentry", status: "needs-auth", signIn: "oauth" }];
  const signInPage = { _tag: "Success", value: { authUrl: SIGN_IN_PAGE, callbackExpected: true } };
  await renderPanel();
  await click(button("sentry"));
  await click(labelled("Sign in to sentry"));
  await settleRequest(0, signInPage);
  await type(
    container.querySelector<HTMLInputElement>('input[type="password"]'),
    "http://localhost:4567/callback?code=first",
  );
  await click(button("Finish sign-in"));
  await click(button("Cancel"));
  await click(labelled("Sign in to sentry"));

  // The first sign-in's answer arrives after the second one started.
  await settleRequest(1, authFailure("state-mismatch"));
  await settleRequest(2, signInPage);
  expect(container.textContent).toContain("Waiting for you to approve in your browser…");
  expect(container.textContent).not.toContain("different sign-in");
});

it("shows a failed sign-in's text with the terminal command, and only the command without sign-in", async () => {
  await using test = setup();
  const { container, renderPanel, button, reconnectButton } = test;
  state.servers = [{ name: "sentry", status: "needs-auth", signIn: "oauth" }];
  await renderPanel();
  await click(button("sentry"));
  await click(labelled("Sign in to sentry"));
  await settleRequest(0, authFailure("provider-unsupported"));
  expect(container.textContent).toContain(
    "This provider can't sign in to MCP servers from T3 Code.",
  );
  expect(container.textContent).toContain("claude mcp login sentry --no-browser");

  // An older server can't sign in: the command, and Reconnect to pick up a terminal sign-in.
  state.signInCapable = false;
  await renderPanel();
  expect(labelled("Sign in to sentry")).toBeNull();
  expect(reconnectButton()).not.toBeNull();
  const row = container.querySelector("li");
  expect(row?.textContent).toContain("claude mcp login sentry --no-browser");
  expect(row?.textContent).not.toContain("This provider can't sign in");
});

it("checks the connection after a failed sign-in, which ends signed in once it connects", async () => {
  await using test = setup();
  const { container, renderPanel, button, liveRegions } = test;
  state.servers = [{ name: "sentry", status: "needs-auth", signIn: "oauth" }];
  const fallback =
    "Sign in on the computer that runs T3 Code: claude mcp login sentry --no-browser, then check the connection.";
  await renderPanel();
  await click(button("sentry"));
  await click(labelled("Sign in to sentry"));
  await settleRequest(0, authFailure("flow-expired"));
  expect(container.textContent).toContain(fallback);

  // Not signed in from the terminal yet: the failure and its fallback stay.
  await click(button("Check connection"));
  expect(state.requests[1]).toMatchObject({
    command: "reconnect",
    input: { server: "sentry", action: "reconnect" },
  });
  await settleRequest(1, {
    _tag: "Failure",
    cause: Cause.fail(
      new OrchestrationControlMcpServerError({
        reason: "request-failed",
        threadId,
        server: "sentry",
      }),
    ),
  });
  expect(container.textContent).toContain("This sign-in expired. Start it again.");
  expect(container.textContent).toContain(fallback);
  expect(labelled("Sign in to sentry")?.disabled).toBe(false);

  await click(button("Check connection"));
  await settleRequest(2, { _tag: "Success", value: undefined });
  expect(liveRegions().map((region) => region.textContent)).toContain("Signed in to sentry.");
  expect(container.textContent).not.toContain(fallback);
});

it("cancels a sign-in whose request is still out, drops its answer and focuses Sign in", async () => {
  await using test = setup();
  const { container, renderPanel, button } = test;
  state.servers = [{ name: "sentry", status: "needs-auth", signIn: "oauth" }];
  await renderPanel();
  await click(button("sentry"));
  await click(labelled("Sign in to sentry"));
  expect(labelled("Sign in to sentry")?.disabled).toBe(true);

  const cancel = button("Cancel")!;
  cancel.focus();
  await click(cancel);
  expect(labelled("Sign in to sentry")?.disabled).toBe(false);
  expect(document.activeElement).toBe(labelled("Sign in to sentry"));

  await settleRequest(0, {
    _tag: "Success",
    value: { authUrl: SIGN_IN_PAGE, callbackExpected: true },
  });
  expect(container.textContent).not.toContain("auth.example.com");
  expect(button("Cancel")).toBeUndefined();
});

it("keeps focus in the paste form while finishing, and leaves the field's keys to it", async () => {
  await using test = setup();
  const { container, renderPanel, button } = test;
  state.servers = [{ name: "sentry", status: "needs-auth", signIn: "oauth" }];
  await renderPanel();
  await click(button("sentry"));
  await click(labelled("Sign in to sentry"));
  await settleRequest(0, {
    _tag: "Success",
    value: { authUrl: SIGN_IN_PAGE, callbackExpected: true },
  });
  const field = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const press = async (element: HTMLElement, key: string) => {
    element.focus();
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(() => element.dispatchEvent(event));
    return event.defaultPrevented;
  };
  // In the field these keys move the caret; from a row they still move between rows.
  for (const key of ["Home", "End", "ArrowUp", "ArrowDown"]) {
    expect(await press(field, key)).toBe(false);
    expect(document.activeElement).toBe(field);
  }
  const row = button("sentry")!;
  expect(await press(row, "ArrowUp")).toBe(true);
  expect(document.activeElement).not.toBe(row);
  expect(document.activeElement?.matches("[data-nav-item]")).toBe(true);

  await type(field, "http://localhost:4567/callback?code=c&state=s");
  const finish = button("Finish sign-in")!;
  finish.focus();
  await click(finish);
  expect(container.textContent).toContain("Finishing sign-in…");
  expect(field.readOnly).toBe(true);
  expect(finish.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(finish);

  await settleRequest(1, authFailure("state-mismatch"));
  expect(field.readOnly).toBe(false);
  expect(document.activeElement).toBe(field);

  await click(button("Cancel"));
  expect(document.activeElement).toBe(labelled("Sign in to sentry"));
});

it("authorizes a claude.ai connector there and checks its connection", async () => {
  await using test = setup();
  const { container, renderPanel, button } = test;
  state.servers = [
    { name: "claude.ai Linear", status: "needs-auth", signIn: "claude-ai", source: "claudeai" },
  ];
  await renderPanel();
  await click(button("Linear"));
  // The accessible name starts with the visible label, so voice control finds it.
  await click(labelled("Authorize on claude.ai for Linear"));
  await settleRequest(0, {
    _tag: "Success",
    value: { authUrl: "https://claude.ai/settings/connectors", callbackExpected: false },
  });
  expect(container.textContent).toContain("Authorize it on claude.ai, then check the connection.");
  expect(container.querySelector('input[type="password"]')).toBeNull();

  await click(button("Check connection"));
  expect(state.requests[1]).toMatchObject({
    command: "reconnect",
    input: { server: "claude.ai Linear", action: "reconnect" },
  });
  await settleRequest(1, {
    _tag: "Failure",
    cause: Cause.fail(
      new OrchestrationControlMcpServerError({
        reason: "request-failed",
        threadId,
        server: "claude.ai Linear",
      }),
    ),
  });
  // Still waiting, so the user can finish on claude.ai and check again.
  expect(container.textContent).toContain("Not authorized yet.");
  expect(button("Check connection")).toBeDefined();
});

it("asks before signing out, then announces it", async () => {
  await using test = setup();
  const { renderPanel, button, liveRegions } = test;
  state.servers = [{ name: "sentry", status: "connected", signIn: "oauth" }];
  await renderPanel();
  await click(button("sentry"));

  const confirmButton = () =>
    [...document.querySelectorAll('[data-slot="alert-dialog-popup"] button')].find(
      (element) => element.textContent === "Sign out",
    );
  await click(labelled("Sign out of sentry"));
  expect(document.body.textContent).toContain("Sign out of sentry?");
  await click(
    [...document.querySelectorAll('[data-slot="alert-dialog-popup"] button')].find(
      (element) => element.textContent === "Cancel",
    ),
  );
  // The closing dialog keeps its content until its exit animation ends.
  await vi.waitFor(() => expect(confirmButton()).toBeUndefined());
  expect(state.requests).toHaveLength(0);

  await click(labelled("Sign out of sentry"));
  await click(confirmButton());
  expect(state.requests.map((request) => request.input)).toEqual([
    { threadId, server: "sentry", action: "sign-out" },
  ]);
  await settleRequest(0, { _tag: "Success", value: { callbackExpected: false } });
  expect(liveRegions().map((region) => region.textContent)).toContain("Signed out of sentry.");
});
