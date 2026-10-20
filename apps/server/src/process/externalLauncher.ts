import {
  EDITORS,
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  type EditorId,
  type FileManagerRevealKind,
  type LaunchEditorInput,
} from "@t3tools/contracts";
import { resolveEditorCommand } from "@t3tools/shared/editor";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isCommandAvailable, withPathDirectoryListings } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export {
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
} from "@t3tools/contracts";
export type { LaunchEditorInput };
interface EditorLaunch {
  readonly editor: EditorId;
  readonly target: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface ProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

interface TargetPathAndPosition {
  readonly path: string;
  readonly line: string;
  readonly column: Option.Option<string>;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

const DETACHED_IGNORE_STDIO_OPTIONS = {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

const CommandLookupEnvConfig = Config.all({
  PATH: Config.String("PATH").pipe(Config.option),
  HOME: Config.String("HOME").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

function parseTargetPathAndPosition(target: string): Option.Option<TargetPathAndPosition> {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return Option.none();
  }

  return Option.some({
    path: match[1],
    line: match[2],
    column: Option.fromUndefinedOr(match[3]),
  });
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return Option.isSome(parsedTarget) ? ["--goto", target] : [target];
    case "line-column":
      return Option.match(parsedTarget, {
        onNone: () => [target],
        onSome: ({ path, line, column }) => [
          "--line",
          line,
          ...Option.match(column, {
            onNone: () => [],
            onSome: (value) => ["--column", value],
          }),
          path,
        ],
      });
  }
}

const FILE_MANAGER_COMMAND = "open";

function buildBrowserLaunch(target: string): ProcessLaunch {
  return {
    command: "open",
    args: [target],
    options: DETACHED_IGNORE_STDIO_OPTIONS,
  };
}

const buildAvailableEditors = Effect.fn("externalLauncher.buildAvailableEditors")(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<EditorId>, never, FileSystem.FileSystem | Path.Path> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.commands === null) {
      if (yield* isCommandAvailable(FILE_MANAGER_COMMAND, { env })) {
        available.push(editor.id);
      }
      continue;
    }

    const command = yield* resolveEditorCommand(editor, env);
    if (Option.isSome(command)) {
      available.push(editor.id);
    }
  }

  return available;
});

const resolveAvailableEditors = Effect.fn("externalLauncher.resolveAvailableEditors")(function* () {
  const env = yield* readCommandLookupEnv;
  return yield* buildAvailableEditors(env).pipe(withPathDirectoryListings);
});

// Callers apply a timeout (`resolveAvailableEditorsForConfig`) and disconnect
// mid-connect; neither may cancel a scan other connects are waiting on, or
// throw away work a slow host (a busy server at startup, a long PATH) needs
// more than one connect to finish. Expiry uses the monotonic clock
// (Clock.monotonicTimeNanos), matching the command-resolution cache in
// @t3tools/shared/shell, so a backward wall-clock adjustment cannot keep an
// expired entry alive.
const EDITOR_DISCOVERY_CACHE_TTL_NANOS = 60_000_000_000n;

interface EditorDiscoveryCacheEntry {
  readonly scan: Deferred.Deferred<ReadonlyArray<EditorId>>;
  readonly expiresAtNanos: bigint | undefined;
}

export class ExternalLauncher extends Context.Service<
  ExternalLauncher,
  {
    readonly resolveAvailableEditors: () => Effect.Effect<ReadonlyArray<EditorId>>;
    /** Only meaningful when `resolveAvailableEditors` includes "file-manager". */
    readonly resolveFileManagerRevealKind: () => Effect.Effect<FileManagerRevealKind | undefined>;
    readonly launchBrowser: (target: string) => Effect.Effect<void, ExternalLauncherError>;
    readonly launchEditor: (input: LaunchEditorInput) => Effect.Effect<void, ExternalLauncherError>;
  }
>()("t3/process/externalLauncher") {}

