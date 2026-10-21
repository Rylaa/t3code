import * as MacPermissions from "../permissions/MacPermissions.ts";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type DesktopSnapShotEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

beforeEach(() => {
  transitionSnapshotMock.mockReset().mockResolvedValue(undefined);
  accessibilityListMock.mockReset().mockResolvedValue([]);
});

const {
  activeWindowMock,
  animationSettingsMock,
  accessibilityProcessWarmMock,
  accessibilityProcessCloseMock,
  accessibilityProcessCoolMock,
  accessibilityProcessReadMock,
  accessibilityByPidMock,
  accessibilityListMock,
  accessibilityTrustedMock,
  allWindowsMock,
  flashWindows,
  focusedWindowMock,
  getFileIconMock,
  getSourcesMock,
  macCaptureMock,
  mediaAccessStatusMock,
  openExternalMock,
  registerShortcutMock,
  unregisterShortcutMock,
  spawnedPollers,
  thumbnailFromPathMock,
  transitionScriptState,
  transitionShowMock,
  transitionSnapshotMock,
} = vi.hoisted(() => ({
  activeWindowMock: vi.fn(),
  animationSettingsMock: vi.fn(() => ({
    prefersReducedMotion: true,
    shouldRenderRichAnimation: false,
  })),
  accessibilityProcessWarmMock: vi.fn(),
  accessibilityProcessCloseMock: vi.fn(),
  accessibilityProcessCoolMock: vi.fn(),
  accessibilityProcessReadMock: vi.fn<
    (request: import("./SnapShotAccessibility.ts").SnapShotAccessibilityRequest) => {
      started: Promise<void>;
      result: Promise<
        import("./SnapShotAccessibility.ts").CapturedWindowAccessibilityContext | undefined
      >;
    }
  >(),
  accessibilityByPidMock: vi.fn(),
  accessibilityListMock: vi.fn(),
  accessibilityTrustedMock: vi.fn((_prompt = false) => true),
  allWindowsMock: vi.fn(
    () =>
      [] as Array<{
        getBounds: () => Electron.Rectangle;
        isDestroyed: () => boolean;
      }>,
  ),
  flashWindows: [] as Array<{
    bounds: Electron.Rectangle | null;
    destroyed: boolean;
    kind: "base" | "browser";
    loadCount: number;
    loadedUrls: Array<string>;
    opacities: Array<number>;
    options: Electron.BrowserWindowConstructorOptions;
    scripts: Array<string>;
    showCount: number;
    resizeCount: number;
    alwaysOnTopCalls: Array<[boolean, string | undefined]>;
  }>,
  focusedWindowMock: vi.fn(),
  getFileIconMock: vi.fn(),
  getSourcesMock: vi.fn(),
  macCaptureMock: vi.fn(),
  mediaAccessStatusMock: vi.fn(() => "not-determined"),
  openExternalMock: vi.fn(() => Promise.resolve()),
  registerShortcutMock: vi.fn(),
  unregisterShortcutMock: vi.fn(),
  spawnedPollers: [] as Array<{
    args: ReadonlyArray<string>;
    kill: ReturnType<typeof vi.fn>;
    emitStderr: (text: string) => void;
    emitExit: (code: number) => void;
  }>,
  thumbnailFromPathMock: vi.fn(),
  transitionScriptState: {
    rejectFlight: false,
    heldFlights: null as Array<() => void> | null,
  },
  transitionShowMock: vi.fn(),
  transitionSnapshotMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("./SnapShotAccessibilityProcess.ts", () => ({
  makeSnapShotAccessibilityProcessPool: () => ({
    warm: accessibilityProcessWarmMock,
    cool: accessibilityProcessCoolMock,
    read: accessibilityProcessReadMock,
    close: accessibilityProcessCloseMock,
  }),
}));
vi.mock("./ActiveWindow.ts", () => ({ activeWindow: activeWindowMock }));
vi.mock("./MacSnapShot.ts", () => ({ captureMacWindowSnapshot: macCaptureMock }));
vi.mock("node:child_process", () => ({
  spawn: (_command: string, args: ReadonlyArray<string>) => {
    const stderrListeners: Array<(chunk: Buffer) => void> = [];
    const onceListeners = new Map<string, Array<(value?: unknown) => void>>();
    const record = {
      args,
      kill: vi.fn(() => true),
      emitStderr: (text: string) => {
        for (const listener of stderrListeners) listener(Buffer.from(text));
      },
      emitExit: (code: number) => {
        for (const listener of onceListeners.get("exit") ?? []) listener(code);
      },
    };
    spawnedPollers.push(record);
    const child = {
      stderr: {
        on: (_event: "data", listener: (chunk: Buffer) => void) => {
          stderrListeners.push(listener);
          return child;
        },
      },
      once: (event: string, listener: (value?: unknown) => void) => {
        onceListeners.set(event, [...(onceListeners.get(event) ?? []), listener]);
        return child;
      },
      kill: record.kill,
    };
    queueMicrotask(() => record.emitStderr("ready\n"));
    return child;
  },
}));
vi.mock("electron", () => {
  class BaseWindow {
    protected readonly state: (typeof flashWindows)[number];

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.state = {
        bounds:
          options.x === undefined ||
          options.y === undefined ||
          options.width === undefined ||
          options.height === undefined
            ? null
            : { x: options.x, y: options.y, width: options.width, height: options.height },
        destroyed: false,
        kind: "base",
        loadCount: 0,
        loadedUrls: [],
        opacities: options.opacity === undefined ? [] : [options.opacity],
        options,
        scripts: [],
        showCount: 0,
        resizeCount: 0,
        alwaysOnTopCalls: [],
      };
      flashWindows.push(this.state);
    }

    destroy() {
      this.state.destroyed = true;
    }

    getBounds() {
      return this.state.bounds;
    }

    isDestroyed() {
      return this.state.destroyed;
    }

    setBounds(bounds: Electron.Rectangle) {
      this.state.resizeCount++;
      this.state.bounds = bounds;
    }

    setIgnoreMouseEvents() {}

    setOpacity(opacity: number) {
      this.state.opacities.push(opacity);
    }

    setAlwaysOnTop(flag: boolean, level?: string) {
      this.state.alwaysOnTopCalls.push([flag, level]);
    }

    showInactive() {
      const shownBounds = transitionShowMock(this.state.bounds);
      if (shownBounds !== undefined) this.state.bounds = shownBounds;
      this.state.showCount += 1;
    }
  }

  class BrowserWindow extends BaseWindow {
    static getFocusedWindow() {
      return focusedWindowMock();
    }

    static getAllWindows() {
      return allWindowsMock();
    }

    readonly webContents;

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      super(options);
      this.state.kind = "browser";
      this.webContents = {
        executeJavaScript: async (script: string) => {
          this.state.scripts.push(script);
          if (script.startsWith("window.setCaptureSnapshot")) {
            await transitionSnapshotMock();
          }
          if (script !== "window.playCaptureTransition()") return;
          if (transitionScriptState.rejectFlight) {
            transitionScriptState.rejectFlight = false;
            throw new Error("transition failed");
          }
          const held = transitionScriptState.heldFlights;
          if (held) await new Promise<void>((resolve) => held.push(resolve));
        },
      };
    }

    loadURL(url: string) {
      this.state.loadCount += 1;
      this.state.loadedUrls.push(url);
      return Promise.resolve();
    }
  }

  return {
    BaseWindow,
    BrowserWindow,
    app: { getFileIcon: getFileIconMock },
    desktopCapturer: { getSources: getSourcesMock },
    nativeImage: { createThumbnailFromPath: thumbnailFromPathMock },
    globalShortcut: { register: registerShortcutMock, unregister: unregisterShortcutMock },
    screen: {
      getDisplayMatching: (bounds: Electron.Rectangle) =>
        bounds.x < 0
          ? { id: 1, bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } }
          : { id: 2, bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
      getAllDisplays: () => [
        { id: 1, bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
        { id: 2, bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
      ],
      getCursorScreenPoint: () => ({ x: 500, y: 500 }),
      getDisplayNearestPoint: () => ({
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      }),
    },
    shell: { openExternal: openExternalMock },
    systemPreferences: {
      getAnimationSettings: () => animationSettingsMock(),
      getMediaAccessStatus: () => mediaAccessStatusMock(),
      isTrustedAccessibilityClient: (prompt: boolean) => accessibilityTrustedMock(prompt),
    },
  };
});

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopSnapShot from "./DesktopSnapShot.ts";
import * as SnapShotAccessibility from "./SnapShotAccessibility.ts";

const accessibilityApp = {
  byPid: accessibilityByPidMock,
  list: accessibilityListMock,
} as unknown as Parameters<typeof SnapShotAccessibility.readAccessibleWindowContextWithApp>[0];
const readAccessibleWindowContext = (
  active: SnapShotAccessibility.AccessibleWindowIdentity,
  sourceTitle: string,
  imageSize: Electron.Size = {
    width: Math.max(1, Math.round(active.bounds.width)),
    height: Math.max(1, Math.round(active.bounds.height)),
  },
) =>
  SnapShotAccessibility.readAccessibleWindowContextWithApp(accessibilityApp, {
    active,
    sourceTitle,
    imageSize,
  });
const readAccessibleWindowText = async (
  active: SnapShotAccessibility.AccessibleWindowIdentity,
  sourceTitle: string,
) => (await readAccessibleWindowContext(active, sourceTitle))?.accessibleText;
accessibilityProcessReadMock.mockImplementation((request) => ({
  started: Promise.resolve(),
  result: readAccessibleWindowContext(request.active, request.sourceTitle, request.imageSize),
}));
import { SnapShotTransition, snapShotAnimationDisplayBounds } from "./SnapShotTransition.ts";
const layerTest = (
  platform: NodeJS.Platform,
  fileSystemOverrides: Parameters<typeof FileSystem.layerNoop>[0] = {},
  initialSettings: Option.Option<ClientSettings> = Option.none(),
  settingsGet: Effect.Effect<
    Option.Option<ClientSettings>,
    DesktopClientSettings.DesktopClientSettingsReadError
  > = Effect.succeed(initialSettings),
) =>
  MacPermissions.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            platform,
            displayName: "T3 Code (Dev)",
            stateDir: "/state",
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.succeed(
          DesktopClientSettings.DesktopClientSettings,
          DesktopClientSettings.DesktopClientSettings.of({
            get: settingsGet,
            set: () => Effect.void,
          }),
        ),
        Layer.succeed(
          DesktopWindow.DesktopWindow,
          DesktopWindow.DesktopWindow.of({
            activate: Effect.void,
            dispatchMenuAction: () => Effect.void,
            dispatchSnapShotEvent: () => Effect.void,
          } as unknown as DesktopWindow.DesktopWindow["Service"]),
        ),
        FileSystem.layerNoop(fileSystemOverrides),
        Path.layer,
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
      ),
    ),
  );

