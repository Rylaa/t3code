import * as MacPermissions from "../permissions/MacPermissions.ts";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingSnapShot,
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
import * as Schema from "effect/Schema";
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
const decodePendingMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopPendingSnapShot),
);

import {
  SnapShotTransition,
  snapShotAnimationDurationMs,
  snapShotAnimationDisplayBounds,
  snapShotAnimationOverlayBounds,
} from "./SnapShotTransition.ts";
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

it.effect("reads and acknowledges queued captures through Effect services", () => {
  const captureId = "12345678-1234-1234-1234-123456789abc";
  const captureDirectory = "/state/snap-shots";
  const metadataPath = captureDirectory + "/" + captureId + ".json";
  const imagePath = captureDirectory + "/" + captureId + ".png";
  const removed: Array<string> = [];
  const metadata = JSON.stringify({
    id: captureId,
    name: "window.png",
    mimeType: "image/png",
    sizeBytes: 3,
    source: {
      kind: "snap-shot",
      capturedAt: "2026-08-24T11:00:00.000Z",
      appName: "Editor",
      windowTitle: "main.ts",
    },
  });
  const layer = layerTest("darwin", {
    readDirectory: () => Effect.succeed([captureId + ".json", "invalid.json"]),
    readFileString: (filePath) => Effect.succeed(filePath === metadataPath ? metadata : "invalid"),
    readFile: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    remove: (filePath) =>
      Effect.sync(() => {
        removed.push(filePath);
      }),
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const pending = yield* service.listPending;
      assert.deepEqual(
        pending.map((capture) => capture.id),
        [captureId],
      );

      const capture = yield* service.read(captureId);
      assert.strictEqual(capture.dataUrl, "data:image/png;base64,AQID");

      yield* service.acknowledge(captureId);
      assert.deepEqual(removed.sort(), [imagePath, metadataPath].sort());
    }),
  ).pipe(Effect.provide(layer));
});

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

it.effect("captures the foreground window in place from the shortcut", () => {
  registerShortcutMock.mockReset().mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValue("granted");
  animationSettingsMock.mockReturnValue({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  const bounds = { x: 10, y: 20, width: 800, height: 600 };
  const t3 = {
    id: 42,
    title: "T3 Code",
    owner: { name: "T3 Code", processId: 123 },
    bounds,
    png: Buffer.from([1, 2, 3]),
  };
  focusedWindowMock.mockReturnValue({
    getBounds: () => bounds,
    getTitle: () => t3.title,
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    show: vi.fn(),
    restore: vi.fn(),
  });
  const images: Uint8Array[] = [];
  activeWindowMock.mockReset().mockResolvedValue(t3);
  macCaptureMock.mockReset().mockImplementation(async () => {
    images.push(t3.png);
    return { source: { name: t3.title }, png: t3.png };
  });
  const readAccessibility = accessibilityProcessReadMock.getMockImplementation()!;
  accessibilityProcessReadMock.mockImplementation(({ active }) => ({
    started: Promise.resolve(),
    result: Promise.resolve({ accessibleText: `Window from process ${active.owner.processId}` }),
  }));
  let metadata = "";

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(
        enabledSettings({
          snapShotFlash: false,
          snapShotShortcut: {
            key: "2",
            ctrlKey: true,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            modKey: false,
          },
        }),
      );
      yield* Effect.promise(registerShortcutMock.mock.calls.at(-1)![1]);

      const saved = yield* decodePendingMetadata(metadata);
      assert.equal(saved.source.windowTitle, t3.title);
      assert.equal(saved.source.appName, t3.owner.name);
      assert.equal(saved.source.accessibleText, `Window from process ${t3.owner.processId}`);
      assert.deepEqual(images, [t3.png]);
    }),
  ).pipe(
    Effect.provide(
      layerTest("darwin", {
        makeDirectory: () => Effect.void,
        rename: () => Effect.void,
        writeFile: (_, bytes) =>
          Effect.sync(() => {
            images.push(bytes);
          }),
        writeFileString: (_, text) =>
          Effect.sync(() => {
            metadata = text;
          }),
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        focusedWindowMock.mockReset();
        accessibilityProcessReadMock.mockReset().mockImplementation(readAccessibility);
        mediaAccessStatusMock.mockReturnValue("not-determined");
        animationSettingsMock.mockReturnValue({
          prefersReducedMotion: true,
          shouldRenderRichAnimation: false,
        });
      }),
    ),
  );
});