const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: LaunchEditorInput,
): Effect.fn.Return<EditorLaunch, ExternalLauncherError, FileSystem.FileSystem | Path.Path> {
  const env = yield* readCommandLookupEnv;
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.editor": input.editor,
    "externalLauncher.cwd": input.cwd,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new ExternalLauncherUnknownEditorError({ editor: input.editor });
  }

  if (editorDef.commands) {
    const { command, baseArgs } = Option.getOrElse(
      yield* resolveEditorCommand(editorDef, env),
      () => ({
        command: editorDef.commands[0],
        baseArgs: "baseArgs" in editorDef ? editorDef.baseArgs : [],
      }),
    );
    return {
      editor: editorDef.id,
      target: input.cwd,
      command,
      args: [...baseArgs, ...resolveCommandEditorArgs(editorDef, input.cwd)],
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  if (!(yield* isCommandAvailable(FILE_MANAGER_COMMAND, { env }))) {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  return {
    editor: editorDef.id,
    target: input.cwd,
    command: FILE_MANAGER_COMMAND,
    args: input.reveal === true ? ["-R", input.cwd] : [input.cwd],
  };
});

const launchAndUnref = Effect.fn("externalLauncher.launchAndUnref")(function* (
  launch: ProcessLaunch,
  onError: (cause: unknown) => ExternalLauncherError,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The desktop app runs this server with ELECTRON_RUN_AS_NODE. A launched file
  // manager or browser passes its environment on to everything started from it,
  // so any Electron app opened from there would start as plain Node and exit.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = yield* HostProcess.Environment;
  const command = ChildProcess.make(launch.command, launch.args, {
    ...launch.options,
    env,
    extendEnv: false,
  });

  yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
    Effect.mapError(onError),
  );
});

const launchBrowser = Effect.fn("externalLauncher.launchBrowser")(function* (
  target: string,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const launch = buildBrowserLaunch(target);
  return yield* launchAndUnref(
    launch,
    (cause) =>
      new ExternalLauncherBrowserSpawnError({
        target,
        command: launch.command,
        args: launch.args,
        cause,
      }),
  );
});

const launchEditorProcess = Effect.fn("externalLauncher.launchEditorProcess")(function* (
  launch: EditorLaunch,
): Effect.fn.Return<
  void,
  ExternalLauncherError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const env = yield* readCommandLookupEnv;
  if (!(yield* isCommandAvailable(launch.command, { env }))) {
    return yield* new ExternalLauncherCommandNotFoundError({
      editor: launch.editor,
      command: launch.command,
    });
  }

  yield* launchAndUnref(
    { command: launch.command, args: launch.args, options: DETACHED_IGNORE_STDIO_OPTIONS },
    (cause) =>
      new ExternalLauncherEditorSpawnError({
        editor: launch.editor,
        target: launch.target,
        command: launch.command,
        args: launch.args,
        cause,
      }),
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const provideCommandResolutionServices = <A, E, R>(
    effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const scope = yield* Scope.Scope;
  const editorDiscoveryCache = yield* Ref.make<Option.Option<EditorDiscoveryCacheEntry>>(
    Option.none(),
  );
  const runEditorDiscovery = (scan: Deferred.Deferred<ReadonlyArray<EditorId>>) =>
    provideCommandResolutionServices(resolveAvailableEditors()).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const expiresAtNanos =
            (yield* Clock.monotonicTimeNanos) + EDITOR_DISCOVERY_CACHE_TTL_NANOS;
          yield* Ref.update(editorDiscoveryCache, (current) =>
            Option.isNone(current) || current.value.scan !== scan
              ? current
              : Exit.isSuccess(exit)
                ? Option.some({ scan, expiresAtNanos })
                : Option.none(),
          );
          yield* Deferred.done(scan, exit);
        }),
      ),
      Effect.interruptible,
      Effect.forkIn(scope),
    );
  // Claiming the cache entry and starting its scan must not be split by an
  // interrupt, or the entry would wait on a scan that never runs.
  const acquireEditorDiscovery = Effect.gen(function* () {
    const nowNanos = yield* Clock.monotonicTimeNanos;
    const [scan, isNewScan] = yield* Ref.modify(
      editorDiscoveryCache,
      (
        current,
      ): [
        [EditorDiscoveryCacheEntry["scan"], boolean],
        Option.Option<EditorDiscoveryCacheEntry>,
      ] => {
        if (
          Option.isSome(current) &&
          (current.value.expiresAtNanos === undefined || current.value.expiresAtNanos > nowNanos)
        ) {
          return [[current.value.scan, false], current];
        }
        const scan = Deferred.makeUnsafe<ReadonlyArray<EditorId>>();
        return [[scan, true], Option.some({ scan, expiresAtNanos: undefined })];
      },
    );
    if (isNewScan) {
      yield* runEditorDiscovery(scan);
    }
    return scan;
  }).pipe(Effect.uninterruptible);
  const cachedAvailableEditors = Effect.flatMap(acquireEditorDiscovery, Deferred.await);

  return ExternalLauncher.of({
    resolveAvailableEditors: () => cachedAvailableEditors,
    resolveFileManagerRevealKind: () => Effect.succeed("finder"),
    launchBrowser: (target) =>
      launchBrowser(target).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    launchEditor: (input) =>
      provideCommandResolutionServices(
        Effect.flatMap(resolveEditorLaunch(input), launchEditorProcess),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  });
});

export const layer = Layer.effect(ExternalLauncher, make);
