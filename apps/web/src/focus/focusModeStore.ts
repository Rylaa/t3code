import { create } from "zustand";

import { toastManager } from "../components/ui/toast";

// Per device, like an OS focus mode. Kept out of the shared client settings
// schema so this fork-only feature adds no upstream schema fields.
const STORAGE_KEY = "t3code:focus-mode";

function readStored(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

const useFocusModeStore = create<{ enabled: boolean }>(() => ({ enabled: readStored() }));

if (typeof window !== "undefined") {
  // Keeps other windows of the same app in step.
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) useFocusModeStore.setState({ enabled: readStored() });
  });
}

export function useFocusModeEnabled(): boolean {
  return useFocusModeStore((state) => state.enabled);
}

export function toggleFocusMode(): void {
  const enabled = !useFocusModeStore.getState().enabled;
  useFocusModeStore.setState({ enabled });
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Storage can be unavailable in private windows; the mode still applies until reload.
  }
  toastManager.add({
    id: "focus-mode",
    title: enabled ? "Focus mode on" : "Focus mode off",
    description: enabled
      ? "Only focused projects can interrupt you."
      : "Notifications are back to normal.",
    timeout: 1500,
  });
}
