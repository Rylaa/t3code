// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as HostProcess from "./HostProcess.ts";
import * as Context from "effect/Context";
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    encoding: "utf8";
    timeout: number;
    detached?: true;
    stdio?: ["ignore", "pipe", "ignore"];
  },
) => string;

function canExecuteFile(filePath: string): boolean {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CommandAvailabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
}

export type CommandAvailabilityChecker = (
  command: string,
  options?: CommandAvailabilityOptions,
) => Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>;

export interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export type SpawnExecutableResolver = (
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => string | undefined;

function resolveSpawnExecutableWithNode(
  command: string,
  _platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const isExecutable = (candidate: string) => {
    try {
      return NodeFS.statSync(candidate).isFile() && canExecuteFile(candidate);
    } catch {
      return false;
    }
  };

  if (command.includes("/")) {
    return isExecutable(command) ? command : undefined;
  }

  for (const pathEntry of (env.PATH ?? "").split(":")) {
    const normalizedPathEntry = stripWrappingQuotes(pathEntry.trim());
    if (normalizedPathEntry.length === 0) continue;
    const candidatePath = NodePath.join(normalizedPathEntry, command);
    if (isExecutable(candidatePath)) return candidatePath;
  }
  return undefined;
}

export const SpawnExecutableResolution = Context.Reference<SpawnExecutableResolver>(
  "@t3tools/shared/shell/SpawnExecutableResolution",
  {
    defaultValue: () => resolveSpawnExecutableWithNode,
  },
);

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(NodeOS.userInfo().shell);
  } catch {
    return undefined;
  }
}

export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell = readUserLoginShell(),
): ReadonlyArray<string> {
  const fallbackShell = platform === "darwin" ? "/bin/zsh" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallbackShell]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = NodeChildProcess.execFileSync,
): string | undefined {
  try {
    return trimNonEmpty(
      execFile("/bin/launchctl", ["getenv", "PATH"], {
        encoding: "utf8",
        timeout: 2000,
      }),
    );
  } catch {
    return undefined;
  }
}

export function mergePathEntries(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
): string | undefined {
  const delimiter = ":";
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const pathValue of [preferredPath, inheritedPath]) {
    if (!pathValue) continue;
    for (const entry of pathValue.split(delimiter)) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry || seen.has(trimmedEntry)) {
        continue;
      }
      seen.add(trimmedEntry);
      merged.push(trimmedEntry);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function envCaptureStart(name: string): string {
  return `__T3CODE_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__T3CODE_ENV_${name}_END__`;
}

