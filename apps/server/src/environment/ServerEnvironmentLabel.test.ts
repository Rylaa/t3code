import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerEnvironmentLabel from "./ServerEnvironmentLabel.ts";

const isServerEnvironmentLabelCommandError = Schema.is(
  ServerEnvironmentLabel.ServerEnvironmentLabelCommandError,
);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const layerProcessRunnerTest = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({
    run: (input) => runMock(input),
  }),
);
const withHostname = (hostname: string) =>
  Layer.merge(layerProcessRunnerTest, Layer.succeed(HostProcess.Hostname, hostname));

afterEach(() => {
  runMock.mockReset();
});

describe("resolveServerEnvironmentLabel", () => {
  it.effect("prefers the macOS ComputerName", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.succeed({
          stdout: " Julius's MacBook Pro \n",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
      );

      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostname("macbook-pro")));

      expect(result).toBe("Julius's MacBook Pro");
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "scutil",
          args: ["--get", "ComputerName"],
          timeoutBehavior: "timedOutResult",
        }),
      );
    }),
  );

  it.effect("falls back to the hostname when friendly labels are unavailable", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.succeed({
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(1),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
      );
      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostname("JULIUS-LAPTOP")));

      expect(result).toBe("JULIUS-LAPTOP");
    }),
  );

  it.effect("falls back to the hostname when the friendly-label command is missing", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });
    const spawnCause = new Error("spawn scutil ENOENT");
    const processError = new ProcessRunner.ProcessSpawnError({
      command: "scutil",
      argumentCount: 2,
      cause: spawnCause,
    });
    runMock.mockReturnValueOnce(Effect.fail(processError));

    return Effect.gen(function* () {
      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      });

      expect(result).toBe("macbook-pro");
      expect(logs[0]?.message).toEqual([
        "Failed to run environment-label probe 'macos-computer-name' with scutil.",
      ]);
      const error = logs[0]?.annotations.cause;
      expect(isServerEnvironmentLabelCommandError(error)).toBe(true);
      if (isServerEnvironmentLabelCommandError(error)) {
        expect(error.probe).toBe("macos-computer-name");
        expect(error.executable).toBe("scutil");
        expect(error.argumentCount).toBe(2);
        expect(error).not.toHaveProperty("args");
        expect(error.message).not.toContain("--get");
        expect(error.message).not.toContain("ComputerName");
        expect(error.cause).toBe(processError);
        expect(processError.cause).toBe(spawnCause);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          withHostname("macbook-pro"),
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Debug"),
        ),
      ),
    );
  });

  it.effect("falls back to the cwd basename when the hostname is blank", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.succeed({
          stdout: " ",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
      );

      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostname("   ")));

      expect(result).toBe("t3code");
    }),
  );
});
