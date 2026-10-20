import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import {
  detectServerEnvironmentMachineKind,
  machineKindFromAppleProductName,
} from "./ServerEnvironmentMachine.ts";

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const layerProcessRunnerTest = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({ run: (input) => runMock(input) }),
);

const processOutput = (stdout: string, code = 0) =>
  Effect.succeed({
    stdout,
    stderr: "",
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });

afterEach(() => {
  runMock.mockReset();
});

describe("machineKindFromAppleProductName", () => {
  it("maps marketing names and model identifiers", () => {
    expect(machineKindFromAppleProductName("Mac mini (2024)")).toBe("mac-mini");
    expect(machineKindFromAppleProductName("Macmini8,1")).toBe("mac-mini");
    expect(machineKindFromAppleProductName("Mac Studio (2023)")).toBe("mac-studio");
    expect(machineKindFromAppleProductName("MacBook Pro (14-inch, 2024)")).toBe("laptop");
    expect(machineKindFromAppleProductName("MacBookAir10,1")).toBe("laptop");
    expect(machineKindFromAppleProductName("iMac (24-inch, 2024)")).toBe("desktop");
    expect(machineKindFromAppleProductName("Mac Pro (2023)")).toBe("desktop");
  });

  it("returns null for Apple silicon model identifiers, which carry no product family", () => {
    expect(machineKindFromAppleProductName("Mac16,10")).toBeNull();
  });
});

describe("detectServerEnvironmentMachineKind", () => {
  it.effect("reads the IOKit product name on macOS", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        processOutput(
          '+-o product  <class IOPlatformDevice>\n    {\n      "product-name" = <"Mac mini (2024)">\n    }\n',
        ),
      );

      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(layerProcessRunnerTest),
      );

      expect(result).toBe("mac-mini");
      expect(runMock).toHaveBeenCalledTimes(1);
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "ioreg", args: ["-rd1", "-n", "product"] }),
      );
    }),
  );

  it.effect("falls back to hw.model when IOKit has no product node", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(processOutput("", 1));
      runMock.mockReturnValueOnce(processOutput("MacBookPro16,1\n"));

      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(layerProcessRunnerTest),
      );

      expect(result).toBe("laptop");
      expect(runMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: "sysctl", args: ["-n", "hw.model"] }),
      );
    }),
  );

  it.effect("returns null when both macOS probes fail", () =>
    Effect.gen(function* () {
      runMock.mockImplementation((input) =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: new Error("ENOENT"),
          }),
        ),
      );

      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(layerProcessRunnerTest),
      );

      expect(result).toBeNull();
      expect(runMock).toHaveBeenCalledTimes(2);
    }),
  );
});
