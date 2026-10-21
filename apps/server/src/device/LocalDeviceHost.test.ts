import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NetService from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  agentDeviceStateDir,
} from "./DeviceToolchain.ts";

const processOutput = (code: number, stdout = "", stderr = "", timedOut = false) => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout,
  stderr,
  timedOut,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const agentFixture = Effect.fn("agentFixture")(function* (
  startup: (
    stateDir: string,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  avdOutput: ProcessRunner.ProcessRunOutput = processOutput(0),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-agent-start-" });
  const stateDir = agentDeviceStateDir(path, path.join(baseDir, "userdata"));
  for (const [name, version, entry] of [
    ["expo-device-hub", DEVICE_HUB_VERSION, "dist/server/cli.mjs"],
    ["agent-device", AGENT_DEVICE_VERSION, "bin/agent-device.mjs"],
  ]) {
    const installDir = path.join(baseDir, "tools", name!, version!);
    const entryPath = path.join(installDir, "node_modules", name!, entry!);
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(entryPath, "");
    yield* fs.writeFileString(path.join(installDir, ".install-complete"), version!);
  }
  const host = yield* LocalDeviceHost.make().pipe(
    Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
    Effect.provideService(HostProcess.Environment, { HOME: baseDir, PATH: "" }),
    Effect.provideService(HostProcess.IsExecutable, false),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(123),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      ),
    ),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) =>
        input.args.includes("devices")
          ? startup(stateDir)
          : Effect.succeed(input.args.includes("-list-avds") ? avdOutput : processOutput(0)),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
      ),
    ),
  );
  yield* host.ensureReady(() => Effect.void);
  return { host, fs, stateDir };
});

describe("AgentDevice startup", () => {
  it.effect("reports an incompatible lock immediately and retains it for manual repair", () =>
    Effect.gen(function* () {
      const result = processOutput(
        1,
        JSON.stringify({
          success: false,
          error: {
            message: "private command output",
            details: {
              reason: "daemon_registration_unproven",
              inspection: { state: "unproven", reason: "non-directory" },
            },
          },
        }),
      );
      const { host, fs, stateDir } = yield* agentFixture(() => Effect.succeed(result));
      const lock = `${stateDir}/daemon.lock`;
      const legacyOwner = JSON.stringify({ pid: 85669, processStartTime: "old start time" });
      yield* fs.writeFileString(lock, legacyOwner);
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AgentDeviceStartError",
        reason: "daemon_lock_not_directory",
        exitCode: 1,
        cause: result,
      });
      expect(error.message).toContain("Daemon registration ownership could not be verified");
      expect(error.message).toContain("daemon.lock is not a directory");
      expect(error.message).toContain(stateDir);
      expect(error.message).toContain("original CLI");
      expect(error.message).not.toContain("private command output");
      expect(yield* fs.readFileString(lock)).toBe(legacyOwner);
      expect(yield* host.current).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports unknown nonzero exits without exposing arbitrary command output", () =>
    Effect.gen(function* () {
      const result = processOutput(2, "invalid JSON", "private credentials");
      const { host, stateDir } = yield* agentFixture(() => Effect.succeed(result));
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AgentDeviceStartError",
        reason: "command_failed",
        exitCode: 2,
        cause: result,
      });
      expect(error.message).toContain("exit code 2");
      expect(error.message).toContain(stateDir);
      expect(error.message).not.toContain("private credentials");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves process execution failures instead of waiting for a daemon file", () =>
    Effect.gen(function* () {
      const cause = new ProcessRunner.ProcessSpawnError({
        command: "/missing/node",
        argumentCount: 3,
        cause: new Error("missing executable"),
      });
      const { host } = yield* agentFixture(() => Effect.fail(cause));
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DeviceHostError",
        step: "starting agent tools",
        cause,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses a registered daemon when reading startup command output fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cause = new ProcessRunner.ProcessReadError({
        command: process.execPath,
        argumentCount: 3,
        stream: "stdout",
        cause: new Error("output read failed after registration"),
      });
      let attempts = 0;
      const { host } = yield* agentFixture((stateDir) =>
        Effect.gen(function* () {
          attempts++;
          yield* fs
            .writeFileString(
              `${stateDir}/daemon.json`,
              JSON.stringify({ httpPort: 12345, token: "test-token" }),
            )
            .pipe(Effect.orDie);
          return yield* cause;
        }),
      );
      const ready = yield* host.ensureAgentReady(() => Effect.void);
      expect(ready.agentDevice).toMatchObject({
        baseUrl: "http://127.0.0.1:12345",
        token: "test-token",
      });
      expect((yield* host.ensureAgentReady(() => Effect.void)).agentDevice).toEqual(
        ready.agentDevice,
      );
      expect(attempts).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const diagnose = (files: ReadonlyArray<string>, environment: NodeJS.ProcessEnv) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(NodePath.layerPosix),
  );

describe("Android SDK availability", () => {
  // regression: #12017 detect unsupported legacy Android command-line tools
  it.effect("explains how to upgrade legacy command-line tools in the standard macOS SDK", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [`${root}/platform-tools/adb`, `${root}/emulator/emulator`, `${root}/tools/bin/avdmanager`],
        { HOME: "/test/home" },
      );
      expect(reason).toContain("older, unsupported version");
      expect(reason).toContain(root);
      expect(reason).toContain(
        "Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.",
      );
    }),
  );

  it.effect("accepts the latest command-line tools when legacy tools are also installed", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "/sdk/platform-tools/adb",
          "/sdk/emulator/emulator",
          "/sdk/tools/bin/avdmanager",
          "/sdk/cmdline-tools/latest/bin/avdmanager",
        ],
        { ANDROID_HOME: "/sdk" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("discovers the standard macOS SDK without ANDROID_HOME", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [
          `${root}/platform-tools/adb`,
          `${root}/emulator/emulator`,
          `${root}/cmdline-tools/latest/bin/avdmanager`,
        ],
        { HOME: "/test/home" },
      );
      expect(reason).toBeNull();
    }),
  );
});

