import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand, type ShortcutEventLike } from "../keybindings";

const press = (overrides: Partial<ShortcutEventLike>): ShortcutEventLike => ({
  key: "f",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe("focus mode shortcut", () => {
  it("toggles with Cmd+Option+F on macOS, where Option turns the key into ƒ", () => {
    expect(
      resolveShortcutCommand(
        press({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "MacIntel", context: { terminalFocus: false } },
      ),
    ).toBe("focusMode.toggle");
  });

  it("toggles with Ctrl+Alt+F elsewhere", () => {
    expect(
      resolveShortcutCommand(
        press({ code: "KeyF", ctrlKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Win32", context: { terminalFocus: false } },
      ),
    ).toBe("focusMode.toggle");
  });

  it("leaves the keys to a focused terminal", () => {
    expect(
      resolveShortcutCommand(
        press({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "MacIntel", context: { terminalFocus: true } },
      ),
    ).toBeNull();
  });
});
