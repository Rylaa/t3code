import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ExternalLauncher from "./externalLauncher.ts";

interface MockSpawnResult {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stall?: boolean;
}

function makeMockDetachedHandle(input: MockSpawnResult & { readonly onUnref?: () => void } = {}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.stall
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      input.onUnref?.();
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout:
      input.stdout === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(input.stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const layerTest = (input: {
  readonly env?: Record<string, string>;
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
  readonly onUnref?: () => void;
  readonly spawnResult?: (command: ChildProcess.StandardCommand) => MockSpawnResult | undefined;
}) => {
  const layerSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        assert.equal(ChildProcess.isStandardCommand(command), true);
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("Expected a standard command");
        }
        input.onSpawn?.(command);
        return makeMockDetachedHandle({
          ...(input.onUnref === undefined ? {} : { onUnref: input.onUnref }),
          ...input.spawnResult?.(command),
        });
      }),
    ),
  );

  return Layer.mergeAll(
    ExternalLauncher.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, layerSpawner))),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
  );
};

it.effect("launched browsers and editors do not inherit ELECTRON_RUN_AS_NODE", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const codePath = path.join(binDir, "code");
    yield* fileSystem.writeFileString(codePath, "#!/bin/sh\n");
    yield* fileSystem.chmod(codePath, 0o755);

    const spawned: ChildProcess.StandardCommand[] = [];
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchBrowser("https://example.com");
      yield* launcher.launchEditor({ editor: "vscode", cwd: "/workspace" });
    }).pipe(
      Effect.provide(
        layerTest({
          env: { PATH: binDir },
          onSpawn: (command) => spawned.push(command),
        }),
      ),
      Effect.provideService(HostProcess.Environment, {
        PATH: binDir,
        ELECTRON_RUN_AS_NODE: "1",
      }),
    );

    assert.deepEqual(
      spawned.map((command) => ({
        command: command.command,
        env: command.options.env,
        extendEnv: command.options.extendEnv,
      })),
      ["open", "code"].map((command) => ({
        command,
        env: { PATH: binDir },
        extendEnv: false,
      })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["/workspace with spaces/", "/workspace with spaces/file.ts:12:4"])(
  "opens %s with the macOS Zed bundle when another zed is on PATH",
  (cwd) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-zed-collision-" });
      const executable = path.join(home, "Applications/Zed.app/Contents/MacOS/cli");
      const binDir = path.join(home, "zfs/bin");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(binDir, { recursive: true });
      for (const command of [executable, path.join(binDir, "zed")]) {
        yield* fs.writeFileString(command, "#!/bin/sh\n");
        yield* fs.chmod(command, 0o755);
      }

      let spawned: ChildProcess.StandardCommand | undefined;
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        assert.include(yield* launcher.resolveAvailableEditors(), "zed");
        yield* launcher.launchEditor({ editor: "zed", cwd });
      }).pipe(
        Effect.provide(
          layerTest({
            env: { HOME: home, PATH: binDir },
            onSpawn: (command) => {
              spawned = command;
            },
          }),
        ),
      );
      assert.ok(spawned);
      assert.equal(spawned.command, executable);
      assert.deepEqual(spawned.args, [cwd]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { editor: "webstorm", installPath: "Applications/WebStorm 2026.2.app/Contents/MacOS/webstorm" },
  { editor: "idea", installPath: "Applications/IntelliJ IDEA 2026.1.4.app/Contents/MacOS/idea" },
] as const)(
  "discovers and launches $editor from a versioned macOS bundle",
  ({ editor, installPath }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-versioned-" });
      const executable = path.join(home, installPath);
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "#!/bin/sh\n");
      yield* fs.chmod(executable, 0o755);

      let spawned: ChildProcess.StandardCommand | undefined;
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        assert.include(yield* launcher.resolveAvailableEditors(), editor);
        yield* launcher.launchEditor({ editor, cwd: "/workspace with spaces/file.ts:12:4" });
      }).pipe(
        Effect.provide(
          layerTest({
            env: { HOME: home, PATH: path.join(home, "empty") },
            onSpawn: (command) => {
              spawned = command;
            },
          }),
        ),
      );

      assert.ok(spawned);
      assert.equal(spawned.command, executable);
      assert.deepEqual(spawned.args, [
        "--line",
        "12",
        "--column",
        "4",
        "/workspace with spaces/file.ts",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("matches macOS bundles on the name boundary only", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const unrelatedHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-unrelated-" });
    const unrelated = path.join(
      unrelatedHome,
      "Applications/WebStormHelper.app/Contents/MacOS/webstorm",
    );
    yield* fs.makeDirectory(path.dirname(unrelated), { recursive: true });
    yield* fs.writeFileString(unrelated, "#!/bin/sh\n");
    yield* fs.chmod(unrelated, 0o755);

    const editorsFor = (home: string) =>
      Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        return yield* launcher.resolveAvailableEditors();
      }).pipe(Effect.provide(layerTest({ env: { HOME: home, PATH: path.join(home, "bin") } })));

    assert.notInclude(yield* editorsFor(unrelatedHome), "webstorm");

    const exactHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-exact-" });
    const exact = path.join(exactHome, "Applications/WebStorm.app/Contents/MacOS/webstorm");
    yield* fs.makeDirectory(path.dirname(exact), { recursive: true });
    yield* fs.writeFileString(exact, "#!/bin/sh\n");
    yield* fs.chmod(exact, 0o755);

    assert.include(yield* editorsFor(exactHome), "webstorm");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the macOS VS Code Insiders bundle out of stable VS Code", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-insiders-" });
    // The real Insiders bundle ships both `code-insiders` and `code`.
    const bin = path.join(
      home,
      "Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin",
    );
    yield* fs.makeDirectory(bin, { recursive: true });
    for (const name of ["code", "code-insiders"]) {
      yield* fs.writeFileString(path.join(bin, name), "#!/bin/sh\n");
      yield* fs.chmod(path.join(bin, name), 0o755);
    }

    let spawned: ChildProcess.StandardCommand | undefined;
    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      const available = yield* launcher.resolveAvailableEditors();
      yield* launcher.launchEditor({ editor: "vscode-insiders", cwd: "/workspace/file.ts" });
      return available;
    }).pipe(
      Effect.provide(
        layerTest({
          env: { HOME: home, PATH: path.join(home, "empty") },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.notInclude(editors, "vscode");
    assert.include(editors, "vscode-insiders");
    assert.equal(spawned?.command, path.join(bin, "code-insiders"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not report the agy CLI as the Antigravity IDE", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cli-" });
    const executable = path.join(home, ".local/bin/agy");
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
    yield* fs.writeFileString(executable, "#!/bin/sh\n");
    yield* fs.chmod(executable, 0o755);
    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    }).pipe(Effect.provide(layerTest({ env: { HOME: home, PATH: path.dirname(executable) } })));
    assert.notInclude(editors, "antigravity");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("ignores unusable app bundles and keeps PATH launchers first", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-priority-" });
    const executable = path.join(home, "Applications/Cursor.app/Contents/Resources/app/bin/code");
    const env = { HOME: home, PATH: path.join(home, "bin") };
    const discover = Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    });
    const before = yield* discover.pipe(Effect.provide(layerTest({ env })));
    yield* fs.makeDirectory(executable, { recursive: true });
    assert.deepEqual(yield* discover.pipe(Effect.provide(layerTest({ env }))), before);
    yield* fs.remove(executable, { recursive: true });
    yield* fs.writeFileString(executable, "#!/bin/sh\n");
    yield* fs.chmod(executable, 0o644);
    assert.deepEqual(yield* discover.pipe(Effect.provide(layerTest({ env }))), before);
    yield* fs.chmod(executable, 0o755);
    yield* fs.makeDirectory(env.PATH);
    yield* fs.writeFileString(path.join(env.PATH, "cursor"), "#!/bin/sh\n");
    yield* fs.chmod(path.join(env.PATH, "cursor"), 0o755);
    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({ editor: "cursor", cwd: "/workspace" });
    }).pipe(
      Effect.provide(
        layerTest({
          env: { ...env, PATH: `${env.PATH}:/usr/bin` },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );
    assert.equal(spawned?.command, "cursor");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps scanning after the caller is interrupted and shares that scan", () => {
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const release = Deferred.makeUnsafe<void>();
  let parkedStats = 0;
  const layerLauncher = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.gen(function* () {
              if (!Deferred.isDoneUnsafe(release)) {
                parkedStats += 1;
                yield* Deferred.await(release);
              }
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    const interrupted = yield* Effect.forkChild(launcher.resolveAvailableEditors());
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(interrupted);

    const next = yield* Effect.forkChild(launcher.resolveAvailableEditors());
    yield* Effect.yieldNow;
    assert.equal(parkedStats, 1);

    yield* Deferred.succeed(release, undefined);
    const editors = yield* Fiber.join(next);
    assert.equal(editors.includes("vscode"), true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerLauncher,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { PATH: "/t3-editor-discovery-interrupt-test" } }),
        ),
      ),
    ),
  );
});