const enabledSettings = (overrides: Partial<ClientSettings> = {}): ClientSettings => ({
  ...DEFAULT_CLIENT_SETTINGS,
  snapShotEnabled: true,
  ...overrides,
});

const grantMacPermissions = () => {
  mediaAccessStatusMock.mockReturnValue("granted");
  accessibilityTrustedMock.mockReturnValue(true);
};

function concurrentCaptureFixture(animations: boolean) {
  focusedWindowMock.mockReturnValue(undefined);
  allWindowsMock.mockReturnValue([]);
  registerShortcutMock.mockReset().mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValue("granted");
  animationSettingsMock.mockReturnValue({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  flashWindows.length = 0;
  const captures = ["Discord", "File Explorer", "Terminal"].map((title, index) => ({
    title,
    id: index + 42,
    processId: index + 100,
    png: Buffer.from([index, index + 1, index + 2]),
    started: Promise.withResolvers<void>(),
    pixels: Promise.withResolvers<void>(),
    handoff: Promise.withResolvers<void>(),
    context: Promise.withResolvers<SnapShotAccessibility.CapturedWindowAccessibilityContext>(),
    oldOverlaysCleared: false,
  }));
  const [first, second, extra] = captures;
  extra!.pixels.resolve();
  extra!.context.resolve({ accessibleText: extra!.title });
  const state = {
    snapshots: 0,
    handoffs: 0,
    failFirstPersistence: false,
  };
  const images = new Map<string, Uint8Array>();
  const metadata = new Map<string, string>();
  const readyIds: string[] = [];
  const requestedIds: string[] = [];
  const bounds = { x: 10, y: 20, width: 800, height: 600 };
  const takeSnapshot = async () => {
    const index = state.snapshots++;
    const capture = captures[Math.min(index, captures.length - 1)]!;
    capture.oldOverlaysCleared = flashWindows.every((window) => window.destroyed);
    capture.started.resolve();
    await capture.pixels.promise;
    return capture;
  };
  activeWindowMock.mockReset().mockImplementation(async () => {
    const capture = captures[Math.min(state.snapshots, captures.length - 1)]!;
    return {
      id: capture.id,
      title: capture.title,
      owner: { name: capture.title, processId: capture.processId },
      bounds,
    };
  });
  macCaptureMock.mockReset().mockImplementation(async (_active: unknown, imagePath: string) => {
    const capture = await takeSnapshot();
    images.set(imagePath, capture.png);
    return { source: { name: capture.title }, png: capture.png };
  });
  const readAccessibility = accessibilityProcessReadMock.getMockImplementation()!;
  accessibilityProcessReadMock.mockImplementation(({ active }) => ({
    started: Promise.resolve(),
    result: captures.find((capture) => capture.processId === active.owner.processId)!.context
      .promise,
  }));
  const handoff = Effect.sync(() => captures[state.handoffs++]!.handoff.resolve());
  let randomByte = 0;
  const layer = Layer.mergeAll(
    layerTest("darwin", {
      makeDirectory: () => Effect.void,
      writeFile: (path, bytes) =>
        Effect.sync(() => {
          images.set(path, bytes);
        }),
      writeFileString: (path, text) => {
        const pending = JSON.parse(text) as { source: { windowTitle: string } };
        return state.failFirstPersistence && pending.source.windowTitle === first!.title
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "writeFileString",
              }),
            )
          : Effect.sync(() => {
              metadata.set(path, text);
            });
      },
      rename: (from, to) =>
        Effect.sync(() => {
          const image = images.get(from);
          if (image) {
            images.set(to, image);
            images.delete(from);
          }
          const text = metadata.get(from);
          if (text) {
            metadata.set(to, text);
            metadata.delete(from);
          }
        }),
      remove: (path) =>
        Effect.sync(() => {
          images.delete(path);
          metadata.delete(path);
        }),
      readFile: (path) => Effect.sync(() => images.get(path)!),
      readFileString: (path) => Effect.sync(() => metadata.get(path)!),
    }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(++randomByte),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
    Layer.succeed(
      DesktopWindow.DesktopWindow,
      DesktopWindow.DesktopWindow.of({
        activate: handoff,
        dispatchMenuAction: () => Effect.void,
        dispatchSnapShotEvent: (event: DesktopSnapShotEvent) => {
          switch (event.type) {
            case "requested":
              return Effect.sync(() => {
                requestedIds.push(event.id);
              });
            case "started":
              return handoff;
            case "ready":
              return Effect.sync(() => {
                readyIds.push(event.id);
              });
            default:
              return Effect.void;
          }
        },
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
  );
  return {
    first: first!,
    second: second!,
    state,
    readyIds,
    requestedIds,
    layer,
    settings: {
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotEnabled: true,
      snapShotIncludeAccessibility: true,
      snapShotAnimations: animations,
      snapShotFlash: true,
      snapShotShortcut: {
        key: "2",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        modKey: false,
      },
    },
    trigger: () => (registerShortcutMock.mock.calls.at(-1)![1] as () => Promise<void>)(),
    releaseAll: () => {
      for (const capture of captures) {
        capture.pixels.resolve();
        capture.context.resolve({ accessibleText: capture.title });
      }
    },
    reset: () => {
      focusedWindowMock.mockReset();
      accessibilityProcessReadMock.mockReset().mockImplementation(readAccessibility);
      mediaAccessStatusMock.mockReturnValue("not-determined");
      animationSettingsMock.mockReturnValue({
        prefersReducedMotion: true,
        shouldRenderRichAnimation: false,
      });
      vi.unstubAllEnvs();
    },
  };
}

it.effect("drops shortcut bursts during flight and accepts a fresh capture after landing", () => {
  const fixture = concurrentCaptureFixture(true);
  fixture.releaseAll();
  const flying = Promise.withResolvers<void>();
  const heldFlights: Array<() => void> = [];
  const push = heldFlights.push.bind(heldFlights);
  vi.spyOn(heldFlights, "push").mockImplementation((...resolvers) => {
    const count = push(...resolvers);
    flying.resolve();
    return count;
  });
  transitionScriptState.heldFlights = heldFlights;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(fixture.settings);
      yield* Effect.promise(fixture.trigger);
      const firstId = fixture.readyIds[0]!;
      const landing = yield* service
        .setAnimationDestination(firstId, {
          frame: { x: 100, y: 400, width: 208, height: 112 },
          backgroundColor: "#fff",
          borderColor: "#ccc",
          borderWidth: 1,
          cornerRadius: 8,
          scaleFactor: 1,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => flying.promise);
      const overlayCount = flashWindows.length;

      for (let repeat = 0; repeat < 20; repeat++) {
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(fixture.trigger);
      }
      assert.equal(fixture.state.snapshots, 1);
      assert.lengthOf(fixture.readyIds, 1);
      assert.lengthOf(flashWindows, overlayCount);
      assert.isTrue(flashWindows.every((window) => !window.destroyed));

      for (const finish of heldFlights) finish();
      yield* Fiber.join(landing);
      // Landing releases the guard even before the first capture is acknowledged.
      yield* Effect.promise(fixture.trigger);
      assert.equal(fixture.state.snapshots, 2);
      assert.lengthOf(fixture.readyIds, 2);
      assert.isTrue(fixture.second.oldOverlaysCleared);
    }),
  ).pipe(
    Effect.provide(fixture.layer),
    Effect.ensuring(
      Effect.sync(() => {
        for (const finish of heldFlights) finish();
        transitionScriptState.heldFlights = null;
        fixture.reset();
      }),
    ),
  );
});

it.effect.each([
  { length: 1_000, suffix: "", expectedLength: 1_000 },
  { length: 1_001, suffix: "", expectedLength: 1_000 },
  { length: 999, suffix: "😀", expectedLength: 999 },
])(
  "preserves captures with native metadata of length $length and suffix $suffix",
  ({ length, suffix, expectedLength }) => {
    const png = Buffer.from([1, 2, 3]);
    const title = "t".repeat(length) + suffix;
    const appName = "a".repeat(254) + "😀";
    const appIdentifier = "b".repeat(254) + "😀";
    activeWindowMock.mockReset().mockResolvedValue({
      id: 42,
      title,
      owner: { name: appName, bundleId: appIdentifier, processId: 123 },
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
    focusedWindowMock.mockReturnValue(undefined);
    allWindowsMock.mockReturnValue([]);
    macCaptureMock.mockReset().mockResolvedValue({ source: { name: title }, png });
    accessibilityProcessReadMock.mockReturnValueOnce({
      started: Promise.resolve(),
      result: Promise.resolve(undefined),
    });
    let metadata = "";
    const layer = layerTest("darwin", {
      makeDirectory: () => Effect.void,
      rename: () => Effect.void,
      writeFileString: (_, text) =>
        Effect.sync(() => {
          metadata = text;
        }),
      readDirectory: () => Effect.succeed(["capture.json"]),
      readFileString: () => Effect.succeed(metadata),
      readFile: () => Effect.succeed(png),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(enabledSettings());
        yield* service.capture;
        const pending = yield* service.listPending;
        assert.lengthOf(pending, 1);
        const capture = yield* service.read(pending[0]!.id);
        assert.equal(capture.dataUrl, "data:image/png;base64,AQID");
        assert.equal(capture.source.windowTitle, "t".repeat(expectedLength));
        assert.equal(capture.source.appName, "a".repeat(254));
        assert.equal(capture.source.appIdentifier, "b".repeat(254));
      }),
    ).pipe(Effect.provide(layer));
  },
);

it.effect("captures again while accessibility is pending", () => {
  const fixture = concurrentCaptureFixture(false);
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(fixture.settings);
      const first = yield* Effect.promise(fixture.trigger).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.promise(() => fixture.first.started.promise);
      assert.lengthOf(fixture.requestedIds, 1);
      assert.lengthOf(fixture.readyIds, 0);
      fixture.first.pixels.resolve();
      yield* Effect.promise(() => fixture.first.handoff.promise);
      assert.lengthOf(fixture.readyIds, 0);

      yield* TestClock.adjust("200 millis");
      fixture.second.pixels.resolve();
      const second = yield* Effect.promise(fixture.trigger).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.promise(() => fixture.second.handoff.promise);
      assert.equal(fixture.state.snapshots, 2);
      assert.isTrue(fixture.second.oldOverlaysCleared);
      const secondOverlays = flashWindows.filter((window) => !window.destroyed);
      assert.isNotEmpty(secondOverlays);

      fixture.second.context.resolve({ accessibleText: "Explorer accessibility" });
      yield* Fiber.join(second);
      assert.lengthOf(fixture.readyIds, 1);
      fixture.first.context.resolve({ accessibleText: "Discord accessibility" });
      yield* Fiber.join(first);
      assert.lengthOf(fixture.readyIds, 2);
      assert.equal(new Set(fixture.readyIds).size, 2);
      assert.deepEqual(fixture.readyIds, fixture.requestedIds.toReversed());
      const newer = yield* service.read(fixture.readyIds[0]!);
      const older = yield* service.read(fixture.readyIds[1]!);
      assert.equal(newer.source.windowTitle, fixture.second.title);
      assert.equal(newer.source.accessibleText, "Explorer accessibility");
      assert.equal(newer.dataUrl, `data:image/png;base64,${fixture.second.png.toString("base64")}`);
      assert.equal(older.source.windowTitle, fixture.first.title);
      assert.equal(older.source.accessibleText, "Discord accessibility");
      assert.equal(older.dataUrl, `data:image/png;base64,${fixture.first.png.toString("base64")}`);

      yield* service.acknowledge(fixture.readyIds[1]!);
      assert.isTrue(secondOverlays.every((window) => !window.destroyed));
    }).pipe(Effect.ensuring(Effect.sync(fixture.releaseAll))),
  ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
});

