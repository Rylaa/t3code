// @effect-diagnostics nodeBuiltinImport:off -- osascript is the only way to reach EventKit from Electron without a native module.

import * as NodeChildProcess from "node:child_process";
import { DesktopFocusReminderSchema, type DesktopFocusReminder } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { FOCUS_SYNC_SCRIPT, makeCoalescingSync } from "../../focus/focusReminders.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { REQUEST_ATTENTION_CHANNEL, SYNC_FOCUS_REMINDERS_CHANNEL } from "../channels.ts";

// Long enough for the first run, which waits on the Reminders and Calendar access prompts.
const FOCUS_SYNC_TIMEOUT_MS = 320_000;

export const requestAttention = DesktopIpc.makeIpcMethod({
  channel: REQUEST_ATTENTION_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.focus.requestAttention")(function* () {
    const platform = yield* HostProcess.Platform;
    const window = yield* (yield* ElectronWindow.ElectronWindow).main;
    yield* Effect.sync(() => {
      if (Electron.BrowserWindow.getFocusedWindow()) return;
      // "critical" keeps bouncing until the app is activated.
      if (platform === "darwin") Electron.app.dock?.bounce("critical");
      else if (Option.isSome(window) && !window.value.isDestroyed()) {
        const main = window.value;
        main.flashFrame(true);
        main.once("focus", () => main.flashFrame(false));
      }
    });
  }),
});

function runFocusSync(items: ReadonlyArray<DesktopFocusReminder>): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", FOCUS_SYNC_SCRIPT, JSON.stringify(items)],
      { timeout: FOCUS_SYNC_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

const decodeFocusSyncResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ reminders: Schema.String, events: Schema.String })),
);

const applyFocusSync = async (items: ReadonlyArray<DesktopFocusReminder>): Promise<boolean> => {
  try {
    const result = decodeFocusSyncResult((await runFocusSync(items)).trim());
    if (
      [result.reminders, result.events].every((status) => status === "ok" || status === "skipped")
    )
      return true;
    Effect.runSync(Effect.logWarning("Focus reminders did not fully sync", result));
  } catch (error) {
    Effect.runSync(Effect.logWarning("Could not sync focus reminders", error));
  }
  return false;
};

export const installFocusReminders = Effect.fn("desktop.ipc.installFocusReminders")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const platform = yield* HostProcess.Platform;
  const sync = makeCoalescingSync(applyFocusSync, (items) => JSON.stringify(items));
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SYNC_FOCUS_REMINDERS_CHANNEL,
      payload: Schema.Array(DesktopFocusReminderSchema),
      result: Schema.Void,
      handler: (items) =>
        platform === "darwin"
          ? Effect.promise(() =>
              // An unparseable date would reach EventKit as NaN.
              sync(items.filter((item) => !Number.isNaN(Date.parse(item.until)))),
            )
          : Effect.void,
    }),
  );
});