it.effect.each([
  {
    name: "old SDK",
    front: "emulated webcam<N> none",
    back: "emulated virtualscene none",
    code: 0,
    extra: undefined,
    expected: "-camera-front emulated -camera-back emulated",
  },
  {
    name: "imagefile-capable SDK",
    front: "emulated imagefile:<path> none",
    back: "emulated imagefile:<path> none",
    code: 0,
    extra: undefined,
    expected: undefined,
  },
  {
    name: "user overrides",
    front: "emulated none",
    back: "emulated none",
    code: 0,
    extra: "-memory 4096 -camera-front none",
    expected: "-camera-front emulated -camera-back emulated -memory 4096 -camera-front none",
  },
  {
    name: "different camera capabilities",
    front: "emulated none",
    back: "emulated imagefile:<path> none",
    code: 0,
    extra: undefined,
    expected: "-camera-front emulated",
  },
  {
    name: "failed help probe",
    front: "emulated none",
    back: "emulated none",
    code: 1,
    extra: undefined,
    expected: undefined,
  },
])("configures supported emulator cameras for $name", ({ front, back, code, extra, expected }) =>
  Effect.gen(function* () {
    const result = yield* LocalDeviceHost.__testing
      .hubEnvironment({ ANDROID_HOME: "/sdk", EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS: extra })
      .pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            expect(input.command).toBe("/sdk/emulator/emulator");
            expect(input.args[0]).toMatch(/^-help-camera-(front|back)$/);
            return Effect.succeed(
              processOutput(code, input.args[0] === "-help-camera-front" ? front : back),
            );
          },
        }),
        Effect.provide(NodeServices.layer),
      );
    expect(result.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS).toBe(expected);
  }),
);

it.effect("keeps local Android and iOS available without ffmpeg", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-ffmpeg-" });
    yield* fs.makeDirectory(`${baseDir}/bin`);
    yield* fs.writeFileString(`${baseDir}/bin/xcrun`, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(`${baseDir}/bin/xcrun`, 0o755);
    for (const [directory, tool] of [
      ["platform-tools", "adb"],
      ["emulator", "emulator"],
      ["cmdline-tools/latest/bin", "avdmanager"],
    ]) {
      yield* fs.makeDirectory(`${baseDir}/sdk/${directory}`, { recursive: true });
      yield* fs.writeFileString(`${baseDir}/sdk/${directory}/${tool}`, "");
    }
    const onTestHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: baseDir,
          PATH: `${baseDir}/bin`,
          ANDROID_HOME: `${baseDir}/sdk`,
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
    const host = yield* LocalDeviceHost.make().pipe(
      Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
      onTestHost,
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die(new Error("Readiness must not make network requests"))),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("Platform availability must not probe emulator video"),
      }),
    );
    expect((yield* onTestHost(host.summary)).platforms).toEqual([
      { platform: "ios", available: true },
      { platform: "android", available: true },
    ]);
    expect(yield* onTestHost(host.platformAvailability("android"))).toEqual({
      platform: "android",
      available: true,
    });
    expect(yield* onTestHost(host.platformAvailability("ios"))).toEqual({
      platform: "ios",
      available: true,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "constructs and inspects an unconfigured host without installing or starting helpers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-consent-" });
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
        Effect.provideService(HostProcess.Environment, { HOME: baseDir, PATH: "" }),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die(new Error("Host construction must not spawn processes")),
          ),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die(new Error("Host construction must not run commands")),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("Host construction must not make network requests")),
          ),
        ),
      );
      expect(yield* host.current).toBeNull();
      const error = yield* host
        .ensureReady(() => Effect.die("Must not install without Node"))
        .pipe(Effect.flip, Effect.provideService(HostProcess.IsExecutable, true));
      expect(error.message).toContain("Local device support requires Node.js");
      expect(error.message).toContain("Install Node.js");
      yield* host.stop;
      expect(yield* fs.exists(`${baseDir}/tools`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