it.effect.each(["succeeds", "fails"] as const)(
  "keeps the newer snapshot exclusive when older persistence %s",
  (outcome) => {
    const fixture = concurrentCaptureFixture(true);
    fixture.state.failFirstPersistence = outcome === "fails";
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(fixture.settings);
        fixture.first.pixels.resolve();
        const first = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.first.handoff.promise);
        yield* TestClock.adjust("200 millis");
        const second = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.second.started.promise);

        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);
        fixture.first.context.resolve({ accessibleText: "Discord accessibility" });
        yield* Fiber.join(first);
        assert.lengthOf(fixture.readyIds, outcome === "succeeds" ? 1 : 0);
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);

        fixture.second.pixels.resolve();
        yield* Effect.promise(() => fixture.second.handoff.promise);
        fixture.second.context.resolve({ accessibleText: "Explorer accessibility" });
        yield* Fiber.join(second);
        assert.equal(fixture.state.handoffs, 2);
        const newer = yield* service.read(fixture.readyIds.at(-1)!);
        assert.equal(newer.source.windowTitle, fixture.second.title);
        assert.equal(newer.source.accessibleText, "Explorer accessibility");
      }).pipe(Effect.ensuring(Effect.sync(fixture.releaseAll))),
    ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
  },
);

it("covers straddling captures and intervening monitors without spanning unrelated displays", () => {
  const displays = [
    { bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
    { bounds: { x: 0, y: 0, width: 1_440, height: 900 } },
    { bounds: { x: 1_440, y: 0, width: 1_280, height: 720 } },
    { bounds: { x: 0, y: -1_080, width: 1_920, height: 1_080 } },
  ];
  const source = { x: -200, y: 100, width: 800, height: 600 };
  assert.deepEqual(
    snapShotAnimationDisplayBounds(displays, source, source),
    displays.slice(0, 2).map((display) => display.bounds),
  );
  assert.deepEqual(
    snapShotAnimationDisplayBounds(
      displays,
      { x: -1_800, y: 100, width: 800, height: 600 },
      { x: 1_600, y: 200, width: 200, height: 112 },
    ),
    displays.slice(0, 3).map((display) => display.bounds),
  );
});

it("cancels a late display while its snapshot is still decoding", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition();
  const decoding = Promise.withResolvers<void>();
  const decoded = Promise.withResolvers<void>();

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transitionSnapshotMock.mockImplementationOnce(() => {
      decoding.resolve();
      return decoded.promise;
    });
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    const landing = transition.waitForLanding("capture-1");
    await decoding.promise;

    transition.dismiss("capture-1");
    decoded.resolve();
    await landing;

    assert.lengthOf(flashWindows, 2);
    assert.strictEqual(flashWindows[1]?.showCount, 0);
    for (const window of flashWindows) {
      assert.isTrue(window.destroyed);
    }
  } finally {
    decoded.resolve();
    transition.dispose();
  }
});

