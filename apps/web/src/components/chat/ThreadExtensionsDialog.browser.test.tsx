import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
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

async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}

/** Mounts the dialog host and opens the dialog, under a fine pointer unless told otherwise. */
async function openDialog({ finePointer = true } = {}) {
  const stack = new AsyncDisposableStack();
  try {
    stack.use(
      stubGlobal("matchMedia", (query: string) => ({
        matches: query === "(pointer: fine)" && finePointer,
      })),
    );
    stack.use(
      await render(
        <AppAtomRegistryProvider>
          <ThreadExtensionsDialogHost />
        </AppAtomRegistryProvider>,
      ),
    );
    stack.use(fakeTimers());
    await act(() =>
      openThreadExtensionsDialog(
        { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") },
        "skills",
      ),
    );
    await settle();
    return stack.move();
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
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
    {
      await using _dialog = await openDialog();
      expect(document.activeElement).toBe(searchInput());
    }

    await using _dialog = await openDialog({ finePointer: false });
    expect(searchInput()).not.toBeNull();
    expect(document.activeElement).not.toBe(searchInput());
  });

  it("clears the search with the first Escape and closes with the next", async () => {
    await using _dialog = await openDialog();
    await type(searchInput()!, "seo");
    expect(searchInput()?.value).toBe("seo");

    await press("Escape");
    expect(searchInput()?.value).toBe("");

    await press("Escape");
    expect(searchInput()).toBeNull();
  });

  it('moves focus to search on "/" but types it inside a field', async () => {
    await using _dialog = await openDialog();
    const row = document.querySelector<HTMLElement>("[data-nav-item]")!;
    await act(() => row.focus());

    await press("/");
    expect(document.activeElement).toBe(searchInput());

    const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    await act(() => searchInput()!.dispatchEvent(slash));
    expect(slash.defaultPrevented).toBe(false);
  });
});
