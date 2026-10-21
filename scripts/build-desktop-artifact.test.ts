// @effect-diagnostics nodeBuiltinImport:off - Tests use Node's glob matcher to verify electron-builder exclusions.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  buildDesktopBundles,
  BuildCommandFailedError,
  DesktopBuildManifestRestoreError,
  readWorkspaceConfig,
  createBuildConfig,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_EXTRA_RESOURCES,
  MAC_FILE_EXCLUSIONS,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  MacPasskeySigningConfigurationResolutionError,
  MissingMacPasskeyProvisioningProfileError,
  renderMacPasskeyEntitlements,
  resolveMacWebAuthnEntitlements,
  resolveMacPasskeySigningConfiguration,
  resolveMergedStageDependencies,
  resolveBuildOptions,
  resolveDesktopProductName,
  stageCursorSdkPlatformPackages,
} from "./build-desktop-artifact.ts";
import {
  ReleasePackageManifestError,
  releasePackageFiles,
} from "./update-release-package-versions.ts";

const encodeModuleUrl = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const decodePackageVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

function mockProcess(exitCode: number, stdout = "") {
  const encodedStdout = new TextEncoder().encode(stdout);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(encodedStdout) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it.effect("rejects overlapping builds from another process until restoration finishes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-concurrent-build-" });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        '{ "scripts": { "build:desktop": "node build.cjs" } }',
      );
      const original = '{ "version": "0.0.42", "private": true }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      yield* fs.writeFileString(
        path.join(root, "build.cjs"),
        `require("node:fs").writeFileSync("version.txt", require("./apps/server/package.json").version);`,
      );
      const restoring = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const contenderPath = path.join(root, "contender.mjs");
      yield* fs.writeFileString(
        contenderPath,
        `import * as Effect from ${yield* encodeModuleUrl(import.meta.resolve("effect/Effect"))};
           import * as NodeServices from ${yield* encodeModuleUrl(import.meta.resolve("@effect/platform-node/NodeServices"))};
           import { buildDesktopBundles } from ${yield* encodeModuleUrl(import.meta.resolve("./build-desktop-artifact.ts"))};
           const result = await Effect.runPromise(buildDesktopBundles(process.argv[2], "0.0.44", false).pipe(
             Effect.as("success"), Effect.catch(error => Effect.succeed(error._tag)),
             Effect.scoped, Effect.provide(NodeServices.layer)));
           process.stdout.write(result);`,
      );
      const first = yield* Effect.forkChild(
        Effect.exit(buildDesktopBundles(root, "0.0.43", false)).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (filePath, contents, options) =>
              filePath === path.join(root, releasePackageFiles[0]) && contents === original
                ? Deferred.succeed(restoring, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(fs.writeFileString(filePath, contents, options)),
                  )
                : fs.writeFileString(filePath, contents, options),
          }),
        ),
      );
      yield* Deferred.await(restoring);
      yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [contenderPath, root]),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText, Stream.mkString),
            child.stderr.pipe(Stream.decodeText, Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(Number(exitCode), 0, stderr);
        assert.equal(stdout, "DesktopBuildAlreadyRunningError");
      }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
      const firstExit = yield* Fiber.join(first);
      assert.isTrue(Exit.isSuccess(firstExit));
      assert.equal(yield* fs.readFileString(path.join(root, "version.txt")), "0.0.43");
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
      yield* buildDesktopBundles(root, "0.0.44", false);
      assert.equal(yield* fs.readFileString(path.join(root, "version.txt")), "0.0.44");
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
    }),
  );

  it.effect("restores manifests and releases the checkout lock after interruption", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-interrupted-build-" });
      const original = '{ "version": "0.0.42", "private": true }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      const started = yield* Deferred.make<void>();
      const childStopped = yield* Deferred.make<{ lockExists: boolean; version: string }>();
      const build = yield* Effect.forkChild(
        buildDesktopBundles(root, "0.0.43", false).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.acquireRelease(
                Effect.succeed({ ...mockProcess(0), exitCode: Effect.never }).pipe(
                  Effect.tap(() => Deferred.succeed(started, undefined)),
                ),
                () =>
                  Effect.gen(function* () {
                    const lockExists = yield* fs.exists(path.join(root, ".desktop-build.lock"));
                    const manifest = yield* decodePackageVersion(
                      yield* fs.readFileString(path.join(root, releasePackageFiles[0])),
                    );
                    yield* Deferred.succeed(childStopped, {
                      lockExists,
                      version: manifest.version,
                    });
                  }).pipe(Effect.orDie),
              ),
            ),
          ),
          Effect.scoped,
        ),
      );
      yield* Deferred.await(started);
      const aligned = yield* decodePackageVersion(
        yield* fs.readFileString(path.join(root, releasePackageFiles[0])),
      );
      assert.equal(aligned.version, "0.0.43");
      yield* Fiber.interrupt(build);
      assert.deepEqual(yield* Deferred.await(childStopped), {
        lockExists: true,
        version: "0.0.43",
      });
      assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
      yield* buildDesktopBundles(root, "0.0.44", false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
        ),
      );
      assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
    }),
  );

  it.effect(
    "builds web, server and desktop with the resolved version, restores changed manifests and preserves edits to matching ones",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-build-version-" });
        const packageJson = `{
          "name": "desktop-version-fixture",
          "version": "0.0.42",
          "scripts": { "build:desktop": "node build.cjs" }
        }`;
        yield* fs.writeFileString(path.join(root, "package.json"), packageJson);
        const version = "0.0.43-nightly.20260920.2018";
        const matchingPath = "packages/contracts/package.json";
        const originals = releasePackageFiles.map((relativePath, index) => ({
          relativePath,
          contents: `{ "version": "${relativePath === matchingPath ? version : `0.0.${index + 1}`}", "name": "${relativePath}" }\r\n`,
        }));
        const afterBuild = originals.map(({ relativePath, contents }) => ({
          relativePath,
          contents:
            relativePath === matchingPath
              ? `${JSON.stringify({ version, name: matchingPath, description: "edited during compilation" })}\n`
              : contents,
        }));
        for (const { relativePath, contents } of originals) {
          const filePath = path.join(root, relativePath);
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
          yield* fs.writeFileString(filePath, contents);
        }
        yield* fs.writeFileString(
          path.join(root, "build.cjs"),
          `require("node:fs").writeFileSync("version.txt", [
            process.env.APP_VERSION,
            require("./apps/web/package.json").version,
            require("./apps/server/package.json").version,
            require("./apps/desktop/package.json").version
          ].join("\\n"));
          const manifest = require("./${matchingPath}");
          manifest.description = "edited during compilation";
          require("node:fs").writeFileSync("${matchingPath}", JSON.stringify(manifest) + "\\n");`,
        );
        yield* buildDesktopBundles(root, version, false);
        assert.equal(
          yield* fs.readFileString(path.join(root, "version.txt")),
          [version, version, version, version].join("\n"),
        );
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(yield* fs.readFileString(path.join(root, relativePath)), contents);
        }
        assert.equal(yield* fs.readFileString(path.join(root, "package.json")), packageJson);
        yield* fs.writeFileString(path.join(root, "build.cjs"), "process.exit(1);");
        const failure = yield* Effect.flip(buildDesktopBundles(root, "0.0.44", false));
        assert.instanceOf(failure, BuildCommandFailedError);
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(yield* fs.readFileString(path.join(root, relativePath)), contents);
        }
        const invalidPath = releasePackageFiles[releasePackageFiles.length - 1]!;
        yield* fs.writeFileString(path.join(root, invalidPath), "invalid manifest");
        // A successful child would leave a marker if partial alignment accidentally starts it.
        yield* fs.writeFileString(
          path.join(root, "build.cjs"),
          'require("node:fs").writeFileSync("unexpected-build.txt", "started");',
        );
        const alignmentFailure = yield* Effect.flip(buildDesktopBundles(root, "0.0.44", false));
        assert.instanceOf(alignmentFailure, ReleasePackageManifestError);
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(
            yield* fs.readFileString(path.join(root, relativePath)),
            relativePath === invalidPath ? "invalid manifest" : contents,
          );
        }
        assert.isFalse(yield* fs.exists(path.join(root, "unexpected-build.txt")));
        assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
        assert.equal(yield* fs.readFileString(path.join(root, "package.json")), packageJson);
      }),
  );

  it.effect("reports a restore failure while still restoring the remaining manifests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-manifest-restore-failure-" });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        `{
          "name": "restore-fixture", "scripts": { "build:desktop": "node build.cjs" }
        }`,
      );
      yield* fs.writeFileString(path.join(root, "build.cjs"), "process.exit(0);");
      const original = '{ "version": "0.0.42" }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      const failedPath = path.join(root, releasePackageFiles[0]);
      const writeFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "writeFileString",
        pathOrDescriptor: failedPath,
      });
      const failure = yield* Effect.flip(buildDesktopBundles(root, "0.0.43", false)).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (filePath, contents, options) =>
            filePath === failedPath && contents === original
              ? Effect.fail(writeFailure)
              : fs.writeFileString(filePath, contents, options),
        }),
      );
      assert.instanceOf(failure, DesktopBuildManifestRestoreError);
      assert.notEqual(yield* fs.readFileString(failedPath), original);
      for (const relativePath of releasePackageFiles.slice(1)) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
    }),
  );

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.1.0"), "T3 PixelByte");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "T3 Code (Nightly)");
  });

  it.effect("omits update feeds for pull request preview builds", () =>
    Effect.gen(function* () {
      const preview = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33-pr.8182.1",
        false,
        false,
        undefined,
        undefined,
      );
      const release = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33",
        false,
        false,
        undefined,
        undefined,
      );

      const previewChannel = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.41-preview.20260912.1589",
        false,
        false,
        undefined,
        undefined,
      );

      assert.isNull(preview.publish);
      assert.isNull(previewChannel.publish);
      assert.deepStrictEqual(release.publish, [
        {
          provider: "github",
          owner: "pingdotgg",
          repo: "t3code",
          releaseType: "release",
        },
      ]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "pingdotgg/t3code" } }),
        ),
      ),
    ),
  );

  // pnpm writes "set this to true or false" placeholders into allowBuilds when a
  // tarball changes. pnpm ignores them, but the release build decode rejects them.
  it.effect("decodes the repo allowBuilds and every file: tarball it names exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { allowBuilds = {} } = yield* readWorkspaceConfig();
      const repoRoot = path.join(import.meta.dirname, "..");
      for (const key of Object.keys(allowBuilds)) {
        const tarball = key.split("@file:")[1];
        if (tarball === undefined) continue;
        assert.isTrue(
          yield* fs.exists(path.join(repoRoot, tarball)),
          `allowBuilds names a missing tarball: ${key}`,
        );
      }
    }),
  );

  it.effect("applies platform-specific packaging to the build config", () =>
    Effect.gen(function* () {
      const mac = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      assert.notProperty(mac, "asar");
      assert.notProperty(mac, "asarUnpack");
      assert.deepStrictEqual(mac.extraResources, DESKTOP_EXTRA_RESOURCES);
      assert.deepStrictEqual(mac.dmg, {
        title: "T3 PixelByte 1.2.3 Installer",
        background: "dmg/dmg-background-latest.png",
        window: { width: 640, height: 432 },
        contents: [
          { x: 166, y: 214, type: "file" },
          { x: 474, y: 214, type: "link", path: "/Applications" },
        ],
        iconSize: 120,
        iconTextSize: 12,
      });
      assert.deepStrictEqual((mac.mac as Record<string, unknown>).protocols, [
        { name: "T3 Code", schemes: ["t3code", "t3code-dev"] },
        { name: "Web site URL", schemes: ["http", "https"], role: "Viewer" },
      ]);
      const macInfo = (mac.mac as { extendInfo: Record<string, unknown> }).extendInfo;
      assert.strictEqual(macInfo.NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac, true);
      for (const key of [
        "NSRemindersFullAccessUsageDescription",
        "NSRemindersUsageDescription",
        "NSCalendarsFullAccessUsageDescription",
        "NSCalendarsUsageDescription",
      ]) {
        assert.isString(macInfo[key]);
      }
      assert.deepStrictEqual(macInfo.CFBundleDocumentTypes, [
        {
          CFBundleTypeName: "Web page",
          CFBundleTypeRole: "Viewer",
          LSHandlerRank: "Alternate",
          LSItemContentTypes: ["public.html", "public.xhtml"],
        },
      ]);
      assert.notProperty(mac, "toolsets");
      assert.deepStrictEqual(mac.files, [...DESKTOP_FILE_EXCLUSIONS, ...MAC_FILE_EXCLUSIONS]);
      assert.notProperty(mac.mac as Record<string, unknown>, "sign");
      assert.propertyVal(
        (mac.mac as Record<string, unknown>).extendInfo as Record<string, unknown>,
        "NSLocalNetworkUsageDescription",
        "T3 Code connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
      );
      assert.deepStrictEqual(mac.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("stages only the externals of both bundles in merged packages", () => {
    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        serverDependencies: {
          "@cursor/sdk": "1.0.22",
          "@anthropic-ai/claude-agent-sdk": "^0.3.170",
          "@ff-labs/fff-node": "0.9.4",
          "@opencode-ai/sdk": "^1.3.15",
          "@pierre/diffs": "1.3.0",
          "node-pty": "1.1.0",
        },
        desktopDependencies: {
          "@napi-rs/keyring": "1.3.0",
          "playwright-core": "1.60.0",
        },
        arch: "arm64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@cursor/sdk": "1.0.22",
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@napi-rs/keyring": "1.3.0",
        "playwright-core": "1.60.0",
        "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      },
    );
  });

  it.effect("ships Cursor platform assets outside asar for spawning and native loading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-helpers-" });
        const nodeModules = path.join(root, "node_modules");
        const destination = path.join(root, "resources/node_modules/@cursor");
        const cursorDirectory = path.join(root, "store/@cursor");
        yield* fs.makeDirectory(path.join(cursorDirectory, "sdk"), { recursive: true });
        yield* fs.makeDirectory(path.join(nodeModules, "@cursor"), { recursive: true });
        yield* fs.symlink(path.join(cursorDirectory, "sdk"), path.join(nodeModules, "@cursor/sdk"));
        const helpers = [
          "sdk-darwin-arm64/bin/rg",
          "sdk-darwin-arm64/bin/cursorsandbox",
          "sdk-darwin-arm64/vendor/tree-sitter/index.js",
          "sdk-darwin-arm64/vendor/tree-sitter/binding.node",
          "sdk-darwin-arm64/vendor/tree-sitter-bash/binding.node",
          "sdk-darwin-arm64/package.json",
        ];
        for (const helper of helpers) {
          const source = path.join(cursorDirectory, helper);
          yield* fs.makeDirectory(path.dirname(source), { recursive: true });
          yield* fs.writeFileString(source, "fixture helper", { mode: 0o755 });
        }
        yield* stageCursorSdkPlatformPackages(nodeModules, destination);
        for (const helper of helpers) {
          assert.equal(yield* fs.readFileString(path.join(destination, helper)), "fixture helper");
          const packagedPath = `node_modules/@cursor/${helper}`;
          assert.isTrue(
            DESKTOP_FILE_EXCLUSIONS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob.slice(1)),
            ),
          );
        }
      }),
    ),
  );

  it("derives macOS passkey signing configuration from the Clerk publishable key", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "abc1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
    });

    assert.deepStrictEqual(configuration, {
      appId: "com.t3tools.t3code",
      teamId: "ABC1234567",
      rpDomains: ["example.clerk.accounts.dev"],
      provisioningProfilePath: "/tmp/t3code.provisionprofile",
    });
  });

  it("normalizes explicit macOS passkey RP domains and renders required entitlements", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS:
        " Clerk.Example.com,example.clerk.accounts.dev,clerk.example.com ",
    });
    const entitlements = renderMacPasskeyEntitlements(configuration, {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });

    assert.deepStrictEqual(configuration.rpDomains, [
      "clerk.example.com",
      "example.clerk.accounts.dev",
    ]);
    assert.include(entitlements, "<string>ABC1234567.com.t3tools.t3code</string>");
    assert.include(entitlements, "<string>webcredentials:clerk.example.com</string>");
    assert.include(entitlements, "<string>webcredentials:example.clerk.accounts.dev</string>");
    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
    assert.match(
      entitlements,
      /<key>com\.apple\.security\.personal-information\.calendars<\/key>\s*<true\/>/u,
    );
    assert.notInclude(entitlements, "keychain-access-groups");
    assert.notInclude(entitlements, "com.apple.developer.web-browser.public-key-credential");
  });

  it("grants in-app browser passkey entitlements only when the provisioning profile does", () => {
    const configuration = { appId: "com.t3tools.t3code", teamId: "ABC1234567" };
    const profile = (entitlements: string, outside = "") =>
      `0\x82\x1f\x9a\x06\t*\x86H<?xml version="1.0"?><plist version="1.0"><dict>${outside}<key>Entitlements</key><dict>${entitlements}</dict></dict></plist>\x00\x01`;
    const teamWildcardGroups = `<key>keychain-access-groups</key>
      <array>
        <string>ABC1234567.*</string>
        <string>com.apple.token</string>
      </array>`;

    assert.deepStrictEqual(resolveMacWebAuthnEntitlements(profile(""), configuration), {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile("<key>keychain-access-groups</key><array><string>OTHERTEAM1.*</string></array>"),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `<!-- ${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key><true/> -->
          <key>com.apple.developer.web-browser.public-key-credential</key><false/>`,
          teamWildcardGroups,
        ),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key>
          <true/>`,
        ),
        configuration,
      ),
      {
        touchIdKeychainAccessGroup: "ABC1234567.com.t3tools.t3code.webauthn",
        browserPasskeys: true,
      },
    );

    const entitlements = renderMacPasskeyEntitlements(
      { ...configuration, rpDomains: ["clerk.example.com"], provisioningProfilePath: "" },
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}<key>com.apple.developer.web-browser.public-key-credential</key><true/>`,
        ),
        configuration,
      ),
    );
    assert.match(
      entitlements,
      /<key>keychain-access-groups<\/key>\s*<array>\s*<string>ABC1234567\.com\.t3tools\.t3code\.webauthn<\/string>\s*<\/array>/u,
    );
    assert.match(
      entitlements,
      /<key>com\.apple\.developer\.web-browser\.public-key-credential<\/key>\s*<true\/>/u,
    );
  });

  it("rejects incomplete macOS passkey signing configuration", () => {
    const captureError = (env: Readonly<Record<string, string | undefined>>) => {
      try {
        resolveMacPasskeySigningConfiguration(env);
      } catch (error) {
        return error;
      }
      return assert.fail("Expected passkey signing configuration to fail.");
    };

    const missingProfileError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev",
    });
    assert.instanceOf(missingProfileError, MissingMacPasskeyProvisioningProfileError);
    assert.equal(
      missingProfileError.message,
      "T3CODE_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.",
    );

    const unsafeDomain =
      "https://domain-user:domain-secret@example.clerk.accounts.dev/path?token=query-secret";
    const invalidDomainError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: unsafeDomain,
    });
    assert.instanceOf(invalidDomainError, InvalidMacPasskeyRpDomainError);
    assert.equal(invalidDomainError.reason, "scheme-not-allowed");
    assert.equal(invalidDomainError.inputLength, unsafeDomain.length);
    assert.equal(invalidDomainError.message, "Invalid passkey RP domain (scheme-not-allowed).");
    assert.notProperty(invalidDomainError, "domain");
    assert.notProperty(invalidDomainError, "cause");
    const serializedInvalidDomainError = JSON.stringify(invalidDomainError);
    assert.notInclude(serializedInvalidDomainError, unsafeDomain);
    assert.notInclude(serializedInvalidDomainError, "domain-user");
    assert.notInclude(serializedInvalidDomainError, "domain-secret");
    assert.notInclude(serializedInvalidDomainError, "query-secret");
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          T3CODE_APPLE_TEAM_ID: "ABC1234567",
          T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
          T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev:8443",
        }),
      /Invalid passkey RP domain/u,
    );
    const invalidPublishableKeyError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_%",
    });
    assert.instanceOf(invalidPublishableKeyError, InvalidMacPasskeyPublishableKeyError);
    assert.ok(invalidPublishableKeyError.cause);
    assert.equal(invalidPublishableKeyError.message, "T3CODE_CLERK_PUBLISHABLE_KEY is invalid.");
    assert.notProperty(invalidPublishableKeyError, "publishableKey");
    assert.notInclude(invalidPublishableKeyError.message, "pk_test_%");
  });

  it("wraps unknown passkey signing configuration defects without copying cause text", () => {
    const secret = "pk_test_do-not-retain";
    const cause = new Error(secret);
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(cause);

    assert.instanceOf(error, MacPasskeySigningConfigurationResolutionError);
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message, "Failed to resolve macOS passkey signing configuration.");
    assert.notInclude(error.message, secret);
  });

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
