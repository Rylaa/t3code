// @vitest-environment jsdom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { openThreadExtensionsDialog, ThreadExtensionsDialogHost } from "./ThreadExtensionsDialog";

// The dialog's own behavior only: the panel and its data are stubbed.
vi.mock("./SkillsPanel", () => {
  const empty = { used: [], unused: [] };
  return {
    useThreadExtensions: () => ({
      query: { data: null, error: null, isPending: false, refresh: () => undefined },
      data: null,
      sections: {
        skills: empty,
        plugins: empty,
        mcpServers: empty,
        agents: empty,
        inventoryStatus: "unsupported",
        isEmpty: true,
      },
    }),
    SkillsPanel: () => (
      <button type="button" data-nav-item>
        seo-audit
      </button>
    ),
    ThreadExtensionsSummary: () => null,
    ThreadExtensionsSearch: (props: {
      inputRef: React.RefObject<HTMLInputElement | null>;
      value: string;
      onValueChange: (value: string) => void;
    }) => (
      <input
        ref={props.inputRef}
        aria-label="Search"
        value={props.value}
        onChange={(event) => props.onValueChange(event.currentTarget.value)}
      />
    ),
  };
});

let root: Root;
let container: HTMLDivElement;
let finePointer = true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: fine)" && finePointer,
  }));
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

async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}

async function openDialog() {
  await act(() =>
    root.render(
      <AppAtomRegistryProvider>
        <ThreadExtensionsDialogHost />
      </AppAtomRegistryProvider>,
    ),
  );
  await act(() =>
    openThreadExtensionsDialog(
      { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") },
      "skills",
    ),
  );
  await settle();
}

const searchInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Search"]');

async function press(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  await settle();
}

async function type(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ThreadExtensionsDialog", () => {
  it("focuses search on open only under a fine pointer", async () => {
    finePointer = true;
    await openDialog();
    expect(document.activeElement).toBe(searchInput());
    await act(() => root.unmount());

    finePointer = false;
    root = createRoot(container);
    await openDialog();
    expect(searchInput()).not.toBeNull();
    expect(document.activeElement).not.toBe(searchInput());
  });

  it("clears the search with the first Escape and closes with the next", async () => {
    await openDialog();
    await type(searchInput()!, "seo");
    expect(searchInput()?.value).toBe("seo");

    await press("Escape");
    expect(searchInput()?.value).toBe("");

    await press("Escape");
    expect(searchInput()).toBeNull();
  });

  it('moves focus to search on "/" but types it inside a field', async () => {
    await openDialog();
    const row = document.querySelector<HTMLElement>("[data-nav-item]")!;
    await act(() => row.focus());

    await press("/");
    expect(document.activeElement).toBe(searchInput());

    const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    await act(() => searchInput()!.dispatchEvent(slash));
    expect(slash.defaultPrevented).toBe(false);
  });
});
