import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock(import("../components/ui/toast"), () => ({ toastManager: toast }) as never);

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

async function loadStore() {
  vi.resetModules();
  return import("./focusModeStore");
}

beforeEach(() => {
  toast.add.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("focus mode store", () => {
  it("starts off, persists each toggle, and confirms it", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const store = await loadStore();
    store.toggleFocusMode();
    expect(storage.values.get("t3code:focus-mode")).toBe("on");
    expect(toast.add).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Focus mode on" }));
    store.toggleFocusMode();
    expect(storage.values.get("t3code:focus-mode")).toBe("off");
    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Focus mode off" }),
    );
  });

  it("restores the saved mode on the next launch", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ "t3code:focus-mode": "on" }));
    const store = await loadStore();
    // Turning it off proves the restored state was on.
    store.toggleFocusMode();
    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Focus mode off" }),
    );
  });

  it("still toggles when storage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    const store = await loadStore();
    expect(() => store.toggleFocusMode()).not.toThrow();
    expect(toast.add).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Focus mode on" }));
  });
});