it.effect("ignores shortcut repeats for 200 ms without delaying the first capture", () => {
  const fixture = concurrentCaptureFixture(false);
  fixture.releaseAll();
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(fixture.settings);
      yield* service.setShortcutSuppressed(true);
      yield* Effect.promise(fixture.trigger);
      assert.equal(fixture.state.snapshots, 0);
      yield* service.setShortcutSuppressed(false);
      yield* Effect.promise(fixture.trigger);
      assert.equal(fixture.state.snapshots, 1);
      assert.lengthOf(fixture.readyIds, 1);

      yield* Effect.promise(fixture.trigger);
      yield* TestClock.adjust("199 millis");
      yield* Effect.promise(fixture.trigger);
      assert.equal(fixture.state.snapshots, 1);
      assert.lengthOf(fixture.readyIds, 1);

      yield* TestClock.adjust("1 millis");
      yield* Effect.promise(fixture.trigger);
      assert.equal(fixture.state.snapshots, 2);
      assert.lengthOf(fixture.readyIds, 2);

      yield* service.capture;
      assert.equal(fixture.state.snapshots, 3);
      assert.lengthOf(fixture.readyIds, 3);
    }),
  ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
});

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

it.effect("skips accessibility capture when the setting is disabled", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    id: 42,
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  macCaptureMock.mockReset().mockResolvedValue({ source: { name: "Editor" }, png });
  accessibilityProcessWarmMock.mockClear();
  accessibilityProcessReadMock.mockClear();
  accessibilityByPidMock.mockClear();
  const layer = layerTest("darwin", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFile: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings({ snapShotIncludeAccessibility: false }));
      yield* service.capture;

      assert.lengthOf(accessibilityProcessWarmMock.mock.calls, 0);
      assert.lengthOf(accessibilityProcessReadMock.mock.calls, 0);
      assert.lengthOf(accessibilityByPidMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("keeps an accessibility helper warm only while capture data is enabled", () => {
  accessibilityProcessWarmMock.mockClear();
  accessibilityProcessCoolMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        snapShotEnabled: true,
        snapShotIncludeAccessibility: true,
      });

      assert.lengthOf(accessibilityProcessWarmMock.mock.calls, 1);
      assert.lengthOf(accessibilityProcessCoolMock.mock.calls, 0);

      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        snapShotEnabled: false,
        snapShotIncludeAccessibility: true,
      });

      assert.lengthOf(accessibilityProcessCoolMock.mock.calls, 1);
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("uses display-local macOS capture surfaces across the source and main displays", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    id: 42,
    title: "Terminal",
    owner: { name: "Terminal", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [] });
  macCaptureMock.mockReset().mockResolvedValue({
    source: { name: "Terminal" },
    png,
  });
  animationSettingsMock.mockReturnValueOnce({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  focusedWindowMock.mockReturnValue({
    getBounds: () => ({ x: -1_600, y: 100, width: 1_200, height: 800 }),
    isDestroyed: () => false,
  });
  flashWindows.length = 0;
  const layer = layerTest("darwin", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      yield* service.capture;

      const transitionWindows = flashWindows.filter((window) => window.kind === "browser");
      assert.deepEqual(
        transitionWindows.map((window) => window.bounds),
        [
          { x: 0, y: -200, width: 1_440, height: 900 },
          { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        ],
      );
      for (const transitionWindow of transitionWindows) {
        assert.deepEqual(transitionWindow.alwaysOnTopCalls, [[true, "pop-up-menu"]]);
      }
    }),
  ).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => focusedWindowMock.mockReset())));
});