it("does not let a failed transition fail landing or capture completion", async () => {
  flashWindows.length = 0;
  transitionScriptState.rejectFlight = true;
  const transition = new SnapShotTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transition.animateTo("capture-1", {
      frame: { x: 20, y: 20, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });

    await transition.waitForLanding("capture-1");
    assert.isFalse(transition.isAnimating);
    await transition.complete("capture-1");

    assert.isTrue(flashWindows[0]?.destroyed);
  } finally {
    transitionScriptState.rejectFlight = false;
    transition.dispose();
  }
});

it("extracts a structured accessibility tree", async () => {
  const bounds = { x: 100, y: 200, width: 800, height: 600 };
  const window = {
    role: "window",
    name: "Editor",
    bounds,
    tree: async () => ({
      name: "Editor",
      children: [
        { name: "Save", children: [] },
        { name: "Below scroll view", children: [] },
      ],
    }),
    children: async () => [
      {
        role: "button",
        name: "Save",
        bounds: { x: 300, y: 350, width: 100, height: 50 },
        children: async () => [],
      },
      {
        role: "static_text",
        name: "Below scroll view",
        bounds: { x: 300, y: 1_000, width: 100, height: 50 },
        visible: false,
        children: async () => [],
      },
    ],
  };
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });

  const result = await readAccessibleWindowContext(
    { title: "Editor", bounds, owner: { processId: 123 } },
    "Editor",
    { width: 1_600, height: 1_200 },
  );

  assert.equal(result?.accessibility?.format, "element-tree");
  assert.equal(
    result?.accessibility?.format === "element-tree"
      ? result.accessibility.root.children[0]?.name
      : undefined,
    "Save",
  );
  assert.deepInclude(
    result?.accessibility?.format === "element-tree"
      ? result.accessibility.root.children[1]
      : undefined,
    { name: "Below scroll view", bounds: null, state: { visible: false } },
  );
  assert.lengthOf(accessibilityByPidMock.mock.calls, 1);
});

