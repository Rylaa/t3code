// @vitest-environment jsdom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

const threadId = ThreadId.make("thread-1");

// One failed MCP server this thread used, with a live status Claude can reconnect.
const state = vi.hoisted(() => ({
  settleReconnect: null as ((result: unknown) => void) | null,
  reconnects: 0,
  refresh: () => undefined,
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
      environment: { capabilities: { threadMcpControl: true } },
      providers: [{ instanceId: "claude", driver: "claudeAgent", skills: [], slashCommands: [] }],
    }),
  }),
  useProject: () => null,
}));
vi.mock("../../state/query", async () => {
  const { ThreadId, TurnItemId } = await import("@t3tools/contracts");
  const DateTime = await import("effect/DateTime");
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
    inventory: {
      skills: [],
      plugins: [],
      agents: [],
      mcpServers: [{ name: "sentry", status: "failed", error: "boom" }],
    },
    mcpServersLive: true,
  };
  return {
    useEnvironmentQuery: () => ({ data, error: null, isPending: false, refresh: state.refresh }),
  };
});
vi.mock("../../state/orchestration", async () => {
  const { Atom } = await import("effect/reactivity");
  const permitted = Atom.make(true);
  return {
    orchestrationEnvironment: {
      threadExtensions: () => null,
      controlMcpServer: { permissionAtom: () => permitted },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => () => {
    state.reconnects += 1;
    return new Promise((resolve) => {
      state.settleReconnect = resolve;
    });
  },
}));

import { SkillsPanel } from "./SkillsPanel";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function click(element: Element | null | undefined) {
  expect(element).toBeInstanceOf(HTMLElement);
  await act(() => (element as HTMLElement).click());
  await act(() => vi.advanceTimersByTimeAsync(0));
}

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.startsWith(text),
  );
const reconnectButton = () =>
  container.querySelector<HTMLButtonElement>('[aria-label="Reconnect sentry"]');

it("keeps a Reconnect's result and its in-flight state while the MCP list is collapsed", async () => {
  await act(() =>
    root.render(
      <AppAtomRegistryProvider>
        <SkillsPanel threadRef={{ environmentId: EnvironmentId.make("env-1"), threadId }} />
      </AppAtomRegistryProvider>,
    ),
  );
  const liveRegion = container.querySelector('[aria-live="polite"]');
  expect(liveRegion?.textContent).toBe("");

  await click(button("sentry"));
  await click(reconnectButton());
  expect(state.reconnects).toBe(1);
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
  await act(async () => state.settleReconnect?.({ _tag: "Success", value: undefined }));

  expect(liveRegion?.isConnected).toBe(true);
  expect(liveRegion?.textContent).toBe("Reconnected sentry.");
  expect(state.reconnects).toBe(1);
});

it("searches an empty dialog section: counts its matches and offers the section that has some", async () => {
  const onShowSection = vi.fn();
  const render = (query: string) =>
    act(() =>
      root.render(
        <AppAtomRegistryProvider>
          <SkillsPanel
            threadRef={{ environmentId: EnvironmentId.make("env-1"), threadId }}
            section="plugins"
            query={query}
            onShowSection={onShowSection}
          />
        </AppAtomRegistryProvider>,
      ),
    );
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