it.effect.each(["ready", "failed"] as const)(
  "shows the transition only once its snapshot decode is %s",
  (outcome) => {
    const png = Buffer.from([1, 2, 3]);
    activeWindowMock.mockReset().mockResolvedValue({
      id: 42,
      title: "Editor",
      owner: { name: "Editor", processId: 123 },
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
    macCaptureMock.mockReset().mockResolvedValue({ source: { name: "Editor" }, png });
    animationSettingsMock.mockReturnValueOnce({
      prefersReducedMotion: false,
      shouldRenderRichAnimation: true,
    });
    const decoding = Promise.withResolvers<void>();
    const decoded = Promise.withResolvers<void>();
    transitionSnapshotMock.mockImplementation(() => {
      decoding.resolve();
      return decoded.promise;
    });
    focusedWindowMock.mockReturnValue({
      getBounds: () => ({ x: 100, y: 50, width: 1_200, height: 800 }),
      isDestroyed: () => false,
    });
    transitionShowMock.mockClear();
    flashWindows.length = 0;

    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(
          enabledSettings({ snapShotIncludeAccessibility: false, snapShotFlash: false }),
        );
        const capture = yield* service.capture.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => decoding.promise);
        assert.lengthOf(transitionShowMock.mock.calls, 0);

        if (outcome === "ready") decoded.resolve();
        else decoded.reject(new Error("Snapshot decode failed"));
        yield* Fiber.join(capture);

        if (outcome === "ready") {
          assert.isNotEmpty(transitionShowMock.mock.calls);
        } else {
          assert.lengthOf(transitionShowMock.mock.calls, 0);
          assert.isTrue(flashWindows.every((window) => window.destroyed));
        }
      }),
    ).pipe(
      Effect.provide(
        layerTest("darwin", {
          makeDirectory: () => Effect.void,
          rename: () => Effect.void,
          writeFile: () => Effect.void,
          writeFileString: () => Effect.void,
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          decoded.resolve();
          focusedWindowMock.mockReset();
        }),
      ),
    );
  },
);

it.effect("uses the unfocused main window for a macOS cross-display transition", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    id: 42,
    title: "Terminal",
    owner: { name: "Terminal", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [] });
  macCaptureMock.mockReset().mockResolvedValue({ source: { name: "Terminal" }, png });
  animationSettingsMock.mockReturnValueOnce({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  focusedWindowMock.mockReturnValue(undefined);
  allWindowsMock.mockReturnValue([
    {
      getBounds: () => ({ x: -1_600, y: 100, width: 1_200, height: 800 }),
      isDestroyed: () => false,
    },
  ]);
  flashWindows.length = 0;
  const layer = layerTest("darwin", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      yield* service.capture;

      assert.deepEqual(
        flashWindows.filter((window) => window.kind === "browser").map((window) => window.bounds),
        [
          { x: 0, y: -200, width: 1_440, height: 900 },
          { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        ],
      );
    }),
  ).pipe(
    Effect.provide(layer),
    Effect.ensuring(
      Effect.sync(() => {
        focusedWindowMock.mockReset();
        allWindowsMock.mockReset();
      }),
    ),
  );
});

function fakeIcon(label: string, empty = false): Electron.NativeImage {
  return {
    isEmpty: () => empty,
    resize: ({ width, height, quality }) => ({
      toDataURL: (options) =>
        "data:image/png;base64," +
        label +
        ":" +
        width +
        "x" +
        height +
        ":" +
        quality +
        "@" +
        options?.scaleFactor,
    }),
  } as Electron.NativeImage;
}

it.each([
  ["OS app", fakeIcon("file"), fakeIcon("captured"), "file"],
  ["captured app", fakeIcon("file", true), fakeIcon("captured"), "captured"],
])("exports the %s icon at high density", (_source, fileIcon, capturedIcon, expectedLabel) => {
  const dataUrl = DesktopSnapShot.snapShotIconDataUrl(fileIcon, capturedIcon);

  assert.strictEqual(dataUrl, "data:image/png;base64," + expectedLabel + ":64x64:best@2");
});

const activeEditor = {
  owner: { path: "/Applications/Editor.app" },
} as Parameters<typeof DesktopSnapShot.iconDataUrl>[1];

it("requests the file icon at a size supported on macOS after a failed thumbnail", async () => {
  getFileIconMock.mockReset();
  thumbnailFromPathMock.mockReset().mockRejectedValue(new Error("no thumbnail"));
  getFileIconMock.mockResolvedValue(fakeIcon("file"));

  const dataUrl = await DesktopSnapShot.iconDataUrl(
    { appIcon: fakeIcon("captured") },
    activeEditor,
  );

  assert.deepEqual(getFileIconMock.mock.calls, [["/Applications/Editor.app", { size: "normal" }]]);
  assert.strictEqual(dataUrl, "data:image/png;base64,file:64x64:best@2");
});