it("requires matching accessibility screen positions", async () => {
  const tree = vi.fn(async () => ({ value: "Wrong window", children: [] }));
  const window = {
    name: "Editor",
    bounds: { x: 0, y: 0, width: 700, height: 520 },
    tree,
  };
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });
  assert.isUndefined(
    await readAccessibleWindowText(
      {
        title: "Editor",
        bounds: { x: 479, y: 342, width: 700, height: 520 },
        owner: { processId: 123 },
      },
      "Editor",
    ),
  );
  assert.lengthOf(tree.mock.calls, 0);
});

it.each([
  ["value", 650],
  ["name", 100],
] as const)("preserves long text outside the scroll view (%s)", async (field, lines) => {
  const text = `${"Document line\n".repeat(lines)}End of document`;
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const window = {
    role: "window",
    name: "Editor",
    bounds,
    tree: async () => ({ name: "Editor", children: [{ [field]: text, children: [] }] }),
    children: async () => [{ role: "text_area", [field]: text, bounds, children: async () => [] }],
  };
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });
  const result = await readAccessibleWindowContext(
    { title: "Editor", bounds, owner: { processId: 123 } },
    "Editor",
  );
  assert.deepEqual(result?.accessibility, {
    format: "flat-text",
    text: `Editor\n${text}`,
    truncated: false,
  });
});