export function buildEnvironmentCaptureCommand(
  shell: string,
  names: ReadonlyArray<string>,
): string {
  const executableName = NodePath.basename(shell).toLowerCase();
  const isNushell = executableName.startsWith("nu");

  return names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      if (isNushell) {
        // Without a configured conversion, Nu expands home paths only in a list PATH.
        const defaultValue =
          name === "PATH"
            ? "if ($env.PATH? | describe | str starts-with 'list') { " +
              "$env.PATH | each {|p| if ($p | str starts-with '~') { " +
              "$p | path expand --no-symlink } else { $p } } | str join (char esep) " +
              "} else { $env.PATH? | default '' }"
            : `$env.${name}? | default ''`;
        const value =
          `if $env.${name}? == null { '' } else if ` +
          `$env.ENV_CONVERSIONS?.${name}?.to_string? != null { ` +
          `$env.${name} | do $env.ENV_CONVERSIONS.${name}.to_string $env.${name} ` +
          `} else { ${defaultValue} }`;
        return [
          `print '${envCaptureStart(name)}'`,
          `print (${value})`,
          `print '${envCaptureEnd(name)}'`,
        ].join("; ");
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");
}

function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  const value = output
    .slice(valueStartIndex, endIndex)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");

  return value.length > 0 ? value : undefined;
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

export const readEnvironmentFromLoginShell: ShellEnvironmentReader = (
  shell,
  names,
  execFile = NodeChildProcess.execFileSync,
) => {
  if (names.length === 0) {
    return {};
  }

  // Interactive startup loads PATH entries; detaching prevents job control on an
  // inherited controlling TTY from stopping the probe while the parent waits.
  const output = execFile(shell, ["-ilc", buildEnvironmentCaptureCommand(shell, names)], {
    encoding: "utf8",
    timeout: 5000,
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });

  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
};

export const CommandAvailability = Context.Reference<CommandAvailabilityChecker>(
  "@t3tools/shared/shell/CommandAvailability",
  {
    defaultValue: () => isCommandAvailable,
  },
);

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

// Explicit-path resolution is never cached - callers probe paths they have
// just written (e.g. managed binary installs). A "not-found" outcome is also
// cached for the TTL, so a just-installed binary can stay invisible for up to
// 30s unless resolved by explicit path.
const COMMAND_RESOLUTION_CACHE_TTL_NANOS = 30_000_000_000n;
const COMMAND_RESOLUTION_CACHE_MAX_ENTRIES = 512;
const COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR = String.fromCharCode(0);

interface CommandResolutionCacheEntry {
  readonly resolvedPath: string | null;
  readonly expiresAtNanos: bigint;
}

export const CommandResolutionCache = Context.Reference<Map<string, CommandResolutionCacheEntry>>(
  "@t3tools/shared/shell/CommandResolutionCache",
  {
    defaultValue: () => new Map(),
  },
);

interface PathDirectoryListing {
  readonly modified: number | null | undefined;
  readonly names: ReadonlySet<string> | undefined;
}

const directoryMtime = (directory: string) =>
  FileSystem.FileSystem.use((fileSystem) => fileSystem.stat(directory)).pipe(
    Effect.map((info) =>
      info.type === "Directory" ? Option.getOrUndefined(info.mtime)?.getTime() : undefined,
    ),
    Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound" ? null : undefined)),
  );

// Dated before it is read, so an entry added in between changes the mtime seen
// on the next check. Without names, lookups probe candidates directly.
const listPathDirectory = Effect.fnUntraced(function* (
  directory: string,
): Effect.fn.Return<PathDirectoryListing, never, FileSystem.FileSystem> {
  const modified = yield* directoryMtime(directory);
  if (modified == null) return { modified, names: modified === null ? new Set() : undefined };
  const entries = yield* FileSystem.FileSystem.use((fileSystem) =>
    fileSystem.readDirectory(directory),
  ).pipe(Effect.orElseSucceed(() => undefined));
  return { modified, names: entries && new Set(entries.map((entry) => entry.toLowerCase())) };
});

const PathDirectoryListings = Context.Reference<
  Cache.Cache<string, PathDirectoryListing, never, FileSystem.FileSystem> | undefined
>("@t3tools/shared/shell/PathDirectoryListings", { defaultValue: () => undefined });

export const withPathDirectoryListings =
  /* Directory reads are cached inside one shell operation; a span for each lookup adds noise. */
  Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    const listings = yield* Cache.make({
      capacity: 1024,
      lookup: listPathDirectory,
      requireServicesAt: "lookup",
    });
    return yield* effect.pipe(Effect.provideService(PathDirectoryListings, listings));
  });

// An injected resolver or locator may answer differently for the same search, so its
// entries are kept apart from every other resolver's.
let spawnResolverCacheIdCount = 0;
const spawnResolverCacheIds = new WeakMap<SpawnExecutableResolver | XcodeGitLocator, number>();
function spawnResolverCacheId(resolver: SpawnExecutableResolver | XcodeGitLocator): number {
  const known = spawnResolverCacheIds.get(resolver);
  if (known !== undefined) return known;
  const id = spawnResolverCacheIdCount++;
  spawnResolverCacheIds.set(resolver, id);
  return id;
}

function cacheCommandResolution(
  cache: Map<string, CommandResolutionCacheEntry>,
  cacheKey: string,
  resolvedPath: string | null,
  nowNanos: bigint,
): void {
  if (cache.size >= COMMAND_RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(cacheKey, {
    resolvedPath,
    expiresAtNanos: nowNanos + COMMAND_RESOLUTION_CACHE_TTL_NANOS,
  });
}

const isExecutableFile = Effect.fnUntraced(function* (
  filePath: string,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const stat = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (stat === null || stat.type !== "File") return false;
  return canExecuteFile(filePath);
});

export const resolveCommandPath = Effect.fn("shell.resolveCommandPath")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const env = options.env ?? (yield* HostProcess.Environment);

  if (command.includes("/")) {
    return (yield* isExecutableFile(command)) ? command : null;
  }

  const pathValue = env.PATH ?? "";
  if (pathValue.length === 0) {
    return null;
  }

  const cacheKey = [pathValue, command].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);
  const cache = yield* CommandResolutionCache;
  const nowNanos = yield* Clock.monotonicTimeNanos;
  const cached = cache.get(cacheKey);
  if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
    return cached.resolvedPath;
  }

  const pathEntries: string[] = [];
  const seenPathEntries = new Set<string>();
  for (const entry of pathValue.split(":")) {
    const pathEntry = stripWrappingQuotes(entry.trim());
    if (pathEntry.length === 0 || seenPathEntries.has(pathEntry)) continue;

    seenPathEntries.add(pathEntry);
    pathEntries.push(pathEntry);
  }

  const listings = yield* PathDirectoryListings;
  for (const pathEntry of pathEntries) {
    let listing = listings && (yield* Cache.get(listings, pathEntry));
    if (listings && listing?.names && listing.modified !== (yield* directoryMtime(pathEntry))) {
      yield* Cache.invalidate(listings, pathEntry);
      listing = yield* Cache.get(listings, pathEntry);
    }
    if (listing?.names && !listing.names.has(command.toLowerCase())) continue;
    const candidatePath = path.join(pathEntry, command);
    if (yield* isExecutableFile(candidatePath)) {
      cacheCommandResolution(cache, cacheKey, candidatePath, nowNanos);
      return candidatePath;
    }
  }
  cacheCommandResolution(cache, cacheKey, null, nowNanos);
  return null;
});

