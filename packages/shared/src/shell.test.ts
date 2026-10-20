import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CommandResolutionCache,
  isCommandAvailable,
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readPathFromLaunchctl,
  resolveCommandPath,
  resolveSpawnCommand,
  withPathDirectoryListings,
} from "./shell.ts";

const recordCommandTrace = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const result = yield* effect.pipe(Effect.withTracer(tracer), Effect.result);
  return { result, spans };
});

describe("readEnvironmentFromLoginShell probe", () => {
  it("uses a shell-agnostic printenv PATH probe", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__T3CODE_ENV_PATH_START__\n/a:/b\n__T3CODE_ENV_PATH_END__\n");

    expect(readEnvironmentFromLoginShell("/opt/homebrew/bin/fish", ["PATH"], execFile).PATH).toBe(
      "/a:/b",
    );
    expect(execFile).toHaveBeenCalledTimes(1);

    const firstCall = execFile.mock.calls[0] as
      | [string, ReadonlyArray<string>, { encoding: "utf8"; timeout: number }]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected execFile to be called");
    }

    const [shell, args, options] = firstCall;
    expect(shell).toBe("/opt/homebrew/bin/fish");
    expect(args).toHaveLength(2);
    expect(args?.[0]).toBe("-ilc");
    expect(args?.[1]).toContain("printenv PATH || true");
    expect(args?.[1]).toContain("__T3CODE_ENV_PATH_START__");
    expect(args?.[1]).toContain("__T3CODE_ENV_PATH_END__");
    expect(options).toEqual({ encoding: "utf8", timeout: 5000 });
  });
});

describe("readPathFromLaunchctl", () => {
  it("returns a trimmed PATH value from launchctl", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "  /opt/homebrew/bin:/usr/bin  \n");

    expect(readPathFromLaunchctl(execFile)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(execFile).toHaveBeenCalledWith("/bin/launchctl", ["getenv", "PATH"], {
      encoding: "utf8",
      timeout: 2000,
    });
  });

  it("returns undefined when launchctl is unavailable", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => {
      throw new Error("spawn /bin/launchctl ENOENT");
    });

    expect(readPathFromLaunchctl(execFile)).toBeUndefined();
  });
});

describe("readEnvironmentFromLoginShell", () => {
  it("extracts multiple environment variables from a login shell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "/tmp/secretive.sock",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("omits environment variables that are missing or empty", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
    });
  });

  it("preserves surrounding whitespace in captured values", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      ["__T3CODE_ENV_CUSTOM_VAR_START__", "  padded value  ", "__T3CODE_ENV_CUSTOM_VAR_END__"].join(
        "\n",
      ),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  padded value  ",
    });
  });
});

describe("listLoginShellCandidates", () => {
  it("returns env shell, user shell, then the platform fallback without duplicates", () => {
    expect(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
    ]);
  });

  it("falls back to the platform default when no shells are available", () => {
    expect(listLoginShellCandidates("darwin", undefined, "")).toEqual(["/bin/zsh"]);
  });
});

describe("mergePathEntries", () => {
  it("prefers login-shell PATH entries and keeps inherited extras", () => {
    expect(mergePathEntries("/opt/homebrew/bin:/usr/bin", "/Users/test/.local/bin:/usr/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin",
    );
  });
});

effectIt.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("records missing optional commands as successful lookups", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-trace-" });
      const env = { PATH: cwd };
      const checks = [
        isCommandAvailable("missing", { env }),
        isCommandAvailable("missing", { env }),
        isCommandAvailable("missing", { env: { ...env, PATH: "" } }),
        isCommandAvailable(path.join(cwd, "missing"), { env }),
      ];
      for (const check of checks) {
        const { result, spans } = yield* recordCommandTrace(check);
        expect(Result.getOrThrow(result)).toBe(false);
        expect(spans.length).toBeGreaterThan(0);
        for (const span of spans) {
          expect(span.status._tag).toBe("Ended");
          if (span.status._tag === "Ended") {
            expect(Exit.isSuccess(span.status.exit), span.name).toBe(true);
          }
        }
      }
    }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
  );

  it.effect("records available commands as successful lookups", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-trace-" });
      const executable = path.join(cwd, "available");
      yield* fs.writeFileString(executable, "");
      yield* fs.chmod(executable, 0o700);
      const env = { PATH: cwd };
      for (const command of ["available", executable]) {
        const { result, spans } = yield* recordCommandTrace(isCommandAvailable(command, { env }));
        expect(Result.getOrThrow(result)).toBe(true);
        expect(spans.length).toBeGreaterThan(0);
        for (const span of spans) {
          expect(span.status._tag).toBe("Ended");
          if (span.status._tag === "Ended") {
            expect(Exit.isSuccess(span.status.exit), span.name).toBe(true);
          }
        }
      }
    }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
  );

  it.effect("returns false when PATH is empty", () =>
    Effect.gen(function* () {
      expect(yield* isCommandAvailable("definitely-not-installed", { env: { PATH: "" } })).toBe(
        false,
      );
    }),
  );
});