it("uses the operating system animation policy", () => {
  assert.isTrue(
    DesktopSnapShot.shouldAnimateSnapShot({
      prefersReducedMotion: false,
      shouldRenderRichAnimation: true,
    }),
  );
  assert.isFalse(
    DesktopSnapShot.shouldAnimateSnapShot({
      prefersReducedMotion: true,
      shouldRenderRichAnimation: true,
    }),
  );
});

it("scales transition timing with travel distance", () => {
  const source = { x: 0, y: 0, width: 200, height: 100 };
  assert.strictEqual(snapShotAnimationDurationMs(source, source), 280);
  const near = snapShotAnimationDurationMs(source, {
    x: 100,
    y: 0,
    width: 200,
    height: 100,
  });
  const far = snapShotAnimationDurationMs(source, {
    x: 1_000,
    y: 0,
    width: 200,
    height: 100,
  });

  assert.isAtLeast(near, 280);
  assert.isBelow(far, 570);
  assert.isAbove(far, near);
});

it("bounds the transition surface to its displays", () => {
  assert.deepEqual(
    snapShotAnimationOverlayBounds([
      { bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
      { bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
    ]),
    { x: -1_920, y: -200, width: 3_360, height: 1_280 },
  );
});

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

it("keeps cross-display handoff surfaces local to each display", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 100, y: 50, width: 1_000, height: 700 },
    );
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    await transition.waitForLanding("capture-1");

    assert.deepEqual(
      flashWindows.map((window) => window.bounds),
      [
        { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        { x: 0, y: -200, width: 1_440, height: 900 },
      ],
    );
    for (const window of flashWindows) {
      assert.strictEqual(window.resizeCount, 0);
    }
  } finally {
    transition.dispose();
  }
});

it("adds a newly selected destination display without resizing existing surfaces", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition();
  const snapshot = "data:image/png;base64,captured-window";

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      snapshot,
      false,
      { x: -1_600, y: 100, width: 1_000, height: 700 },
    );
    assert.lengthOf(flashWindows, 1);
    const initialWindow = flashWindows[0];

    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    await transition.waitForLanding("capture-1");

    assert.strictEqual(flashWindows[0], initialWindow);
    assert.deepEqual(
      flashWindows.map((window) => window.bounds),
      [
        { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        { x: 0, y: -200, width: 1_440, height: 900 },
      ],
    );
    for (const window of flashWindows) {
      assert.strictEqual(window.resizeCount, 0);
      assert.strictEqual(window.showCount, 1);
    }
  } finally {
    transition.dispose();
  }
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

it("keeps flying on the destination display when the capture display fails", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 100, y: 50, width: 1_000, height: 700 },
    );
    transitionScriptState.rejectFlight = true;
    transitionScriptState.heldFlights = [];
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });

    let landed = false;
    const landing = transition.waitForLanding("capture-1").then(() => {
      landed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.lengthOf(transitionScriptState.heldFlights, 1);
    assert.isFalse(landed);

    for (const release of transitionScriptState.heldFlights) release();
    await landing;
  } finally {
    transitionScriptState.rejectFlight = false;
    transitionScriptState.heldFlights = null;
    transition.dispose();
  }
});

it("keeps same-display motion inside one stable surface", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 200, y: 100, width: 1_000, height: 700 },
    );
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    await transition.waitForLanding("capture-1");

    assert.deepEqual(flashWindows[0]?.bounds, {
      x: 0,
      y: -200,
      width: 1_440,
      height: 900,
    });
    assert.strictEqual(flashWindows[0]?.resizeCount, 0);
  } finally {
    transition.dispose();
  }
});

