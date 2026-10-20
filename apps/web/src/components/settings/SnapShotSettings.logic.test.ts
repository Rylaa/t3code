import { assert, expect, it } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type DesktopSnapShotState } from "@t3tools/contracts";

import {
  createRecordingRequestTracker,
  snapShotStatus,
  snapShotShortcutStatus,
  snapShotUnavailableMessage,
  snapShotSoundPatch,
  snapShotSetupSummary,
  snapShotSetupButtonLabel,
  snapShotSetupComplete,
} from "./SnapShotSettings.logic";

it.each([
  ["off", { snapShotPlaySound: false }],
  ["soft-pop", { snapShotPlaySound: true, snapShotSound: "soft-pop" }],
  ["camera-shutter", { snapShotPlaySound: true, snapShotSound: "camera-shutter" }],
] as const)("maps %s to compatible capture settings", (sound, patch) => {
  expect(snapShotSoundPatch(sound)).toEqual(patch);
});

it("ignores a stale request after a newer request starts", () => {
  const requests = createRecordingRequestTracker();
  const firstRequest = requests.tryBegin();
  assert(firstRequest);

  requests.clear();
  const secondRequest = requests.tryBegin();
  assert(secondRequest);

  expect(requests.owns(firstRequest)).toBe(false);
  expect(requests.owns(secondRequest)).toBe(true);
  expect(requests.tryBegin()).toBeNull();
});

it("reports unavailable capture support without browser globals", () => {
  expect(snapShotUnavailableMessage(false)).toBe("Only available in the desktop app.");
});

it("keeps unavailable capture distinct from the opt-in setup prompt", () => {
  const state: DesktopSnapShotState = {
    mode: "unavailable",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: false,
    shortcutMessage: null,
    message: "Not supported on this Mac.",
  };

  expect(snapShotStatus(state, false)).toBe("Not supported on this Mac.");
});

it("hides macOS setup only while permissions and the shortcut are all in place", () => {
  const ready: DesktopSnapShotState = {
    mode: "direct",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
    macPermissions: { screenRecording: true, accessibility: true },
  };
  expect(snapShotSetupComplete(ready, true)).toBe(true);
  expect(snapShotSetupComplete({ ...ready, macPermissions: undefined }, true)).toBe(false);
  expect(snapShotSetupComplete({ ...ready, shortcutRegistered: false }, true)).toBe(false);
  const revoked = {
    ...ready,
    macPermissions: { screenRecording: true, accessibility: false },
    message: "Allow Accessibility in System Settings, then restart T3 Code.",
  };
  expect(snapShotSetupComplete(revoked, true)).toBe(false);
  expect(snapShotStatus(revoked, true)).toBe("Capture needs attention");
  expect(snapShotSetupButtonLabel(revoked)).toBe("Continue setup");
  expect(snapShotSetupComplete({ ...revoked, message: null }, false)).toBe(true);
});

it("distinguishes saved shortcuts from observed delivery without making users repeat setup", () => {
  const state: DesktopSnapShotState = {
    mode: "direct",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
  };
  expect(snapShotStatus(state, false)).toBe("Turn this on to set up snapshots.");
  expect(snapShotSetupSummary(state, true)).toBe("Shortcut saved");
  expect(snapShotShortcutStatus(state)).toBe("Shortcut saved.");
  expect(snapShotSetupButtonLabel(state)).toBe("Manage capture");
  expect(snapShotSetupSummary({ ...state, shortcutVerified: true }, true)).toBe("Ready to capture");
  expect(snapShotSetupSummary({ ...state, shortcutVerified: true }, false)).toContain(
    "Enable capture",
  );
  const unregistered = {
    ...state,
    shortcutRegistered: false,
    shortcutMessage: "This shortcut is already used by the system or another app.",
  };
  expect(snapShotSetupSummary(unregistered, true)).toBe("Finish shortcut setup");
  expect(snapShotShortcutStatus(unregistered)).toBe(unregistered.shortcutMessage);
});