effectIt.layer(NodeServices.layer)("resolveCommandPath", (it) => {
  it.effect("records a successful lookup when a command is missing", () =>
    Effect.gen(function* () {
      const { result, spans } = yield* recordCommandTrace(
        resolveCommandPath("missing", { env: { PATH: "" } }),
      );
      expect(Result.getOrThrow(result)).toBeNull();
      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) {
        expect(span.status._tag).toBe("Ended");
        if (span.status._tag === "Ended") {
          expect(Exit.isSuccess(span.status.exit), span.name).toBe(true);
        }
      }
    }),
  );

  it.effect("returns null when PATH is empty", () =>
    Effect.gen(function* () {
      const result = yield* resolveCommandPath("definitely-not-installed", { env: { PATH: "" } });

      expect(result).toBeNull();
    }),
  );

  const recordProbes = (env: NodeJS.ProcessEnv) =>
    Effect.gen(function* () {
      const probed: Array<string> = [];
      const result = yield* resolveCommandPath("definitely-not-installed", { env }).pipe(
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provide(
          FileSystem.layerNoop({
            stat: (filePath) =>
              Effect.sync(() => {
                probed.push(filePath);
                return { type: "Directory" } as FileSystem.File.Info;
              }),
          }),
        ),
      );

      expect(result).toBeNull();
      return probed;
    });

  it.effect("visits a repeated PATH directory only once", () =>
    Effect.gen(function* () {
      const probed = yield* recordProbes({ PATH: "/bin:/other:/bin:/other" });

      expect(probed).toHaveLength(2);
      expect(new Set(probed).size).toBe(probed.length);
    }),
  );

  it.effect("still visits a PATH entry that differs only in case", () =>
    Effect.gen(function* () {
      const probed = yield* recordProbes({ PATH: "/bin:/BIN" });

      // A case-sensitive volume can hold both spellings, so skipping the
      // second could hide a command that is really there.
      expect(probed).toHaveLength(2);
    }),
  );

  it.effect("keeps cached misses until expiry while allowing explicit paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-path-cache-" });
      const executable = path.join(cwd, "appeared");
      const options = { env: { PATH: `${cwd}:${cwd}` } };

      expect(yield* resolveCommandPath("appeared", options)).toBeNull();
      yield* fs.writeFileString(executable, "");
      yield* fs.chmod(executable, 0o755);
      expect(yield* resolveCommandPath("appeared", options)).toBeNull();
      expect(yield* resolveCommandPath(executable, options)).toBe(executable);
      yield* TestClock.adjust("30 seconds");
      expect(yield* resolveCommandPath("appeared", options)).toBe(executable);
    }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
  );

  it.effect("probes only listed PATH names and relists a directory that changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* fs.makeTempDirectoryScoped();
      const second = yield* fs.makeTempDirectoryScoped();
      const writeExecutable = (filePath: string) =>
        fs.writeFileString(filePath, "").pipe(Effect.andThen(fs.chmod(filePath, 0o755)));
      yield* writeExecutable(path.join(first, "cursor"));
      yield* writeExecutable(path.join(second, "cursor"));
      const env = { PATH: `${first}:${second}` };
      const probed: Array<string> = [];
      yield* Effect.gen(function* () {
        expect(yield* resolveCommandPath("cursor", { env })).toBe(path.join(first, "cursor"));
        expect(yield* isCommandAvailable("absent", { env })).toBe(false);
        yield* writeExecutable(path.join(second, "late"));
        yield* fs.utimes(second, 4_102_444_800, 4_102_444_800);
        expect(yield* resolveCommandPath("late", { env })).toBe(path.join(second, "late"));
      }).pipe(
        withPathDirectoryListings,
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (file) => {
            if (file !== first && file !== second) probed.push(file);
            return fs.stat(file);
          },
        }),
      );
      expect(probed).toEqual([path.join(first, "cursor"), path.join(second, "late")]);
    }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
  );
});

effectIt.layer(NodeServices.layer)("resolveSpawnCommand", (it) => {
  it.effect("spawns the command directly without a shell", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("missing & calc", ["unsafe & value"], {
        env: { PATH: "" },
      });

      expect(command).toEqual({
        command: "missing & calc",
        args: ["unsafe & value"],
        shell: false,
      });
    }),
  );
});
