import type { DesktopCliCommandState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopCliCommandError extends Schema.TaggedError<DesktopCliCommandError>()(
  "DesktopCliCommandError",
  { message: Schema.String },
) {}

const defaultCandidateDirectories = (home: string): ReadonlyArray<string> => [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  `${home}/.local/bin`,
  `${home}/bin`,
];

const pathEntries = (value: string | undefined) =>
  (value ?? "").split(":").filter((entry) => entry.length > 0);

export class DesktopCliCommand extends Context.Service<
  DesktopCliCommand,
  {
    readonly state: Effect.Effect<DesktopCliCommandState>;
    readonly install: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
    readonly uninstall: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
  }
>()("@t3tools/desktop/app/DesktopCliCommand") {}

// Tests pass home-only folders so they never link into or remove from the machine's real bin folders.
export const makeWithCandidates = Effect.fn("DesktopCliCommand.makeWithCandidates")(function* (
  candidateDirectories: (home: string) => ReadonlyArray<string>,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = environment.path;
  const launcher = DesktopCliShim.launcherPath(environment);

  const fail = (message: string) => new DesktopCliCommandError({ message });
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const writableDirectory = (directory: string) =>
    fs.access(directory, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const isOurLink = Effect.fn("DesktopCliCommand.isOurLink")(
    function* (link: string) {
      yield* fs.readLink(link);
      // The launcher is a few KB; never read a large binary another `t3` links to.
      const info = yield* fs.stat(link);
      if (info.type !== "File" || Number(info.size) > 16_384) return false;
      const content = yield* fs.readFileString(link);
      return content.includes(DesktopCliShim.MARKER);
    },
    Effect.orElseSucceed(() => false),
  );

  const firstOnPath = Effect.gen(function* () {
    for (const directory of pathEntries(process.env.PATH)) {
      const candidate = path.join(directory, "t3");
      if (yield* exists(candidate)) return Option.some(candidate);
    }
    return Option.none<string>();
  });

  const foreignFirstOnPath = Effect.gen(function* () {
    const first = yield* firstOnPath;
    if (Option.isNone(first) || (yield* isOurLink(first.value))) return Option.none<string>();
    return first;
  });

  const installedAt = Effect.gen(function* () {
    for (const directory of candidateDirectories(environment.homeDirectory)) {
      const link = path.join(directory, "t3");
      if (yield* isOurLink(link)) return Option.some(link);
    }
    return Option.none<string>();
  });

  const state: DesktopCliCommand["Service"]["state"] = Effect.gen(function* () {
    if (!environment.isPackaged) {
      return { supported: false, installedPath: null, onPath: false } as const;
    }
    const installed = yield* installedAt;
    const shadowedBy = yield* foreignFirstOnPath;
    const shadow = Option.isSome(shadowedBy) ? { shadowedBy: shadowedBy.value } : {};
    if (Option.isNone(installed)) {
      return { supported: true, installedPath: null, onPath: false, ...shadow };
    }
    const first = yield* firstOnPath;
    const onPath = Option.isSome(first) && (yield* isOurLink(first.value));
    return { supported: true, installedPath: installed.value, onPath, ...shadow };
  }).pipe(Effect.orElseSucceed(() => ({ supported: false, installedPath: null, onPath: false })));

  const ensureLauncher = DesktopCliShim.install.pipe(
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(fail(`Could not set up the t3 launcher at ${launcher}.`)),
        onSome: () => Effect.void,
      }),
    ),
  );

  const install: DesktopCliCommand["Service"]["install"] = Effect.gen(function* () {
    if (!environment.isPackaged) return yield* fail("The t3 command needs an installed app.");
    yield* ensureLauncher;
    const existing = yield* installedAt;
    if (Option.isSome(existing)) {
      const target = yield* fs.readLink(existing.value).pipe(Effect.option);
      if (Option.getOrUndefined(target) === launcher) return yield* state;
      yield* fs
        .remove(existing.value)
        .pipe(Effect.mapError(() => fail(`Could not replace ${existing.value}.`)));
    }
    const shadowedBy = yield* foreignFirstOnPath;
    if (Option.isSome(shadowedBy)) {
      return yield* fail(
        `Another t3 at ${shadowedBy.value} runs first in a new terminal. Remove it, or run the launcher directly at ${launcher}.`,
      );
    }
    const onPath = pathEntries(process.env.PATH);
    const candidates = candidateDirectories(environment.homeDirectory);
    for (const directory of [
      ...candidates.filter((candidate) => onPath.includes(candidate)),
      ...candidates.filter((candidate) => !onPath.includes(candidate)),
    ]) {
      const link = path.join(directory, "t3");
      const created = (yield* exists(directory))
        ? yield* writableDirectory(directory)
        : yield* fs.makeDirectory(directory, { recursive: true }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
      if (!created) continue;
      const linked = yield* fs.symlink(launcher, link).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (linked) return yield* state;
    }
    return yield* fail(
      `Another t3 command is already installed, or no folder on your PATH is writable. Run the launcher directly at ${launcher}.`,
    );
  }).pipe(Effect.withSpan("desktop.cliCommand.install"));

  const uninstall: DesktopCliCommand["Service"]["uninstall"] = Effect.gen(function* () {
    for (const directory of candidateDirectories(environment.homeDirectory)) {
      const link = path.join(directory, "t3");
      if (yield* isOurLink(link)) {
        yield* fs.remove(link).pipe(Effect.mapError(() => fail(`Could not remove ${link}.`)));
      }
    }
    return yield* state;
  }).pipe(Effect.withSpan("desktop.cliCommand.uninstall"));

  return DesktopCliCommand.of({ state, install, uninstall });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = makeWithCandidates(defaultCandidateDirectories);

export const layer = Layer.effect(DesktopCliCommand, make);