export type XcodeGitLocator = (env: NodeJS.ProcessEnv) => string | undefined;

// xcrun honors DEVELOPER_DIR and the `xcode-select` choice, as the shim does.
function locateXcodeGitWithXcrun(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const located = NodeChildProcess.execFileSync("/usr/bin/xcrun", ["--find", "git"], {
      encoding: "utf8",
      env,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return NodePath.isAbsolute(located) ? located : undefined;
  } catch {
    return undefined;
  }
}

export const XcodeGitLocation = Context.Reference<XcodeGitLocator>(
  "@t3tools/shared/shell/XcodeGitLocation",
  { defaultValue: () => locateXcodeGitWithXcrun },
);

const MACOS_GIT_SHIM = "/usr/bin/git";

/**
 * /usr/bin/git is an xcrun shim that finds the active developer directory on
 * every run: about 8 ms per spawn, against under 3 ms for the git behind it.
 * Only the shim is replaced, so a git the user put first on PATH (Homebrew,
 * Nix) still wins, and git's own children keep the same PATH. Any lookup
 * failure keeps plain `git`.
 */
const resolveMacosGit = Effect.fnUntraced(function* (
  env: NodeJS.ProcessEnv,
  resolveExecutable: SpawnExecutableResolver,
) {
  const locateXcodeGit = yield* XcodeGitLocation;
  const cache = yield* CommandResolutionCache;
  const cacheKey = [
    "xcode-git",
    String(spawnResolverCacheId(resolveExecutable)),
    String(spawnResolverCacheId(locateXcodeGit)),
    env.PATH ?? "",
    env.DEVELOPER_DIR ?? "",
  ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);
  const nowNanos = yield* Clock.currentTimeNanos;
  const cached = cache.get(cacheKey);
  // An Xcode update or removal deletes the binary; look again instead of failing the spawn.
  if (
    cached !== undefined &&
    cached.expiresAtNanos > nowNanos &&
    (cached.resolvedPath === null ||
      resolveExecutable(cached.resolvedPath, "darwin", env) !== undefined)
  ) {
    return cached.resolvedPath ?? "git";
  }
  const located =
    resolveExecutable("git", "darwin", env) === MACOS_GIT_SHIM ? locateXcodeGit(env) : undefined;
  const realGit =
    located !== undefined && resolveExecutable(located, "darwin", env) !== undefined
      ? located
      : null;
  cacheCommandResolution(cache, cacheKey, realGit, nowNanos);
  return realGit ?? "git";
});

export const resolveSpawnCommand = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandAvailabilityOptions = {},
): Effect.fn.Return<ResolvedSpawnCommand> {
  const platform = yield* HostProcess.Platform;
  if (platform !== "darwin" || command !== "git") {
    return { command, args: [...args], shell: false };
  }

  const hostEnvironment = yield* HostProcess.Environment;
  const env =
    options.env === undefined
      ? hostEnvironment
      : options.extendEnv
        ? { ...hostEnvironment, ...options.env }
        : options.env;
  const resolveExecutable = yield* SpawnExecutableResolution;
  return {
    command: yield* resolveMacosGit(env, resolveExecutable),
    args: [...args],
    shell: false,
  };
});

export const isCommandAvailable = Effect.fn("shell.isCommandAvailable")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return (yield* resolveCommandPath(command, options)) !== null;
});
