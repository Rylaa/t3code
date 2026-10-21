import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const { focusedWebContents, ownerWindow } = vi.hoisted(() => ({
  focusedWebContents: vi.fn(),
  ownerWindow: vi.fn(),
}));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: focusedWebContents },
  BrowserWindow: { fromWebContents: ownerWindow },
}));

import * as DesktopBackendConfiguration from "../../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import {
  getLocalEnvironmentBootstraps,
  getRelayTelemetryEnabled,
  probeRemoteEditors,
} from "./window.ts";

const readyConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/app/bin.mjs", "--bootstrap-fd", "3"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "127.0.0.1",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
};

const primaryInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
  label: Effect.succeed("Local environment"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeedSome(readyConfig),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

const backendConfigurationLayer = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Local environment"),
    currentBootstrapToken: Effect.succeed("current-window-token"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

const bootstrapsLayer = (instances: ReadonlyArray<DesktopBackendManager.DesktopBackendInstance>) =>
  Layer.merge(DesktopBackendPool.layerTest([...instances]), backendConfigurationLayer);

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("hands out the current window's token to a backend launched with the secret", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "primary",
          label: "Local environment",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "current-window-token",
        },
      ]);
    }).pipe(
      Effect.provide(
        bootstrapsLayer([
          {
            ...primaryInstance,
            currentConfig: Effect.succeedSome({
              ...readyConfig,
              bootstrap: {
                ...readyConfig.bootstrap,
                desktopBootstrapSecret: "desktop-secret",
              },
            }),
          },
        ]),
      ),
    ),
  );

  it.effect("omits a backend that has not resolved its configuration", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(
      Effect.provide(bootstrapsLayer([{ ...primaryInstance, currentConfig: Effect.succeedNone }])),
    ),
  );
});

describe("getRelayTelemetryEnabled", () => {
  it.effect("reads the desktop host opt-out before returning the renderer policy", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* getRelayTelemetryEnabled.handler().pipe(
          Effect.provideService(HostProcess.Environment, {
            T3CODE_TELEMETRY_ENABLED: "false",
          }),
        ),
      );
      assert.isTrue(
        yield* getRelayTelemetryEnabled
          .handler()
          .pipe(Effect.provideService(HostProcess.Environment, {})),
      );
    }),
  );
});

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "finds remote editors installed without PATH launchers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-editors-" });
      for (const app of ["Cursor", "Visual Studio Code", "WebStorm"]) {
        const executable = path.join(
          home,
          "Applications",
          `${app}.app`,
          app === "WebStorm" ? "Contents/MacOS/webstorm" : "Contents/Resources/app/bin/code",
        );
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        yield* fs.chmod(executable, 0o755);
      }
      const editors = yield* probeRemoteEditors.handler(undefined).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          PATH: path.join(home, "empty"),
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      assert.include(editors, "cursor");
      assert.include(editors, "vscode");
      assert.include(editors, "webstorm");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
