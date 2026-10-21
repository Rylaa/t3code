import { DEFAULT_CLIENT_SETTINGS, type DesktopSnapShotState } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  captureSetupAccessReady,
  captureSetupInitialStep,
  captureSetupMacPermissionsReady,
  captureSetupShortcutReady,
  captureSetupShouldDisableOnClose,
} from "./SnapShotSetupDialog.logic";

const mac: DesktopSnapShotState = {
  mode: "direct",
  shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
  shortcutRegistered: true,
  shortcutMessage: null,
  shortcutVerified: false,
  message: null,
  macPermissions: { screenRecording: true, accessibility: true },
};

it("resumes on the shortcut step once a shortcut is saved", () => {
  expect(captureSetupInitialStep(mac)).toBe("shortcut");
  expect(captureSetupInitialStep({ ...mac, shortcutVerified: true })).toBe("shortcut");
});

it("does not skip native permission setup when capture has not been enabled", () => {
  expect(captureSetupInitialStep({ ...mac, shortcutRegistered: false })).toBe("access");
});

it("keeps setup on the access step while capture needs attention", () => {
  const state = { ...mac, message: "Allow Screen Recording in System Settings." };
  expect(captureSetupAccessReady(state)).toBe(false);
  expect(captureSetupInitialStep(state, "shortcut")).toBe("access");
  expect(captureSetupAccessReady({ ...mac, mode: "unavailable" })).toBe(false);
  expect(captureSetupAccessReady(mac)).toBe(true);
});

it("requires saving a changed chord before finishing setup", () => {
  expect(captureSetupShortcutReady(mac, true)).toBe(false);
  expect(captureSetupShortcutReady(mac, false)).toBe(true);
  expect(captureSetupShortcutReady({ ...mac, shortcutRegistered: false }, false)).toBe(false);
});

it("blocks finishing if capture access is lost during the wizard", () => {
  expect(
    captureSetupShortcutReady({ ...mac, shortcutVerified: true, message: "Lost access" }, false),
  ).toBe(false);
});

it.each([
  [false, false, true],
  [false, true, false],
  [true, false, false],
  [true, true, false],
] as const)(
  "closing setup (previously enabled=%s, completed=%s) disables only an unfinished first opt-in",
  (wasEnabled, completed, disable) => {
    expect(captureSetupShouldDisableOnClose(wasEnabled, completed)).toBe(disable);
  },
);

it("gates Continue on macOS permissions, requiring accessibility only when app text is on", () => {
  const state: DesktopSnapShotState = {
    ...mac,
    macPermissions: { screenRecording: true, accessibility: false },
  };
  expect(captureSetupMacPermissionsReady(state, true)).toBe(false);
  expect(captureSetupMacPermissionsReady(state, false)).toBe(true);
  expect(
    captureSetupMacPermissionsReady(
      { ...state, macPermissions: { screenRecording: false, accessibility: true } },
      false,
    ),
  ).toBe(false);
  expect(captureSetupMacPermissionsReady({ ...state, macPermissions: undefined }, true)).toBe(true);
});