it.each([
  ["com.google.Chrome", "Google Chrome – Profile"],
  ["org.chromium.Chromium", "Chromium"],
])("reads macOS %s page context with an accessibility title suffix", async (bundleId, suffix) => {
  const title = "Issues · pingdotgg/t3code";
  const bounds = { x: 0, y: 33, width: 1470, height: 857 };
  const window = {
    role: "window",
    name: `${title} - ${suffix}`,
    bounds,
    tree: async () => ({ name: title, children: [{ name: "New issue", children: [] }] }),
    children: async () => [{ role: "button", name: "New issue", bounds, children: async () => [] }],
  };
  accessibilityByPidMock.mockReset().mockImplementation(async (pid: number) => ({
    children: async () => (pid === 42 ? [window] : []),
  }));

  const context = await readAccessibleWindowContext(
    { title, bounds, owner: { processId: 42, bundleId } },
    title,
  );

  assert.equal(context?.accessibleText, `${title}\nNew issue`);
  assert.equal(context?.accessibility?.format, "element-tree");
  assert.equal(
    context?.accessibility?.format === "element-tree"
      ? context.accessibility.root.children[0]?.name
      : undefined,
    "New issue",
  );
});

it("does not borrow another Chrome process context when the captured PID has no windows", async () => {
  const title = "Issues · pingdotgg/t3code";
  const bounds = { x: 0, y: 33, width: 1470, height: 857 };
  const otherWindow = {
    role: "window",
    name: `${title} - Google Chrome – Profile`,
    bounds,
    tree: async () => ({
      name: title,
      children: [{ name: "Other process private text", children: [] }],
    }),
    children: async () => [],
  };
  accessibilityByPidMock.mockReset().mockResolvedValue({
    pid: 42,
    children: async () => [],
  });
  accessibilityListMock.mockResolvedValue([
    { pid: 43, bundleId: "com.google.Chrome", children: async () => [otherWindow] },
  ]);

  assert.isUndefined(
    await readAccessibleWindowContext(
      { title, bounds, owner: { processId: 42, bundleId: "com.google.Chrome" } },
      title,
    ),
  );
});

