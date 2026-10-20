import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import {
  checkSnapShotShortcut,
  requestSnapShotPermissions,
  setupSnapShot,
  setSnapShotAnimationDestination,
  setSnapShotShortcutSuppressed,
  snapShotScreenFrame,
} from "./snapShot.ts";

describe("window capture IPC", () => {
  it("converts renderer viewport coordinates from the content origin using the window zoom", () => {
    assert.deepEqual(
      snapShotScreenFrame(
        { x: 12, y: 20, width: 208, height: 112 },
        { x: 100, y: 80, width: 1_000, height: 700 },
        1.25,
      ),
      { x: 115, y: 105, width: 260, height: 140 },
    );
  });

  it.effect("forwards a trusted renderer animation destination in screen coordinates", () => {
    let received: unknown;
    const webContents = { id: 7, getZoomFactor: () => 1.25 };
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeedSome({
            getBounds: () => ({ x: 100, y: 80, width: 1_000, height: 700 }),
            getContentBounds: () => ({ x: 100, y: 118, width: 1_000, height: 662 }),
            webContents,
          }),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopSnapShot.DesktopSnapShot,
        DesktopSnapShot.DesktopSnapShot.of({
          setAnimationDestination: (id: string, destination: unknown) =>
            Effect.sync(() => {
              received = { id, destination };
            }),
        } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
      ),
    );

    return Effect.gen(function* () {
      yield* setSnapShotAnimationDestination.handler(
        {
          id: "12345678-1234-1234-1234-123456789abc",
          viewportFrame: { x: 12, y: 20, width: 208, height: 112 },
          backgroundColor: "rgb(20, 20, 20)",
          borderColor: "rgba(80, 80, 80, 0.8)",
          borderWidth: 1,
          cornerRadius: 8,
          details: {
            appName: "T3 Code",
            windowTitle: "Capture animation",
            appIconDataUrl: "data:image/png;base64,aWNvbg==",
          },
        },
        { sender: webContents },
      );
      assert.deepEqual(received, {
        id: "12345678-1234-1234-1234-123456789abc",
        destination: {
          frame: { x: 115, y: 143, width: 260, height: 140 },
          backgroundColor: "rgb(20, 20, 20)",
          borderColor: "rgba(80, 80, 80, 0.8)",
          borderWidth: 1.25,
          cornerRadius: 10,
          scaleFactor: 1.25,
          details: {
            appName: "T3 Code",
            windowTitle: "Capture animation",
            appIconDataUrl: "data:image/png;base64,aWNvbg==",
          },
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("forwards the accessibility permission preference from a trusted renderer", () => {
    let includeAccessibility: boolean | undefined;
    const webContents = { id: 7 };
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeedSome({ webContents }),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopSnapShot.DesktopSnapShot,
        DesktopSnapShot.DesktopSnapShot.of({
          requestPermissions: (include: boolean) =>
            Effect.sync(() => {
              includeAccessibility = include;
            }),
        } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
      ),
    );

    return Effect.gen(function* () {
      yield* requestSnapShotPermissions.handler(false, { sender: webContents });
      assert.isFalse(includeAccessibility);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an untrusted renderer at the IPC boundary", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        requestSnapShotPermissions.handler(false, { sender: { id: 8 } }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.equal((error as { readonly _tag: string })._tag, "SnapShotIpcUnauthorizedSenderError");
      assert.equal((error as Error).message, "Snapshot request was rejected.");
    }).pipe(
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeedSome({ webContents: { id: 7 } }),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Effect.provideService(DesktopSnapShot.DesktopSnapShot, null as never),
    ),
  );

  it.effect("allows capture setup only from the trusted main renderer", () => {
    const actions: string[] = [];
    return Effect.gen(function* () {
      yield* setupSnapShot.handler("allow-accessibility", { sender: { id: 7 } });
      assert.deepEqual(actions, ["allow-accessibility"]);
      const rejected = yield* Effect.exit(
        setupSnapShot.handler("allow-screen-recording", { sender: { id: 8 } }),
      );
      assert(Exit.isFailure(rejected));
      assert.deepEqual(actions, ["allow-accessibility"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeedSome({ webContents: { id: 7 } }),
          } as ElectronWindow.ElectronWindow["Service"]),
          Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
            setup: (action: string) =>
              Effect.sync(() => {
                actions.push(action);
              }),
          } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
        ),
      ),
    );
  });

  it.effect("checks shortcut availability for a trusted renderer", () => {
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeedSome({ webContents: { id: 7 } }),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopSnapShot.DesktopSnapShot,
        DesktopSnapShot.DesktopSnapShot.of({
          checkShortcut: () => Effect.succeed({ available: true, message: null }),
        } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
      ),
    );

    return Effect.gen(function* () {
      const result = yield* checkSnapShotShortcut.handler(
        { kind: "both-shift-keys" },
        { sender: { id: 7 } },
      );
      assert.deepEqual(result, { available: true, message: null });
    }).pipe(Effect.provide(layer));
  });
  it.effect("suppresses the active shortcut for a trusted renderer", () => {
    let suppressed = false;
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeedSome({ webContents: { id: 7 } }),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopSnapShot.DesktopSnapShot,
        DesktopSnapShot.DesktopSnapShot.of({
          setShortcutSuppressed: (next: boolean) =>
            Effect.sync(() => {
              suppressed = next;
            }),
        } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
      ),
    );

    return Effect.gen(function* () {
      yield* setSnapShotShortcutSuppressed.handler(true, { sender: { id: 7 } });
      assert.isTrue(suppressed);
    }).pipe(Effect.provide(layer));
  });
});