it("keeps the transition above the revealed main window", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );

    assert.deepEqual(flashWindows[0]?.alwaysOnTopCalls, [[true, "pop-up-menu"]]);
  } finally {
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

it("bounds source thumbnails for large windows", () => {
  assert.deepEqual(
    DesktopSnapShot.snapShotThumbnailSize({
      bounds: { x: 0, y: 0, width: 6_000, height: 4_000 },
    } as Parameters<typeof DesktopSnapShot.snapShotThumbnailSize>[0]),
    { width: 2_560, height: 1_600 },
  );
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

it.each([20, 1_350, 2_999])(
  "includes accessibility text as soon as a %d ms read completes",
  async (duration) => {
    vi.useFakeTimers();
    const tree = Promise.withResolvers<{ value: string; children: Array<never> }>();
    const started = Promise.withResolvers<void>();
    accessibilityByPidMock.mockReset().mockResolvedValue({
      children: async () => [
        {
          name: "Mozilla Firefox",
          bounds: { x: 67, y: 32, width: 1_373, height: 928 },
          tree: () => {
            started.resolve();
            return tree.promise;
          },
        },
      ],
    });

    try {
      const result = readAccessibleWindowText(
        {
          title: "Mozilla Firefox",
          owner: { processId: 42 },
          bounds: { x: 67, y: 32, width: 1_373, height: 928 },
        },
        "Mozilla Firefox",
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(duration);
      tree.resolve({ value: "Firefox page text", children: [] });

      assert.strictEqual(await result, "Firefox page text");
      assert.strictEqual(vi.getTimerCount(), 0);
    } finally {
      tree.resolve({ value: "", children: [] });
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  },
);

it("falls back to completed flat text when rich traversal reaches the deadline", async () => {
  vi.useFakeTimers();
  const richChildren = Promise.withResolvers<Array<never>>();
  const richStarted = Promise.withResolvers<void>();
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "window",
        name: "Editor",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        tree: async () => ({ value: "Complete flat text", children: [] }),
        children: () => {
          richStarted.resolve();
          return richChildren.promise;
        },
      },
    ],
  });

  try {
    const result = readAccessibleWindowContext(
      {
        title: "Editor",
        owner: { processId: 42 },
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
      "Editor",
      { width: 1_600, height: 1_200 },
    );
    await richStarted.promise;
    await vi.advanceTimersByTimeAsync(3_000);

    assert.deepEqual(await result, {
      accessibleText: "Complete flat text",
      accessibility: {
        format: "flat-text",
        text: "Complete flat text",
        truncated: false,
      },
    });
  } finally {
    richChildren.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
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

it("keeps a truncated tree when flat text would not recover any text", async () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "window",
        name: "Editor",
        bounds,
        tree: async () => ({ name: "Editor", children: [{ name: "Help", children: [] }] }),
        children: async () => [
          {
            role: "button",
            name: "Help",
            description: "Help text ".repeat(250),
            bounds,
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
  assert.include(
    result?.accessibility?.format === "element-tree"
      ? result.accessibility.root.children[0]?.description
      : undefined,
    "Help text",
  );
});

it("times out after three seconds without overlapping the outstanding accessibility read", async () => {
  vi.useFakeTimers();
  accessibilityByPidMock.mockReset();
  const read = Promise.withResolvers<{ children: () => Promise<Array<never>> }>();
  const started = Promise.withResolvers<void>();
  accessibilityByPidMock.mockImplementationOnce(() => {
    started.resolve();
    return read.promise;
  });
  const active = {
    title: "main.ts",
    owner: { processId: 42 },
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  } satisfies SnapShotAccessibility.AccessibleWindowIdentity;

  try {
    const first = readAccessibleWindowText(active, "main.ts");
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(2_999);
    assert.isFalse(settled);
    await vi.advanceTimersByTimeAsync(1);
    assert.isUndefined(await first);
    assert.strictEqual(vi.getTimerCount(), 0);
    assert.isUndefined(await readAccessibleWindowText(active, "main.ts"));
    assert.strictEqual(accessibilityByPidMock.mock.calls.length, 1);

    read.resolve({ children: async () => [] });
    await vi.advanceTimersByTimeAsync(0);
    accessibilityByPidMock.mockResolvedValueOnce({ children: async () => [] });
    assert.isUndefined(await readAccessibleWindowText(active, "main.ts"));
    assert.strictEqual(accessibilityByPidMock.mock.calls.length, 2);
  } finally {
    read.resolve({ children: async () => [] });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it("uses native opacity for a short-lived flash", async () => {
  vi.useFakeTimers();
  flashWindows.length = 0;
  const flash = new DesktopSnapShot.SnapShotFlash();
  const bounds = { x: 10, y: 20, width: 800, height: 600 };

  try {
    await flash.showAnimated(bounds);

    assert.lengthOf(flashWindows, 1);
    assert.strictEqual(flashWindows[0]?.kind, "base");
    assert.strictEqual(flashWindows[0]?.options.transparent, false);
    assert.strictEqual(flashWindows[0]?.loadCount, 0);
    assert.deepEqual(flashWindows[0]?.bounds, bounds);
    assert.strictEqual(flashWindows[0]?.showCount, 1);
    assert.lengthOf(flashWindows[0]?.scripts ?? [], 0);
    await vi.advanceTimersByTimeAsync(180);
    assert.isTrue(flashWindows[0]?.destroyed);
    assert.isAbove(flashWindows[0]?.opacities.length ?? 0, 1);
    assert.strictEqual(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

it.effect("does not request permissions or create the flash during desktop startup", () => {
  flashWindows.length = 0;
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotFlash: true,
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.initialize;
      assert.lengthOf(flashWindows, 0);
      assert.deepEqual(accessibilityTrustedMock.mock.calls, [[false]]);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.lengthOf(openExternalMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(layerTest("darwin", {}, Option.some(settings))));
});

it.effect("keeps snapshots disabled when client settings cannot be read at startup", () => {
  const readError = new DesktopClientSettings.DesktopClientSettingsReadError({
    operation: "read-file",
    path: "/state/client-settings.json",
    cause: new Error("unavailable"),
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.initialize;
      assert.isFalse((yield* service.state).shortcutRegistered);
    }),
  ).pipe(Effect.provide(layerTest("darwin", {}, Option.none(), Effect.fail(readError))));
});

it.effect("does not request macOS permissions while synchronizing enabled settings", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();
  const settings = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);

      assert.deepEqual(accessibilityTrustedMock.mock.calls, [[false]]);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.lengthOf(openExternalMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("requests macOS permissions only for an explicit enable action", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.requestPermissions(true);

      assert.deepEqual(accessibilityTrustedMock.mock.calls, [[true]]);
      assert.lengthOf(getSourcesMock.mock.calls, 1);
      assert.lengthOf(openExternalMock.mock.calls, 1);
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("does not request macOS accessibility permission when capture data is disabled", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.requestPermissions(false);

      assert.lengthOf(accessibilityTrustedMock.mock.calls, 0);
      assert.lengthOf(getSourcesMock.mock.calls, 1);
      assert.lengthOf(openExternalMock.mock.calls, 1);
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("reports macOS permission status and requests each permission on its own", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("granted");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const state = yield* service.state;
      assert.deepEqual(state.macPermissions, { screenRecording: true, accessibility: false });

      yield* service.setup("allow-accessibility");
      assert.deepEqual(accessibilityTrustedMock.mock.calls.at(-1), [true]);
      assert.lengthOf(getSourcesMock.mock.calls, 0);

      mediaAccessStatusMock.mockReturnValue("not-determined");
      yield* service.setup("allow-screen-recording");
      assert.lengthOf(getSourcesMock.mock.calls, 1);
      assert.lengthOf(openExternalMock.mock.calls, 1);
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
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

it.effect("rejects macOS permission actions off macOS and omits macPermissions there", () => {
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const state = yield* service.state;
      assert.isUndefined(state.macPermissions);
      const error = yield* service.setup("allow-screen-recording").pipe(Effect.flip);
      assert.equal(error.reason, "unsupported-session");
    }),
  ).pipe(Effect.provide(layerTest("freebsd")));
});

it.effect("registers macOS capture without accessibility permission when data is disabled", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("granted");
  registerShortcutMock.mockReset().mockReturnValue(true);

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        snapShotEnabled: true,
        snapShotIncludeAccessibility: false,
      });

      assert.lengthOf(accessibilityTrustedMock.mock.calls, 0);
      assert.isTrue((yield* service.state).shortcutRegistered);
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("registers a configured key chord instead of the modifier-pair listener", () => {
  grantMacPermissions();
  registerShortcutMock.mockReset().mockReturnValue(true);
  spawnedPollers.length = 0;
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotShortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);

      assert.isTrue((yield* service.state).shortcutRegistered);
      assert.strictEqual(registerShortcutMock.mock.calls[0]?.[0], "Control+Alt+K");
      assert.lengthOf(spawnedPollers, 0);
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

it.effect("keeps shortcut registration errors off the capture status", () => {
  grantMacPermissions();
  registerShortcutMock.mockReset().mockReturnValue(false);
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotShortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);

      const state = yield* service.state;
      assert.isNull(state.message);
      assert.equal(
        state.shortcutMessage,
        "This shortcut is already used by the system or another app.",
      );
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("probes macOS modifier pairs with the flags poller", () => {
  spawnedPollers.length = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const result = yield* service.checkShortcut({ kind: "both-shift-keys" });
      assert.isTrue(result.available);
      assert.match(result.message ?? "", /Shift \+ Shift is observed/);
      assert.notMatch(result.message ?? "", /Input Monitoring/);
      assert.lengthOf(spawnedPollers, 1);
      assert.deepEqual(spawnedPollers[0]?.args.slice(-2), ["2", "4"]);
      assert.strictEqual(spawnedPollers[0]?.kill.mock.calls.length, 1);
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("registers macOS modifier pairs through the flags poller", () => {
  spawnedPollers.length = 0;
  accessibilityTrustedMock.mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValue("granted");
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotShortcut: { kind: "modifier-pair", modifier: "meta" },
  } satisfies ClientSettings;

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({ ...settings, snapShotEnabled: true });
      const state = yield* service.state;

      assert.lengthOf(spawnedPollers, 1);
      assert.deepEqual(spawnedPollers[0]?.args.slice(-2), ["8", "16"]);
      assert.isTrue(state.shortcutRegistered);
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

const macTestCaptureLayer = layerTest("darwin", {
  makeTempDirectoryScoped: () => Effect.succeed("/tmp/setup-test"),
  readDirectory: () => Effect.succeed([]),
});
const macTestCaptureWindow = {
  id: 42,
  title: "Setup",
  owner: { name: "T3 Code", processId: 123, path: "/Applications/T3 Code.app" },
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};

it.effect("names the failed macOS window lookup without repeating what it printed", () => {
  const script = 'ObjC.import("CoreGraphics"); function run() { return ""; }';
  const stderr = "execution error: Error: Not authorized to send Apple events. (-1743)";
  activeWindowMock
    .mockReset()
    .mockRejectedValue(
      Object.assign(
        new Error(`Command failed: /usr/bin/osascript -l JavaScript -e ${script}\n${stderr}`),
        { cmd: `/usr/bin/osascript -l JavaScript -e ${script}`, code: 1, killed: false },
      ),
    );
  macCaptureMock.mockReset();
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const error = yield* service.setup("test-mac-capture").pipe(Effect.flip);
      assert.equal(
        error.message,
        'Could not capture a test snapshot. Finding the front window failed: osascript exited with code 1. macOS grants Screen Recording and Accessibility to each app separately. In System Settings, open Privacy & Security and check that "T3 Code (Dev)" is allowed for both.',
      );
      assert.include(String(error.cause), stderr);
      assert.equal(macCaptureMock.mock.calls.length, 0);
    }),
  ).pipe(Effect.provide(macTestCaptureLayer));
});

it.effect("says when macOS has no window to test capture", () => {
  activeWindowMock.mockReset().mockResolvedValue(undefined);
  macCaptureMock.mockReset();
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const error = yield* service.setup("test-mac-capture").pipe(Effect.flip);
      assert.equal(
        error.message,
        "Could not capture a test snapshot. No window is available to capture.",
      );
      assert.equal(macCaptureMock.mock.calls.length, 0);
    }),
  ).pipe(Effect.provide(macTestCaptureLayer));
});

it.effect("says when the macOS test capture command timed out", () => {
  activeWindowMock.mockReset().mockResolvedValue(macTestCaptureWindow);
  macCaptureMock.mockReset().mockRejectedValue(
    Object.assign(new Error("Command failed: /usr/sbin/screencapture -l 42 -o -x"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
    }),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const error = yield* service.setup("test-mac-capture").pipe(Effect.flip);
      assert.equal(
        error.message,
        'Could not capture a test snapshot. Capturing the window timed out. macOS grants Screen Recording and Accessibility to each app separately. In System Settings, open Privacy & Security and check that "T3 Code (Dev)" is allowed for both.',
      );
    }),
  ).pipe(Effect.provide(macTestCaptureLayer));
});

it.effect("rejects macOS test capture on other platforms", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const error = yield* service.setup("test-mac-capture").pipe(Effect.flip);
      assert.equal(error.reason, "unsupported-session");
      assert.equal(error.message, "Test capture requires macOS.");
    }),
  ).pipe(Effect.provide(layerTest("freebsd"))),
);