it("reads app text from the app list when the PID lookup misses", async () => {
  const bounds = { x: 0, y: 0, width: 1_920, height: 1_048 };
  const tree = vi.fn(async () => ({
    name: "Issue — Zen Browser",
    children: [{ name: "New Tab", children: [] }],
  }));
  const proxyWindow = {
    role: "window",
    name: "Issue — Zen Browser",
    bounds,
    tree,
    children: async () => [],
  };
  accessibilityByPidMock
    .mockReset()
    .mockRejectedValue(
      new Error("XA11Y_SELECTOR_NOT_MATCHED: No element matched selector: application[pid=207651]"),
    );
  accessibilityListMock.mockReset().mockResolvedValue([
    {
      pid: 1,
      children: async () => [
        {
          role: "window",
          name: "Files",
          bounds,
          tree: async () => ({ name: "Files", children: [] }),
        },
      ],
    },
    { pid: 207646, children: async () => [proxyWindow] },
  ]);
  try {
    assert.strictEqual(
      await readAccessibleWindowText(
        {
          title: "Issue — Zen Browser",
          bounds: { x: 0, y: 0, width: 1_920, height: 1_048 },
          owner: { processId: 207651 },
        },
        "Issue — Zen Browser",
      ),
      "Issue — Zen Browser\nNew Tab",
    );
    assert.deepEqual(accessibilityByPidMock.mock.calls, [[207651, { timeout: 0 }]]);
    assert.lengthOf(accessibilityListMock.mock.calls, 1);
    assert.lengthOf(tree.mock.calls, 1);
  } finally {
    accessibilityListMock.mockReset().mockResolvedValue([]);
  }
});

it("reads app text from one unnamed PID-scoped window with the captured bounds", async () => {
  const bounds = { x: 12, y: 48, width: 1_920, height: 1_048 };
  const tree = vi.fn(async () => ({
    name: "System Monitor",
    children: [{ name: "CPU", children: [] }],
  }));
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "group",
        name: null,
        bounds,
        tree,
        children: async () => [
          { role: "page_tab_list", name: "Processes", bounds, children: async () => [] },
        ],
      },
    ],
  });
  accessibilityListMock.mockReset().mockResolvedValue([]);
  try {
    assert.strictEqual(
      await readAccessibleWindowText(
        {
          title: "System Monitor",
          bounds,
          owner: { processId: 210600 },
        },
        "System Monitor",
      ),
      "System Monitor\nCPU",
    );
    assert.deepEqual(accessibilityByPidMock.mock.calls, [[210600, { timeout: 0 }]]);
    assert.lengthOf(accessibilityListMock.mock.calls, 0);
    assert.lengthOf(tree.mock.calls, 1);
  } finally {
    accessibilityListMock.mockReset().mockResolvedValue([]);
  }
});

it("does not guess app text when two unnamed PID windows share the captured bounds", async () => {
  const bounds = { x: 12, y: 48, width: 1_920, height: 1_048 };
  const tree = vi.fn(async () => ({ value: "Wrong window", children: [] }));
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      { role: "group", name: null, bounds, tree },
      { role: "group", name: null, bounds, tree },
    ],
  });
  accessibilityListMock.mockReset().mockResolvedValue([
    {
      pid: 99,
      children: async () => [{ role: "window", name: "System Monitor", bounds, tree }],
    },
  ]);
  try {
    assert.isUndefined(
      await readAccessibleWindowText(
        {
          title: "System Monitor",
          bounds,
          owner: { processId: 210600 },
        },
        "System Monitor",
      ),
    );
    assert.lengthOf(accessibilityListMock.mock.calls, 0);
    assert.lengthOf(tree.mock.calls, 0);
  } finally {
    accessibilityListMock.mockReset().mockResolvedValue([]);
  }
});

it("keeps a truncated element tree when the flat text read fails", async () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "window",
        name: "Editor",
        bounds,
        tree: async () => {
          throw new Error("Text read failed");
        },
        children: async () => [
          {
            role: "text_area",
            value: "x".repeat(8_001),
            bounds: { x: 10, y: 50, width: 700, height: 500 },
            children: async () => [],
          },
        ],
      },
    ],
  });

  const result = await readAccessibleWindowContext(
    { title: "Editor", bounds, owner: { processId: 123 } },
    "Editor",
  );
  assert.equal(result?.accessibility?.format, "element-tree");
  assert.isTrue(result?.accessibility?.truncated);
  assert.deepEqual(
    result?.accessibility?.format === "element-tree"
      ? result.accessibility.root.children[0]?.bounds
      : undefined,
    { x: 10, y: 50, width: 700, height: 500 },
  );
});

