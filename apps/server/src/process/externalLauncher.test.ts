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
import * as TestClock from "effect/testing/TestClock";
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

it.effect("launches the default browser through open", () => {
  let spawned: ChildProcess.StandardCommand | undefined;
  let didUnref = false;
  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    yield* launcher.launchBrowser("https://example.com/some path");

    assert.ok(spawned);
    assert.equal(spawned.command, "open");
    assert.deepEqual(spawned.args, ["https://example.com/some path"]);
    assert.equal(spawned.options.detached, true);
    assert.equal(didUnref, true);
  }).pipe(
    Effect.provide(
      layerTest({
        onSpawn: (command) => {
          spawned = command;
        },
        onUnref: () => {
          didUnref = true;
        },
      }),
    ),
  );
});

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

it.effect("launches Cursor in classic IDE mode", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const cursorPath = path.join(binDir, "cursor");
    yield* fileSystem.writeFileString(cursorPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(cursorPath, 0o755);

    const spawned: ChildProcess.StandardCommand[] = [];
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      for (const cwd of [
        "/workspace with spaces",
        "/workspace with spaces/src/index.ts",
        "/workspace with spaces/src/index.ts:12",
        "/workspace with spaces/src/index.ts:12:4",
      ]) {
        yield* launcher.launchEditor({ editor: "cursor", cwd });
      }
    }).pipe(
      Effect.provide(
        layerTest({
          env: { PATH: binDir },
          onSpawn: (command) => spawned.push(command),
        }),
      ),
    );

    assert.deepEqual(
      spawned.map((command) => ({ command: command.command, args: command.args })),
      [
        { command: "cursor", args: ["--classic", "/workspace with spaces"] },
        { command: "cursor", args: ["--classic", "/workspace with spaces/src/index.ts"] },
        {
          command: "cursor",
          args: ["--classic", "--goto", "/workspace with spaces/src/index.ts:12"],
        },
        {
          command: "cursor",
          args: ["--classic", "--goto", "/workspace with spaces/src/index.ts:12:4"],
        },
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reveals a file in Finder with open -R on macOS", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const openPath = path.join(binDir, "open");
    yield* fileSystem.writeFileString(openPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(openPath, 0o755);

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "file-manager",
        cwd: "/workspace/media/linux-mini-v2.mp4",
        reveal: true,
      });
    }).pipe(
      Effect.provide(
        layerTest({
          env: { PATH: binDir },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, "open");
    assert.deepEqual(spawned.args, ["-R", "/workspace/media/linux-mini-v2.mp4"]);
    assert.equal(spawned.options.detached, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("discovers editors through the service API", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    for (const name of ["code", "open"]) {
      yield* fileSystem.writeFileString(path.join(binDir, name), "#!/bin/sh\n");
      yield* fileSystem.chmod(path.join(binDir, name), 0o755);
    }

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    }).pipe(Effect.provide(layerTest({ env: { PATH: binDir } })));

    assert.equal(editors.includes("vscode"), true);
    assert.equal(editors.includes("file-manager"), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  {
    installPath: "Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide",
    editor: "antigravity",
    args: ["--goto", "/workspace with spaces/file.ts:12:4"],
  },
  {
    installPath: "Applications/Cursor.app/Contents/Resources/app/bin/code",
    editor: "cursor",
    args: ["--classic", "--goto", "/workspace with spaces/file.ts:12:4"],
  },
  {
    installPath: "Applications/Kiro.app/Contents/Resources/app/bin/code",
    editor: "kiro",
    args: ["--goto", "/workspace with spaces/file.ts:12:4"],
  },
  {
    installPath: "Applications/WebStorm.app/Contents/MacOS/webstorm",
    editor: "webstorm",
    args: ["--line", "12", "--column", "4", "/workspace with spaces/file.ts"],
  },
  {
    installPath: "Applications/Zed.app/Contents/MacOS/cli",
    editor: "zed",
    args: ["/workspace with spaces/file.ts:12:4"],
  },
] as const)("discovers and launches $editor outside PATH", ({ installPath, editor, args }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor installs-" });
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
    assert.deepEqual(spawned.args, args);
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

it.effect("memoizes editor discovery and refreshes after the cache window", () => {
  let statCalls = 0;
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const layerLauncher = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.sync(() => {
              statCalls += 1;
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

    const first = yield* launcher.resolveAvailableEditors();
    assert.equal(first.includes("vscode"), true);
    const statCallsAfterFirstScan = statCalls;
    assert.isAbove(statCallsAfterFirstScan, 0);

    yield* TestClock.adjust("31 seconds");
    const second = yield* launcher.resolveAvailableEditors();
    assert.deepEqual([...second], [...first]);
    assert.equal(statCalls, statCallsAfterFirstScan);

    yield* TestClock.adjust("30 seconds");
    yield* launcher.resolveAvailableEditors();
    assert.isAbove(statCalls, statCallsAfterFirstScan);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerLauncher,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { PATH: "/t3-editor-discovery-cache-test" } }),
        ),
        TestClock.layer(),
      ),
    ),
  );
});

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

it.effect("passes line breaks through to editors started without a shell", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const zed = path.join(binDir, "zed");
    yield* fileSystem.writeFileString(zed, "#!/bin/sh\n");
    yield* fileSystem.chmod(zed, 0o755);
    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({ editor: "zed", cwd: "/workspace/odd\nname.ts" });
    }).pipe(
      Effect.provide(
        layerTest({
          env: { PATH: binDir, HOME: binDir },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );
    assert.ok(spawned);
    assert.deepEqual(spawned.args, ["/workspace/odd\nname.ts"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects unknown editors through the service API", () =>
  Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const error = yield* launcher
      .launchEditor({ editor: "missing-editor" as never, cwd: "/tmp/workspace" })
      .pipe(Effect.flip);
    assert.instanceOf(error, ExternalLauncher.ExternalLauncherUnknownEditorError);
    assert.equal(error.editor, "missing-editor");
    assert.equal(error.message, "Unknown editor: missing-editor");
  }).pipe(Effect.provide(layerTest({ env: { PATH: "" } }))),
);