it.effect("flags revoked macOS permissions on read and re-registers once they return", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(true);
  mediaAccessStatusMock.mockReset().mockReturnValue("granted");
  registerShortcutMock.mockReset().mockReturnValue(true);

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({ ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true });
      assert.isNull((yield* service.state).message);

      mediaAccessStatusMock.mockReturnValue("denied");
      const revoked = yield* service.state;
      assert.equal(
        revoked.message,
        "Allow Screen Recording in System Settings, then restart T3 Code.",
      );
      assert.deepEqual(revoked.macPermissions, { screenRecording: false, accessibility: true });

      accessibilityTrustedMock.mockReturnValue(false);
      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        snapShotEnabled: true,
        snapShotIncludeAccessibility: false,
      });
      const blocked = yield* service.state;
      assert.equal(
        blocked.message,
        "Allow Screen Recording in System Settings, then restart T3 Code.",
      );
      assert.isFalse(blocked.shortcutRegistered);

      mediaAccessStatusMock.mockReturnValue("granted");
      const recovered = yield* service.state;
      assert.isNull(recovered.message);
      assert.isTrue(recovered.shortcutRegistered);
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("an unrelated client-setting change keeps the registered shortcut", () => {
  grantMacPermissions();
  registerShortcutMock.mockReset().mockReturnValue(true);
  unregisterShortcutMock.mockReset();
  const settings = enabledSettings({
    snapShotShortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);
      assert.deepEqual(
        registerShortcutMock.mock.calls.map(([accelerator]) => accelerator),
        ["Control+Alt+K"],
      );

      yield* service.configure({ ...settings, wordWrap: !settings.wordWrap });
      assert.lengthOf(unregisterShortcutMock.mock.calls, 0);
      assert.lengthOf(registerShortcutMock.mock.calls, 1);
      assert.isTrue((yield* service.state).shortcutRegistered);

      yield* service.configure({
        ...settings,
        snapShotShortcut: { ...settings.snapShotShortcut, key: "j" },
      });
      assert.deepEqual(unregisterShortcutMock.mock.calls, [["Control+Alt+K"]]);
      assert.deepEqual(
        registerShortcutMock.mock.calls.map(([accelerator]) => accelerator),
        ["Control+Alt+K", "Control+Alt+J"],
      );
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("capture fails closed while snapshots are disabled", () => {
  activeWindowMock.mockClear();
  macCaptureMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({ ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: false });
      const failure = yield* Effect.flip(service.capture);
      assert.equal(failure.operation, "disabled");
      assert.lengthOf(activeWindowMock.mock.calls, 0);
      assert.lengthOf(macCaptureMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("waits to apply settings while permissions are pending", () => {
  accessibilityTrustedMock.mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValueOnce("not-determined").mockReturnValue("granted");
  let finishPermissionRequest: (() => void) | undefined;
  getSourcesMock.mockImplementationOnce(
    () =>
      new Promise<Array<never>>((resolve) => {
        finishPermissionRequest = () => resolve([]);
      }),
  );
  const layer = layerTest("darwin");

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const enabled = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
      const permissionFiber = yield* service.requestPermissions(true).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      if (!finishPermissionRequest) throw new Error("Permission request did not start");
      const finishPermission = finishPermissionRequest;

      const configureFiber = yield* service.configure(enabled).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isFalse((yield* service.state).shortcutRegistered);
      finishPermission();
      yield* Fiber.join(permissionFiber);
      yield* Fiber.join(configureFiber);

      const state = yield* service.state;
      assert.isTrue(state.shortcutRegistered);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect.each([false, true])(
  "tests macOS capture without publishing it and cleans up, failure=%s",
  (fails) => {
    const active = {
      id: 42,
      title: "Setup",
      owner: { name: "T3 Code", processId: 123, path: "/Applications/T3 Code.app" },
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    };
    activeWindowMock.mockReset().mockResolvedValue(active);
    macCaptureMock.mockReset();
    if (fails) macCaptureMock.mockRejectedValue(new Error("Capture denied"));
    else macCaptureMock.mockResolvedValue({ source: { name: "Setup" }, png: Buffer.from("png") });
    accessibilityProcessReadMock.mockClear();
    const cleanup = vi.fn();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        if (fails) {
          const error = yield* service.setup("test-mac-capture").pipe(Effect.flip);
          assert.equal(error.reason, "setup-failed");
          assert.equal(
            error.message,
            'Could not capture a test snapshot. Capturing the window failed. macOS grants Screen Recording and Accessibility to each app separately. In System Settings, open Privacy & Security and check that "T3 Code (Dev)" is allowed for both.',
          );
        } else yield* service.setup("test-mac-capture");
        assert.equal(macCaptureMock.mock.calls.length, 1);
        assert.equal(macCaptureMock.mock.calls[0]?.[0], active);
        assert.equal(macCaptureMock.mock.calls[0]?.[1], "/tmp/setup-test/test.png");
        assert.equal(cleanup.mock.calls.length, 1);
        assert.equal(accessibilityProcessReadMock.mock.calls.length, 0);
        assert.deepEqual(yield* service.listPending, []);
      }),
    ).pipe(
      Effect.provide(
        layerTest("darwin", {
          makeTempDirectoryScoped: () =>
            Effect.acquireRelease(Effect.succeed("/tmp/setup-test"), () =>
              Effect.sync(() => {
                cleanup();
              }),
            ),
          readDirectory: () => Effect.succeed([]),
        }),
      ),
    );
  },
);
