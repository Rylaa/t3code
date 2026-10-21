#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - createRequire resolves nested native packages the way the packaged app will.

import * as NodeModule from "node:module";
// plist is CommonJS; Node cannot load its named exports from an ES module.
import Plist from "plist";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import {
  ReleasePackageManifestError,
  releasePackageFiles,
  updateReleasePackageVersions,
} from "./update-release-package-versions.ts";
import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import {
  BRAND_ASSET_PATHS,
  resolveWebAssetBrandForChannel,
  type WebAssetBrand,
} from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import {
  findInlinedExternalPackages,
  selectCliRuntimeExternalDependencies,
} from "./lib/cli-external-packages.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { selectDesktopRuntimeExternalDependencies } from "./lib/desktop-external-packages.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const DESKTOP_APP_ID = "com.t3tools.t3code";
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

const BuildPlatform = Schema.Literals(["mac"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;

const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
  }),
  // pnpm 11 only reads these from pnpm-workspace.yaml (not package.json#pnpm).
  // Without allowBuilds the staged `vp install --prod` fails with
  // ERR_PNPM_IGNORED_BUILDS for packages that have lifecycle scripts.
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  packageExtensions: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        peerDependenciesMeta: Schema.Record(
          Schema.String,
          Schema.Struct({ optional: Schema.Boolean }),
        ),
      }),
    ),
  ),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
type StageWorkspaceConfig = typeof StageWorkspaceConfig.Type;

// electron-webauthn declares TypeScript as a peer only for its typings. pnpm
// auto-installs missing peers, which would ship a compiler inside the app.
const STAGE_PACKAGE_EXTENSIONS = {
  "electron-webauthn": { peerDependenciesMeta: { typescript: { optional: true } } },
  "@electron-webauthn/macos": { peerDependenciesMeta: { typescript: { optional: true } } },
} as const;

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeReleasePackageManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

export const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

interface DesktopBuildIconAssets {
  readonly macIconPng: string;
}

interface PlatformConfig {
  readonly cliFlag: "--mac";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

export function resolveResourceMonitorRustTargets(
  arch: typeof BuildArch.Type,
): ReadonlyArray<string> {
  if (arch === "universal") {
    return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  }
  return [arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
}

const RESOURCE_MONITOR_EXECUTABLE_NAME = "t3-resource-monitor";

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<number>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  return undefined;
}

const getDefaultArch = Effect.fn("getDefaultArch")(function* (platform: typeof BuildPlatform.Type) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  return yield* getDefaultBuildArch(config);
});

export class MacPasskeySigningConfigurationResolutionError extends Schema.TaggedError<MacPasskeySigningConfigurationResolutionError>()(
  "MacPasskeySigningConfigurationResolutionError",
  {
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    cause: unknown,
  ): MacPasskeySigningConfigurationError | MacPasskeySigningConfigurationResolutionError {
    return isMacPasskeySigningConfigurationError(cause)
      ? cause
      : new MacPasskeySigningConfigurationResolutionError({ cause });
  }

  override get message(): string {
    return "Failed to resolve macOS passkey signing configuration.";
  }
}

export class KeyringNativePackageMissingError extends Schema.TaggedError<KeyringNativePackageMissingError>()(
  "KeyringNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Keyring native package is missing: ${this.packageName}`;
  }
}

export class ClerkPasskeyNativePackageMissingError extends Schema.TaggedError<ClerkPasskeyNativePackageMissingError>()(
  "ClerkPasskeyNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Clerk passkey native package is missing: ${this.packageName}`;
  }
}

export class UnsupportedHostBuildPlatformError extends Schema.TaggedError<UnsupportedHostBuildPlatformError>()(
  "UnsupportedHostBuildPlatformError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported host platform '${this.hostPlatform}'.`;
  }
}

const InvalidMockUpdateServerPortReason = Schema.Literals([
  "not-numeric",
  "not-integer",
  "out-of-range",
]);

export class InvalidMockUpdateServerPortError extends Schema.TaggedError<InvalidMockUpdateServerPortError>()(
  "InvalidMockUpdateServerPortError",
  {
    reason: InvalidMockUpdateServerPortReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid mock update server port.";
  }

  static fromConfigValue(configuredPort: string, cause: unknown) {
    return new InvalidMockUpdateServerPortError({
      reason: invalidMockUpdateServerPortReason(configuredPort),
      inputLength: configuredPort.length,
      cause,
    });
  }
}

export class DesktopBuildManifestRestoreError extends Schema.TaggedError<DesktopBuildManifestRestoreError>()(
  "DesktopBuildManifestRestoreError",
  { failures: Schema.Array(ReleasePackageManifestError) },
) {
  override get message(): string {
    return `Failed to restore release manifests: ${this.failures.map((failure) => failure.filePath).join(", ")}`;
  }
}

export class BuildCommandFailedError extends Schema.TaggedError<BuildCommandFailedError>()(
  "BuildCommandFailedError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stdoutTail: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const outputSections = [
      `Command: ${this.command}`,
      formatOutputSection("stdout", this.stdoutTail ?? ""),
      formatOutputSection("stderr", this.stderrTail ?? ""),
    ].filter((section): section is string => section !== undefined);
    const outputSuffix = outputSections.length > 0 ? `\n\n${outputSections.join("\n\n")}` : "";
    return `Command exited with non-zero exit code (${this.exitCode})${outputSuffix}`;
  }
}

const MAC_DESKTOP_BUILD_PREREQUISITES = [
  { id: "rust", description: "Rust/Cargo and the requested Rust target" },
  { id: "clang", description: "Xcode Command Line Tools (clang)" },
  { id: "make", description: "Xcode Command Line Tools (make)" },
  { id: "sips", description: "macOS image tool (sips)" },
  { id: "iconutil", description: "macOS icon tool (iconutil)" },
  { id: "lipo", description: "Xcode universal-binary tool (lipo)" },
] as const;

export class MacDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<MacDesktopBuildPrerequisitesMissingError>()(
  "MacDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTargets: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const details = MAC_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    )
      .map((requirement) => `  - ${requirement.description}`)
      .join("\n");
    return [
      "macOS desktop build prerequisites are missing:",
      details,
      "",
      "Install Apple's build tools with:",
      "  xcode-select --install",
      "Install Rust from https://rustup.rs, then add the requested target(s):",
      `  rustup target add ${this.rustTargets.join(" ")}`,
      "",
      "Then rerun the desktop artifact command.",
    ].join("\n");
  }
}

export class ResourceMonitorBuildOutputMissingError extends Schema.TaggedError<ResourceMonitorBuildOutputMissingError>()(
  "ResourceMonitorBuildOutputMissingError",
  {
    binaryPath: Schema.String,
    rustTarget: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Resource monitor build for ${this.rustTarget} did not produce ${this.binaryPath}.`;
  }
}

export class DesktopIconSourceMissingError extends Schema.TaggedError<DesktopIconSourceMissingError>()(
  "DesktopIconSourceMissingError",
  {
    platform: BuildPlatform,
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop macOS icon source is missing at ${this.sourcePath}`;
  }
}

export class DesktopDmgBackgroundSourceMissingError extends Schema.TaggedError<DesktopDmgBackgroundSourceMissingError>()(
  "DesktopDmgBackgroundSourceMissingError",
  {
    channel: Schema.Literals(["latest", "nightly"]),
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${this.channel} DMG background source is missing at ${this.sourcePath}`;
  }
}

export class BundledClientAssetsMissingError extends Schema.TaggedError<BundledClientAssetsMissingError>()(
  "BundledClientAssetsMissingError",
  {
    indexPath: Schema.String,
    missingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const preview = this.missingFiles.slice(0, 6).join(", ");
    const suffix = this.missingFiles.length > 6 ? ` (+${this.missingFiles.length - 6} more)` : "";
    return `Bundled client references missing files in ${this.indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`;
  }
}

export class UnsupportedDesktopBuildPlatformError extends Schema.TaggedError<UnsupportedDesktopBuildPlatformError>()(
  "UnsupportedDesktopBuildPlatformError",
  {
    platform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported platform '${this.platform}'.`;
  }
}

const dependencyResolutionDescriptions = {
  "server-production": "production dependencies",
  "workspace-overrides": "overrides",
  "desktop-runtime": "desktop runtime dependencies",
} as const;
const DependencyResolutionKind = Schema.Literals([
  "server-production",
  "workspace-overrides",
  "desktop-runtime",
]);

export class DesktopBuildDependencyResolutionError extends Schema.TaggedError<DesktopBuildDependencyResolutionError>()(
  "DesktopBuildDependencyResolutionError",
  {
    kind: DependencyResolutionKind,
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not resolve ${dependencyResolutionDescriptions[this.kind]} from ${this.manifestPath}.`;
  }
}

export class MissingServerProductionDependenciesError extends Schema.TaggedError<MissingServerProductionDependenciesError>()(
  "MissingServerProductionDependenciesError",
  {
    manifestPath: Schema.String,
  },
) {
  override get message(): string {
    return `Could not resolve production dependencies from ${this.manifestPath}.`;
  }
}

const DesktopBuildInputArtifact = Schema.Literals([
  "desktop-dist",
  "desktop-resources",
  "server-dist",
  "bundled-server-client",
]);
type DesktopBuildInputArtifact = typeof DesktopBuildInputArtifact.Type;
const desktopBuildInputArtifactNames = {
  "desktop-dist": "desktopDist",
  "desktop-resources": "desktopResources",
  "server-dist": "serverDist",
  "bundled-server-client": "bundled server client",
} satisfies Record<DesktopBuildInputArtifact, string>;

/**
 * Imported by every server module, so it is inlined in any correctly bundled
 * build. Its absence means the bundle went back to externalizing its
 * dependencies, which the sidecar's selected runtime closure does not cover.
 */
const BUNDLE_SELF_CONTAINED_SENTINEL = "effect";

export class ExternalizedBundleError extends Schema.TaggedError<ExternalizedBundleError>()(
  "ExternalizedBundleError",
  { sentinel: Schema.String, inlinedPackageCount: Schema.Number },
) {
  override get message(): string {
    return `The server bundle did not inline "${this.sentinel}" (${this.inlinedPackageCount} packages inlined). The bundle is meant to be self-contained apart from the runtime externals; if its dependencies are external again they will be absent from the sidecar, and the backend will fail with ERR_MODULE_NOT_FOUND. Check the deps.alwaysBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class InlinedNativePackageError extends Schema.TaggedError<InlinedNativePackageError>()(
  "InlinedNativePackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that load native binaries: ${this.packages.join(", ")}. A node-gyp-build style loader resolves prebuilds relative to its own file, so inlined into a chunk it finds none and the importer quietly falls back to a slower JS path. Add them to CLI_RUNTIME_EXTERNAL_PREFIXES in scripts/lib/cli-external-packages.ts so they stay external and are staged in the sidecar.`;
  }
}

export class InlinedExternalPackageError extends Schema.TaggedError<InlinedExternalPackageError>()(
  "InlinedExternalPackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that must stay external: ${this.packages.join(", ")}. These are native addons or their loaders; inlined, they resolve prebuilds relative to the bundle and silently lose native acceleration. Check the deps.neverBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class MissingDesktopBuildInputError extends Schema.TaggedError<MissingDesktopBuildInputError>()(
  "MissingDesktopBuildInputError",
  {
    artifact: DesktopBuildInputArtifact,
    artifactPath: Schema.String,
    buildCommand: Schema.Literal("vp run build:desktop"),
  },
) {
  override get message(): string {
    return `Missing ${desktopBuildInputArtifactNames[this.artifact]} at ${this.artifactPath}. Run '${this.buildCommand}' first.`;
  }
}

export class MacProvisioningProfileNotFoundError extends Schema.TaggedError<MacProvisioningProfileNotFoundError>()(
  "MacProvisioningProfileNotFoundError",
  {
    provisioningProfilePath: Schema.String,
  },
) {
  override get message(): string {
    return `macOS provisioning profile not found: ${this.provisioningProfilePath}`;
  }
}

export class DesktopBuildDistDirectoryMissingError extends Schema.TaggedError<DesktopBuildDistDirectoryMissingError>()(
  "DesktopBuildDistDirectoryMissingError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but dist directory was not found at ${this.distPath}`;
  }
}

export class DesktopBuildNoArtifactsProducedError extends Schema.TaggedError<DesktopBuildNoArtifactsProducedError>()(
  "DesktopBuildNoArtifactsProducedError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but no files were produced in ${this.distPath}`;
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const COMMAND_OUTPUT_TAIL_LENGTH = 20_000;

function appendOutputTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  return next.length > COMMAND_OUTPUT_TAIL_LENGTH ? next.slice(-COMMAND_OUTPUT_TAIL_LENGTH) : next;
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return `${label} tail:\n${trimmed}`;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
  verbose: boolean,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          verbose ? Effect.sync(() => output.write(chunk)) : Effect.void,
          appendOutputTail(acc, chunk),
        ),
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (result.exitCode !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
});

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: number | undefined;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly t3codeCommitHash: string;
  readonly t3codeWebAuthn?: MacWebAuthnEntitlements;
  readonly private: true;
  readonly packageManager: string;
  readonly description: string;
  readonly license: string;
  readonly homepage: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;
export const DESKTOP_ELECTRON_LANGUAGES = ["en-US"] as const;
export const DESKTOP_FILE_EXCLUSIONS = [
  // Cursor finds platform assets by walking up from argv[1]. Keep them outside
  // asar so spawning helpers and loading native addons both use real paths.
  "!**/node_modules/@cursor/sdk-*/**/*",
  "!apps/desktop/prod-resources/cursor-sdk",
  "!apps/desktop/prod-resources/cursor-sdk/**/*",
  // T3 Code always passes the user's installed Claude executable to the SDK,
  // so the SDK's optional platform packages (each a ~200MB bundled executable)
  // are dead weight. The trailing dash keeps the SDK's own JS package.
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
  "!**/*.map",
  "!**/*.d.cts",
] as const;
// Windows terminal helpers cannot run on macOS and slow signing and notarization.
export const MAC_FILE_EXCLUSIONS = [
  "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
  "!**/node_modules/node-pty/third_party/conpty/**/*",
] as const;
// node-pty publishes both Darwin prebuilds in one package. Single-architecture
// apps only need the native target; universal apps need both.
export function resolveMacFileExclusions(arch?: typeof BuildArch.Type) {
  if (arch === undefined || arch === "universal") {
    return [...MAC_FILE_EXCLUSIONS];
  }

  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  return [...MAC_FILE_EXCLUSIONS, `!**/node_modules/node-pty/prebuilds/darwin-${unusedArch}/**/*`];
}
export const DESKTOP_EXTRA_RESOURCES = [
  {
    from: "apps/desktop/prod-resources/cursor-sdk",
    to: "node_modules/@cursor",
  },
  {
    from: "apps/desktop/prod-resources/resource-monitor",
    to: "resource-monitor",
  },
] as const;
export interface MacPasskeySigningConfiguration {
  readonly appId: string;
  readonly teamId: string;
  readonly rpDomains: readonly string[];
  readonly provisioningProfilePath: string;
}

export const InvalidMacPasskeyRpDomainReason = Schema.Literals([
  "empty",
  "scheme-not-allowed",
  "parse-failed",
  "credentials-not-allowed",
  "port-not-allowed",
  "path-not-allowed",
  "query-not-allowed",
  "fragment-not-allowed",
  "hostname-mismatch",
]);
export type InvalidMacPasskeyRpDomainReason = typeof InvalidMacPasskeyRpDomainReason.Type;

export class InvalidMacPasskeyRpDomainError extends Schema.TaggedError<InvalidMacPasskeyRpDomainError>()(
  "InvalidMacPasskeyRpDomainError",
  {
    reason: InvalidMacPasskeyRpDomainReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid passkey RP domain (${this.reason}).`;
  }
}

export class InvalidAppleTeamIdError extends Schema.TaggedError<InvalidAppleTeamIdError>()(
  "InvalidAppleTeamIdError",
  {
    teamId: Schema.String,
  },
) {
  override get message(): string {
    return `T3CODE_APPLE_TEAM_ID '${this.teamId}' must be a 10-character Apple Developer Team ID.`;
  }
}

export class MissingMacPasskeyProvisioningProfileError extends Schema.TaggedError<MissingMacPasskeyProvisioningProfileError>()(
  "MissingMacPasskeyProvisioningProfileError",
  {},
) {
  override get message(): string {
    return "T3CODE_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.";
  }
}

export class MissingMacPasskeyDomainConfigurationError extends Schema.TaggedError<MissingMacPasskeyDomainConfigurationError>()(
  "MissingMacPasskeyDomainConfigurationError",
  {},
) {
  override get message(): string {
    return "T3CODE_CLERK_PUBLISHABLE_KEY or T3CODE_CLERK_PASSKEY_RP_DOMAINS is required for signed macOS passkey builds.";
  }
}

export class InvalidMacPasskeyPublishableKeyError extends Schema.TaggedError<InvalidMacPasskeyPublishableKeyError>()(
  "InvalidMacPasskeyPublishableKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "T3CODE_CLERK_PUBLISHABLE_KEY is invalid.";
  }
}

export class MissingMacPasskeyRpDomainError extends Schema.TaggedError<MissingMacPasskeyRpDomainError>()(
  "MissingMacPasskeyRpDomainError",
  {},
) {
  override get message(): string {
    return "At least one Clerk passkey RP domain is required.";
  }
}

export const MacPasskeySigningConfigurationError = Schema.Union([
  InvalidMacPasskeyRpDomainError,
  InvalidAppleTeamIdError,
  MissingMacPasskeyProvisioningProfileError,
  MissingMacPasskeyDomainConfigurationError,
  InvalidMacPasskeyPublishableKeyError,
  MissingMacPasskeyRpDomainError,
]);
export type MacPasskeySigningConfigurationError = typeof MacPasskeySigningConfigurationError.Type;
export const isMacPasskeySigningConfigurationError = Schema.is(MacPasskeySigningConfigurationError);

function normalizePasskeyRpDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  const inputLength = value.length;
  if (normalized.length === 0) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "empty", inputLength });
  }
  if (/^[a-z][a-z\d+.-]*:\/\//u.test(normalized)) {
    throw new InvalidMacPasskeyRpDomainError({
      reason: "scheme-not-allowed",
      inputLength,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch (cause) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "parse-failed", inputLength, cause });
  }

  let reason: InvalidMacPasskeyRpDomainReason | undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    reason = "credentials-not-allowed";
  } else if (parsed.port.length > 0) {
    reason = "port-not-allowed";
  } else if (parsed.pathname !== "/") {
    reason = "path-not-allowed";
  } else if (parsed.search.length > 0) {
    reason = "query-not-allowed";
  } else if (parsed.hash.length > 0) {
    reason = "fragment-not-allowed";
  } else if (parsed.host !== normalized) {
    reason = "hostname-mismatch";
  }
  if (reason) {
    throw new InvalidMacPasskeyRpDomainError({ reason, inputLength });
  }

  return parsed.hostname;
}

export function resolveMacPasskeySigningConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): MacPasskeySigningConfiguration {
  const teamId = env.T3CODE_APPLE_TEAM_ID?.trim().toUpperCase() ?? "";
  if (!APPLE_TEAM_ID_PATTERN.test(teamId)) {
    throw new InvalidAppleTeamIdError({ teamId });
  }

  const provisioningProfilePath = env.T3CODE_MACOS_PROVISIONING_PROFILE?.trim() ?? "";
  if (provisioningProfilePath.length === 0) {
    throw new MissingMacPasskeyProvisioningProfileError();
  }

  const configuredRpDomains = env.T3CODE_CLERK_PASSKEY_RP_DOMAINS?.trim();
  let rpDomains: readonly string[];
  if (configuredRpDomains) {
    rpDomains = configuredRpDomains.split(",").map(normalizePasskeyRpDomain);
  } else {
    const publishableKey = env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim();
    if (!publishableKey) {
      throw new MissingMacPasskeyDomainConfigurationError();
    }
    let hostname: string;
    try {
      hostname = clerkFrontendApiHostnameFromPublishableKey(publishableKey);
    } catch (cause) {
      throw new InvalidMacPasskeyPublishableKeyError({ cause });
    }
    rpDomains = [normalizePasskeyRpDomain(hostname)];
  }

  const uniqueRpDomains = [...new Set(rpDomains)];
  if (uniqueRpDomains.length === 0) {
    throw new MissingMacPasskeyRpDomainError();
  }

  return {
    appId: DESKTOP_APP_ID,
    teamId,
    rpDomains: uniqueRpDomains,
    provisioningProfilePath,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Passkey entitlements for the in-app browser. Each is granted only when the
 * provisioning profile authorizes it: macOS refuses to launch an app that
 * claims a restricted entitlement its embedded profile does not carry.
 */
export interface MacWebAuthnEntitlements {
  readonly touchIdKeychainAccessGroup: string | undefined;
  readonly browserPasskeys: boolean;
}

const BROWSER_PASSKEYS_ENTITLEMENT = "com.apple.developer.web-browser.public-key-credential";

const ProvisioningProfilePlist = Schema.Struct({
  Entitlements: Schema.Struct({
    "keychain-access-groups": Schema.optional(Schema.Array(Schema.String)),
    [BROWSER_PASSKEYS_ENTITLEMENT]: Schema.optional(Schema.Boolean),
  }),
});
const isProvisioningProfilePlist = Schema.is(ProvisioningProfilePlist);

const readProfileEntitlements = (provisioningProfile: string) => {
  const start = provisioningProfile.indexOf("<?xml");
  const end = provisioningProfile.indexOf("</plist>", start);
  if (start === -1 || end === -1) return undefined;
  try {
    const profile: unknown = Plist.parse(provisioningProfile.slice(start, end + "</plist>".length));
    return isProvisioningProfilePlist(profile) ? profile.Entitlements : undefined;
  } catch {
    return undefined;
  }
};

export function resolveMacWebAuthnEntitlements(
  provisioningProfile: string,
  configuration: Pick<MacPasskeySigningConfiguration, "appId" | "teamId">,
): MacWebAuthnEntitlements {
  const entitlements = readProfileEntitlements(provisioningProfile);
  const keychainAccessGroup = `${configuration.teamId}.${configuration.appId}.webauthn`;
  const keychainGroupAuthorized = (entitlements?.["keychain-access-groups"] ?? []).some((group) =>
    group.endsWith("*")
      ? keychainAccessGroup.startsWith(group.slice(0, -1))
      : group === keychainAccessGroup,
  );
  return {
    touchIdKeychainAccessGroup: keychainGroupAuthorized ? keychainAccessGroup : undefined,
    browserPasskeys: entitlements?.[BROWSER_PASSKEYS_ENTITLEMENT] === true,
  };
}

export function renderMacPasskeyEntitlements(
  configuration: MacPasskeySigningConfiguration,
  webAuthn: MacWebAuthnEntitlements,
): string {
  const associatedDomains = configuration.rpDomains
    .map((domain) => `      <string>webcredentials:${escapeXml(domain)}</string>`)
    .join("\n");
  const keychainAccessGroups = webAuthn.touchIdKeychainAccessGroup
    ? `
    <key>keychain-access-groups</key>
    <array>
      <string>${escapeXml(webAuthn.touchIdKeychainAccessGroup)}</string>
    </array>`
    : "";
  const browserPasskeys = webAuthn.browserPasskeys
    ? `
    <key>${BROWSER_PASSKEYS_ENTITLEMENT}</key>
    <true/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.application-identifier</key>
    <string>${escapeXml(`${configuration.teamId}.${configuration.appId}`)}</string>
    <key>com.apple.developer.team-identifier</key>
    <string>${escapeXml(configuration.teamId)}</string>
    <key>com.apple.developer.associated-domains</key>
    <array>
${associatedDomains}
    </array>${keychainAccessGroups}${browserPasskeys}
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <!-- Focus deadlines are mirrored into Reminders and Calendar by an osascript child. -->
    <key>com.apple.security.personal-information.calendars</key>
    <true/>
    <!-- The hardened runtime denies camera and microphone to the app and every
         child process, with no prompt, unless the app claims these. Terminals
         and coding agents inherit the app's TCC identity, so without these a
         command like ffmpeg or imagesnap gets silent access-denied. -->
    <key>com.apple.security.device.camera</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
  </dict>
</plist>
`;
}

export function resolveFffNativeDependencies(
  arch: typeof BuildArch.Type,
  version: string,
): Record<string, string> {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];
  return Object.fromEntries(
    architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
  );
}

// Both processes run from one app.asar, so the stage installs the union of
// what each bundle leaves external and nothing else.
export function resolveMergedStageDependencies(input: {
  readonly serverDependencies: Record<string, string>;
  readonly desktopDependencies: Record<string, string>;
  readonly arch: typeof BuildArch.Type;
  readonly fffNodeVersion: string;
}) {
  return {
    ...selectCliRuntimeExternalDependencies(input.serverDependencies),
    ...input.desktopDependencies,
    ...resolveFffNativeDependencies(input.arch, input.fffNodeVersion),
  };
}

/** Cursor's helper lookup falls through the archive to this real resources tree. */
export const stageCursorSdkPlatformPackages = Effect.fn("stageCursorSdkPlatformPackages")(
  function* (nodeModulesDir: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(destination, { recursive: true });
    const sdkDirectory = path.join(nodeModulesDir, "@cursor/sdk");
    if (!(yield* fs.exists(sdkDirectory))) return;
    const cursorDirectory = path.dirname(yield* fs.realPath(sdkDirectory));
    for (const name of yield* fs.readDirectory(cursorDirectory)) {
      if (!name.startsWith("sdk-")) continue;
      const source = yield* fs.realPath(path.join(cursorDirectory, name));
      yield* fs.copy(source, path.join(destination, name));
    }
  },
);

export interface ClerkPasskeyNativeArtifact {
  readonly packageName: string;
  readonly binaryFileName: string;
}

export function resolveClerkPasskeyNativeArtifacts(
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];
  return architectures.map((architecture) => ({
    packageName: `@clerk/electron-passkeys-darwin-${architecture}`,
    binaryFileName: `electron-passkeys.darwin-${architecture}.node`,
  }));
}

export function resolveKeyringNativeArtifacts(
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];
  return architectures.map((architecture) => ({
    packageName: `@napi-rs/keyring-darwin-${architecture}`,
    binaryFileName: `keyring.darwin-${architecture}.node`,
  }));
}

/**
 * Same nesting problem as the Clerk passkey binaries: pnpm keeps the platform
 * package under `@napi-rs/keyring`, electron-builder only retains collected
 * top-level dependencies, and the generated loader checks for a sibling
 * `keyring.<platform>.node` before falling back to the package. Staging the
 * binary beside `index.js` lets that first branch win.
 */
const stageKeyringNativeBinaries = Effect.fn("stageKeyringNativeBinaries")(function* (
  stageAppDir: string,
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@napi-rs", "keyring", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveKeyringNativeArtifacts(arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(`${artifact.packageName}/${artifact.binaryFileName}`),
      catch: (cause) =>
        new KeyringNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform,
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

// pnpm nests the architecture package under @clerk/electron-passkeys, while electron-builder only
// retains collected top-level dependencies. The SDK loader checks beside index.js first, so stage
// the binary there and let electron-builder's native-addon handling unpack it from the ASAR.
const stageClerkPasskeyNativeBinaries = Effect.fn("stageClerkPasskeyNativeBinaries")(function* (
  stageAppDir: string,
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@clerk", "electron-passkeys", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveClerkPasskeyNativeArtifacts(arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(artifact.packageName),
      catch: (cause) =>
        new ClerkPasskeyNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform,
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

export function createStageWorkspaceConfig(input: {
  readonly arch: typeof BuildArch.Type;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}): StageWorkspaceConfig {
  const { arch, allowBuilds, patchedDependencies, overrides } = input;

  return {
    supportedArchitectures: {
      os: ["darwin"],
      cpu: arch === "universal" ? ["arm64", "x64"] : [arch],
    },
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    packageExtensions: STAGE_PACKAGE_EXTENSIONS,
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "T3CODE_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.String("T3CODE_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH").pipe(Config.option),
  version: Config.String("T3CODE_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.String("T3CODE_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.Boolean("T3CODE_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.Boolean("T3CODE_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.Boolean("T3CODE_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  verbose: Config.Boolean("T3CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
  mockUpdates: Config.Boolean("T3CODE_DESKTOP_MOCK_UPDATES").pipe(Config.withDefault(false)),
  mockUpdateServerPort: Config.String("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
});

const MockUpdateServerPortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
const decodeMockUpdateServerPort = Schema.decodeUnknownEffect(MockUpdateServerPortSchema);

function invalidMockUpdateServerPortReason(
  configuredPort: string,
): typeof InvalidMockUpdateServerPortReason.Type {
  const parsed = Number(configuredPort);
  if (!Number.isFinite(parsed)) return "not-numeric";
  if (!Number.isInteger(parsed)) return "not-integer";
  if (parsed < 1 || parsed > 65535) return "out-of-range";
  // This mapper is only called after schema decoding failed. An otherwise
  // valid integer therefore used a representation the decoder did not accept.
  return "not-numeric";
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveMockUpdateServerPort = Effect.fn("resolveMockUpdateServerPort")(function* (
  mockUpdateServerPort: string | undefined,
) {
  const port = mockUpdateServerPort?.trim();
  if (!port) {
    return undefined;
  }

  return yield* decodeMockUpdateServerPort(port);
});

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig;
  const hostPlatform = yield* HostProcess.Platform;

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(hostPlatform),
  );

  if (!platform) {
    return yield* new UnsupportedHostBuildPlatformError({ hostPlatform });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const defaultArch = yield* getDefaultArch(platform);
  const arch = mergeOptions(input.arch, env.arch, defaultArch);
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const releaseDir = resolveBooleanFlag(input.mockUpdates, env.mockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  const skipBuild = resolveBooleanFlag(input.skipBuild, env.skipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, env.keepStage);
  const signed = resolveBooleanFlag(input.signed, env.signed);
  const verbose = resolveBooleanFlag(input.verbose, env.verbose);

  const mockUpdates = resolveBooleanFlag(input.mockUpdates, env.mockUpdates);
  const configuredMockUpdateServerPort = Option.getOrUndefined(env.mockUpdateServerPort);
  const mockUpdateServerPort =
    Option.getOrUndefined(input.mockUpdateServerPort) ??
    (configuredMockUpdateServerPort === undefined
      ? undefined
      : yield* resolveMockUpdateServerPort(configuredMockUpdateServerPort).pipe(
          Effect.mapError((cause) =>
            InvalidMockUpdateServerPortError.fromConfigValue(configuredMockUpdateServerPort, cause),
          ),
        ));

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
  } satisfies ResolvedBuildOptions;
});

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options: {
    readonly label: string;
    readonly verbose: boolean;
  },
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, process.stdout, options.verbose),
      collectCommandStream(child.stderr, process.stderr, options.verbose),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new BuildCommandFailedError({
      command: options.label,
      exitCode,
      ...(stdout.trim() ? { stdoutTail: stdout } : {}),
      ...(stderr.trim() ? { stderrTail: stderr } : {}),
    });
  }
});

export class DesktopBuildAlreadyRunningError extends Schema.TaggedError<DesktopBuildAlreadyRunningError>()(
  "DesktopBuildAlreadyRunningError",
  { lockPath: Schema.String },
) {
  override get message(): string {
    return `Another desktop build owns '${this.lockPath}'. Wait for it to finish. If a build was killed, confirm no desktop build is running, inspect and restore any changed release manifests, then remove this lock.`;
  }
}

const withDesktopBuildLock = Effect.fn("withDesktopBuildLock")(function* <A, E, R>(
  repoRoot: string,
  build: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = path.join(repoRoot, ".desktop-build.lock");
  return yield* Effect.acquireUseRelease(
    fs
      .makeDirectory(lockPath)
      .pipe(
        Effect.mapError((error) =>
          error.reason._tag === "AlreadyExists"
            ? new DesktopBuildAlreadyRunningError({ lockPath })
            : error,
        ),
      ),
    // Stop packaging children and finish stage cleanup before another build can enter.
    () => build.pipe(Effect.scoped),
    (_, exit) =>
      fs
        .remove(lockPath, { recursive: true })
        .pipe(
          Effect.catch((error) =>
            Exit.isFailure(exit) ? Effect.logError(error) : Effect.fail(error),
          ),
        ),
  );
});

// The artifact entry point holds the checkout lock through staging/packaging,
// so it calls this implementation without reacquiring its own lock.
const buildDesktopBundlesUnlocked = Effect.fn("buildDesktopBundlesUnlocked")(function* (
  repoRoot: string,
  appVersion: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawnCommand = yield* resolveSpawnCommand("vp", ["run", "build:desktop"]);
  yield* Effect.acquireUseRelease(
    Effect.forEach(releasePackageFiles, (relativePath) =>
      Effect.gen(function* () {
        const filePath = path.join(repoRoot, relativePath);
        const contents = yield* fs.readFileString(filePath);
        const needsRestore = yield* decodeReleasePackageManifest(contents).pipe(
          Effect.map((manifest) => manifest.version !== appVersion),
          // Let alignment report invalid manifests after any preceding writes.
          Effect.orElseSucceed(() => false),
        );
        return { filePath, contents, needsRestore };
      }),
    ),
    () =>
      Effect.gen(function* () {
        yield* updateReleasePackageVersions(appVersion, { rootDir: repoRoot });
        // The compiler must stop reading the aligned manifests before restoration.
        yield* runCommand(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: repoRoot,
            shell: spawnCommand.shell,
            env: { APP_VERSION: appVersion },
            extendEnv: true,
          }),
          { label: "vp run build:desktop", verbose },
        ).pipe(Effect.scoped);
      }),
    (originals, exit) =>
      Effect.gen(function* () {
        const [, failures] = yield* Effect.partition(
          originals.filter(({ needsRestore }) => needsRestore),
          ({ filePath, contents }) =>
            fs
              .writeFileString(filePath, contents)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ReleasePackageManifestError({ operation: "write", filePath, cause }),
                ),
              ),
        );
        if (failures.length === 0) return;
        const error = new DesktopBuildManifestRestoreError({ failures });
        if (Exit.isFailure(exit)) {
          // Cleanup must not hide the original build or alignment failure.
          yield* Effect.logError(error);
        } else {
          return yield* error;
        }
      }),
  );
});

export const buildDesktopBundles = Effect.fn("buildDesktopBundles")(
  (repoRoot: string, appVersion: string, verbose: boolean) =>
    withDesktopBuildLock(repoRoot, buildDesktopBundlesUnlocked(repoRoot, appVersion, verbose)),
);

const desktopBuildProbeSucceeds = Effect.fn("desktopBuildProbeSucceeds")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  return yield* runCommand(command, { label, verbose: false }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

const rustTargetIsInstalled = Effect.fn("rustTargetIsInstalled")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("rustc", ["--print", "target-libdir", "--target", target]),
  ).pipe(Effect.orElseSucceed(() => null));
  if (result === null || result.exitCode !== 0) return false;

  const targetLibDir = result.stdout.trim();
  if (targetLibDir === "") return false;
  const entries = yield* fs.readDirectory(targetLibDir).pipe(Effect.orElseSucceed(() => []));
  return entries.some((entry) => entry.startsWith("libstd-") && entry.endsWith(".rlib"));
});

export const preflightMacDesktopBuild = Effect.fn("preflightMacDesktopBuild")(function* (
  arch: typeof BuildArch.Type,
) {
  const rustTargets = resolveResourceMonitorRustTargets(arch);
  const reuseResourceMonitor = yield* Config.Boolean("T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR").pipe(
    Config.withDefault(false),
  );
  const checks = yield* Effect.all(
    {
      rust: reuseResourceMonitor
        ? Effect.succeed(true)
        : Effect.all([
            desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo"),
            Effect.forEach(rustTargets, rustTargetIsInstalled).pipe(
              Effect.map((results) => results.every(Boolean)),
            ),
          ]).pipe(Effect.map(([cargo, targets]) => cargo && targets)),
      clang: desktopBuildProbeSucceeds(ChildProcess.make("clang", ["--version"]), "clang"),
      make: desktopBuildProbeSucceeds(ChildProcess.make("make", ["--version"]), "make"),
      sips: desktopBuildProbeSucceeds(ChildProcess.make("sips", ["--help"]), "sips"),
      iconutil: desktopBuildProbeSucceeds(
        ChildProcess.make("xcrun", ["--find", "iconutil"]),
        "iconutil",
      ),
      lipo:
        arch === "universal"
          ? desktopBuildProbeSucceeds(ChildProcess.make("lipo", ["-version"]), "lipo")
          : Effect.succeed(true),
    },
    { concurrency: "unbounded" },
  );
  const missing = MAC_DESKTOP_BUILD_PREREQUISITES.filter(
    (requirement) => !checks[requirement.id],
  ).map((requirement) => requirement.id);
  if (missing.length > 0) {
    return yield* new MacDesktopBuildPrerequisitesMissingError({ missing, rustTargets });
  }
});

const NativeMarkerManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeNativeMarkerManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(NativeMarkerManifest),
);

const findStorePackageDirectory = Effect.fn("findStorePackageDirectory")(function* (
  repoRoot: string,
  packageName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeDir = path.join(repoRoot, "node_modules/.pnpm");
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* exists(storeDir))) return null;

  const flattened = `${packageName.replace("/", "+")}@`;
  const entries = yield* fs
    .readDirectory(storeDir)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  for (const entry of entries) {
    if (!entry.startsWith(flattened)) continue;
    const candidate = path.join(storeDir, entry, "node_modules", packageName);
    if (yield* exists(candidate)) return candidate;
  }
  return null;
});

const hasNativeLoaderMarkers = Effect.fn("hasNativeLoaderMarkers")(function* (packageDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  if (yield* exists(path.join(packageDir, "binding.gyp"))) return true;
  if (yield* exists(path.join(packageDir, "prebuilds"))) return true;

  const manifestPath = path.join(packageDir, "package.json");
  if (!(yield* exists(manifestPath))) return false;
  const source = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => ""));
  if (source === "") return false;
  const manifest = yield* Effect.try(() => decodeNativeMarkerManifest(source)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (manifest === null) return false;
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).some(
    (dependency) => dependency.startsWith("node-gyp-build"),
  );
});

export const stageResourceMonitor = Effect.fn("stageResourceMonitor")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(input.repoRoot, "native/resource-monitor/Cargo.toml");
  const executableName = RESOURCE_MONITOR_EXECUTABLE_NAME;
  const rustTargets = resolveResourceMonitorRustTargets(input.arch);
  const reuseResourceMonitor = yield* Config.Boolean("T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR").pipe(
    Config.withDefault(false),
  );
  const builtBinaries: string[] = [];

  for (const rustTarget of rustTargets) {
    if (!reuseResourceMonitor) {
      const spawnCommand = yield* resolveSpawnCommand("cargo", [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        manifestPath,
        "--target",
        rustTarget,
      ]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.repoRoot,
          shell: spawnCommand.shell,
        }),
        {
          label: `cargo build resource monitor (${rustTarget})`,
          verbose: input.verbose,
        },
      );
    }

    const binaryPath = path.join(
      input.repoRoot,
      "native/resource-monitor/target",
      rustTarget,
      "release",
      executableName,
    );
    if (!(yield* fs.exists(binaryPath))) {
      return yield* new ResourceMonitorBuildOutputMissingError({
        binaryPath,
        rustTarget,
        platform: "mac",
        arch: input.arch,
      });
    }
    if (reuseResourceMonitor) {
      yield* Effect.log(`[desktop-artifact] Reusing cached resource monitor (${rustTarget}).`);
    }
    builtBinaries.push(binaryPath);
  }

  const destinationDirectory = path.join(input.stageResourcesDir, "resource-monitor");
  const destinationPath = path.join(destinationDirectory, executableName);
  yield* fs.remove(destinationDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(destinationDirectory, { recursive: true });

  if (builtBinaries.length === 1) {
    yield* fs.copyFile(builtBinaries[0]!, destinationPath);
  } else {
    yield* runCommand(
      ChildProcess.make("lipo", ["-create", ...builtBinaries, "-output", destinationPath]),
      {
        label: "lipo resource monitor universal binary",
        verbose: input.verbose,
      },
    );
  }

  yield* fs.chmod(destinationPath, 0o755);
});

const generateMacIconSet = Effect.fn("build-desktop-artifact.generateMacIconSet")(function* (
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const iconsetDir = path.join(tmpRoot, "icon.iconset");
  yield* fs.makeDirectory(iconsetDir, { recursive: true });

  const iconSizes = [16, 32, 128, 256, 512] as const;
  for (const size of iconSizes) {
    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      { label: `sips icon ${size}x${size}`, verbose },
    );

    const retinaSize = size * 2;
    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      { label: `sips icon ${size}x${size}@2x`, verbose },
    );
  }

  yield* runCommand(ChildProcess.make({})`iconutil -c icns ${iconsetDir} -o ${targetIcns}`, {
    label: "iconutil icns",
    verbose,
  });
});

const stageMacIcons = Effect.fn("build-desktop-artifact.stageMacIcons")(function* (
  stageResourcesDir: string,
  sourcePng: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(sourcePng))) {
    return yield* new DesktopIconSourceMissingError({
      platform: "mac",
      sourcePath: sourcePng,
    });
  }

  const tmpRoot = yield* fs.makeTempDirectoryScoped({
    prefix: "t3code-icon-build-",
  });

  const iconPngPath = path.join(stageResourcesDir, "icon.png");
  const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

  yield* runCommand(ChildProcess.make({})`sips -z 512 512 ${sourcePng} --out ${iconPngPath}`, {
    label: "sips mac icon",
    verbose,
  });

  yield* generateMacIconSet(sourcePng, iconIcnsPath, tmpRoot, path, verbose);
});

export const stageDesktopDmgBackground = Effect.fn("stageDesktopDmgBackground")(function* (
  stageResourcesDir: string,
  channel: "latest" | "nightly",
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(stageResourcesDir, "dmg", `dmg-background-${channel}.svg`);
  if (!(yield* fs.exists(sourcePath))) {
    return yield* new DesktopDmgBackgroundSourceMissingError({ channel, sourcePath });
  }

  for (const output of [
    { suffix: "", width: 640, height: 432 },
    { suffix: "@2x", width: 1280, height: 864 },
  ] as const) {
    const targetPath = path.join(
      stageResourcesDir,
      "dmg",
      `dmg-background-${channel}${output.suffix}.png`,
    );
    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -s format png -z ${output.height} ${output.width} ${sourcePath} --out ${targetPath}`,
      {
        label: `sips ${channel} DMG background${output.suffix || "@1x"}`,
        verbose,
      },
    );
  }
});

const validateBundledClientAssets = Effect.fn("build-desktop-artifact.validateBundledClientAssets")(
  function* (clientDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      return yield* new BundledClientAssetsMissingError({
        indexPath,
        missingFiles: missing,
      });
    }
  },
);

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  return resolveCatalogDependencies(
    selectDesktopRuntimeExternalDependencies(dependencies),
    catalog,
    "apps/desktop",
  );
}

export const resolveGitHubPublishConfig = Effect.fn("resolveGitHubPublishConfig")(function* (
  updateChannel: "latest" | "nightly",
) {
  const env = yield* Config.all({
    updateRepository: Config.String("T3CODE_DESKTOP_UPDATE_REPOSITORY").pipe(Config.option),
    githubRepository: Config.String("GITHUB_REPOSITORY").pipe(Config.option),
  });
  const rawRepo = (
    Option.getOrUndefined(env.updateRepository)?.trim() ||
    Option.getOrUndefined(env.githubRepository)?.trim() ||
    ""
  ).trim();
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: updateChannel === "nightly" ? "prerelease" : "release",
    ...(updateChannel === "nightly" ? { channel: "nightly" as const } : {}),
  };
});

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

export function isDesktopPreviewVersion(version: string): boolean {
  return /-pr\./.test(version) || /-preview\.\d{8}\.\d+$/.test(version);
}

export function resolveDesktopWebAssetBrand(version: string): WebAssetBrand {
  return resolveWebAssetBrandForChannel(resolveDesktopUpdateChannel(version));
}

export function resolveDesktopBuildIconAssets(version: string): DesktopBuildIconAssets {
  if (resolveDesktopUpdateChannel(version) === "nightly") {
    return {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
    };
  }

  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
  };
}

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string {
  return `http://localhost:${mockUpdateServerPort ?? 3000}`;
}

// Electron Builder detects pnpm from npm_config_user_agent, whose value uses
// user-agent syntax (pnpm/11.10.0) rather than packageManager syntax
// (pnpm@11.10.0).
export function resolvePackageManagerUserAgent(packageManager: string): string {
  const trimmed = packageManager.trim();
  const versionSeparator = trimmed.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === trimmed.length - 1) {
    return trimmed;
  }

  return `${trimmed.slice(0, versionSeparator)}/${trimmed.slice(versionSeparator + 1)}`;
}

export function resolveDesktopProductName(version: string): string {
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? "T3 Code (Nightly)"
    : (desktopPackageJson.productName ?? "T3 Code");
}

export const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  version: string,
  signed: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: number | undefined,
  macPasskeySigning:
    | {
        readonly entitlementsPath: string;
        readonly provisioningProfilePath: string;
      }
    | undefined,
  arch?: typeof BuildArch.Type,
) {
  const buildConfig: Record<string, unknown> = {
    appId: DESKTOP_APP_ID,
    productName: resolveDesktopProductName(version),
    artifactName: "T3-Code-${version}-${arch}.${ext}",
    electronLanguages: [...DESKTOP_ELECTRON_LANGUAGES],
    files: [...DESKTOP_FILE_EXCLUSIONS, ...resolveMacFileExclusions(arch)],
    directories: {
      buildResources: "apps/desktop/resources",
    },
    extraResources: [...DESKTOP_EXTRA_RESOURCES],
  };
  const updateChannel = resolveDesktopUpdateChannel(version);
  // A missing `publish` makes electron-builder infer a GitHub feed from
  // GH_TOKEN/GITHUB_TOKEN. The staged app has no repository to resolve it
  // against, so writing update manifests then crashes on a null config.
  buildConfig.publish = null;
  if (!isDesktopPreviewVersion(version)) {
    const publishConfig = yield* resolveGitHubPublishConfig(updateChannel);
    if (publishConfig) {
      buildConfig.publish = [publishConfig];
    } else if (mockUpdates) {
      buildConfig.publish = [
        {
          provider: "generic",
          url: resolveMockUpdateServerUrl(mockUpdateServerPort),
        },
      ];
    }
  }

  if (platform === "mac") {
    const path = yield* Path.Path;
    const repoRoot = yield* RepoRoot;
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      extendInfo: {
        // macOS 26 offers Messages/Mail codes in every text field unless opted out.
        NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
        NSLocalNetworkUsageDescription:
          "T3 Code connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
        NSScreenCaptureUsageDescription:
          "T3 Code captures the active window when you use the window capture shortcut.",
        NSRemindersFullAccessUsageDescription:
          "T3 Code adds your focused projects and their deadlines to a T3 Code reminders list.",
        NSRemindersUsageDescription:
          "T3 Code adds your focused projects and their deadlines to a T3 Code reminders list.",
        NSCalendarsFullAccessUsageDescription:
          "T3 Code adds the deadlines of your focused projects to a T3 Code calendar.",
        NSCalendarsUsageDescription:
          "T3 Code adds the deadlines of your focused projects to a T3 Code calendar.",
        NSCameraUsageDescription:
          "T3 Code lets commands run by terminals and coding agents use the camera.",
        NSMicrophoneUsageDescription:
          "T3 Code lets commands run by terminals and coding agents use the microphone.",
        // macOS lists an app under Default web browser only when it opens web
        // pages as documents as well as http and https links (see protocols).
        CFBundleDocumentTypes: [
          {
            CFBundleTypeName: "Web page",
            CFBundleTypeRole: "Viewer",
            LSHandlerRank: "Alternate",
            LSItemContentTypes: ["public.html", "public.xhtml"],
          },
        ],
      },
      protocols: [
        {
          name: "T3 Code",
          schemes: ["t3code", "t3code-dev"],
        },
        {
          name: "Web site URL",
          schemes: ["http", "https"],
          role: "Viewer",
        },
      ],
      ...(signed ? { sign: path.join(repoRoot, "scripts/sign-macos.ts") } : {}),
      ...(macPasskeySigning
        ? {
            entitlements: macPasskeySigning.entitlementsPath,
            provisioningProfile: macPasskeySigning.provisioningProfilePath,
          }
        : {}),
    };
  }

  if (platform === "mac" && target === "dmg") {
    buildConfig.dmg = {
      // Give the themed installer its own Finder volume name. Finder caches
      // DMG window backgrounds by volume name, so reusing a generic name can
      // make a newly built background look unchanged during testing.
      title: `${resolveDesktopProductName(version)} ${version} Installer`,
      background: `dmg/dmg-background-${updateChannel}.png`,
      window: {
        width: 640,
        // The DMG backend derives bounds from the image, including Finder's
        // 32px title bar. Keep the last 32px of the artwork free of content.
        height: 432,
      },
      contents: [
        { x: 166, y: 214, type: "file" },
        { x: 474, y: 214, type: "link", path: "/Applications" },
      ],
      iconSize: 120,
      iconTextSize: 12,
    };
  }

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  iconAssets: DesktopBuildIconAssets,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, iconAssets.macIconPng, verbose);
  }
});

const buildDesktopArtifactUnlocked = Effect.fn("buildDesktopArtifactUnlocked")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcess.Platform;
  if (hostPlatform === "darwin" && options.platform === "mac") {
    yield* preflightMacDesktopBuild(options.arch);
  }
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const workspaceAllowBuilds = workspaceConfig.allowBuilds ?? {};

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new UnsupportedDesktopBuildPlatformError({
      platform: options.platform,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new MissingServerProductionDependenciesError({
      manifestPath: "apps/server/package.json",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () => resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/desktop"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "workspace-overrides",
        manifestPath: "pnpm-workspace.yaml",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () => resolveCatalogDependencies(serverDependencies, workspaceCatalog, "apps/server"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "server-production",
        manifestPath: "apps/server/package.json",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "desktop-runtime",
        manifestPath: "apps/desktop/package.json",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const iconAssets = resolveDesktopBuildIconAssets(appVersion);
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `t3code-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* buildDesktopBundlesUnlocked(repoRoot, appVersion, options.verbose);
  }

  const requiredBuildInputs = [
    { artifact: "desktop-dist", artifactPath: distDirs.desktopDist },
    { artifact: "desktop-resources", artifactPath: distDirs.desktopResources },
    { artifact: "server-dist", artifactPath: distDirs.serverDist },
  ] as const;
  for (const input of requiredBuildInputs) {
    if (!(yield* fs.exists(input.artifactPath))) {
      return yield* new MissingDesktopBuildInputError({
        ...input,
        buildCommand: "vp run build:desktop",
      });
    }
  }

  // An inlined native loader resolves its prebuilds relative to the bundle and
  // quietly falls back to a slower pure-JS path, so this fails the build rather
  // than shipping a silent regression.
  {
    const chunkNames = (yield* fs.readDirectory(distDirs.serverDist)).filter((entry) =>
      entry.endsWith(".mjs"),
    );
    let totalRegions = 0;
    const inlined = new Set<string>();
    const inlinedPackages = new Set<string>();
    for (const chunkName of chunkNames) {
      const source = yield* fs.readFileString(path.join(distDirs.serverDist, chunkName));
      const scan = findInlinedExternalPackages(source);
      totalRegions += scan.regionCount;
      for (const name of scan.inlined) inlined.add(name);
      for (const name of scan.inlinedPackages) inlinedPackages.add(name);
    }
    if (inlined.size > 0) {
      return yield* new InlinedExternalPackageError({
        packages: [...inlined].sort(),
      });
    }
    // No regions at all means the scan went blind (marker format changed), not
    // that the bundle is clean.
    if (totalRegions === 0) {
      return yield* new InlinedExternalPackageError({
        packages: ["<no module regions found; the bundle scan needs updating>"],
      });
    }
    const nativeInlined: string[] = [];
    for (const name of [...inlinedPackages].sort()) {
      const packageDir = yield* findStorePackageDirectory(repoRoot, name);
      if (packageDir === null) continue;
      if (yield* hasNativeLoaderMarkers(packageDir)) nativeInlined.push(name);
    }
    if (nativeInlined.length > 0) {
      return yield* new InlinedNativePackageError({ packages: nativeInlined });
    }

    if (!inlinedPackages.has(BUNDLE_SELF_CONTAINED_SENTINEL)) {
      return yield* new ExternalizedBundleError({
        sentinel: BUNDLE_SELF_CONTAINED_SENTINEL,
        inlinedPackageCount: inlinedPackages.size,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new MissingDesktopBuildInputError({
      artifact: "bundled-server-client",
      artifactPath: bundledClientEntry,
      buildCommand: "vp run build:desktop",
    });
  }

  const webAssetBrand = resolveDesktopWebAssetBrand(appVersion);
  yield* applyWebBrandAssets(webAssetBrand, "apps/server/dist/client");
  yield* Effect.log(`[desktop-artifact] Applied ${webAssetBrand} web client branding.`);
  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  if (options.platform === "mac" && options.target === "dmg") {
    yield* stageDesktopDmgBackground(
      stageResourcesDir,
      resolveDesktopUpdateChannel(appVersion),
      options.verbose,
    );
  }
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));
  yield* stageResourceMonitor({
    repoRoot,
    stageResourcesDir,
    arch: options.arch,
    verbose: options.verbose,
  });
  yield* assertPlatformBuildResources(
    options.platform,
    stageResourcesDir,
    {
      macIconPng: path.join(repoRoot, iconAssets.macIconPng),
    },
    options.verbose,
  );

  // electron-builder filters the build resources directory out of production packages.
  const stageProdResourcesDir = path.join(stageAppDir, "apps/desktop/prod-resources");
  yield* fs.copy(stageResourcesDir, stageProdResourcesDir);

  const configuredMacPasskeySigning =
    options.platform === "mac" && options.signed
      ? yield* Effect.try({
          try: () => resolveMacPasskeySigningConfiguration(loadRepoEnv({ repoRoot })),
          catch: MacPasskeySigningConfigurationResolutionError.fromCause,
        })
      : undefined;
  const macPasskeySigning = configuredMacPasskeySigning
    ? {
        ...configuredMacPasskeySigning,
        provisioningProfilePath: path.resolve(
          repoRoot,
          configuredMacPasskeySigning.provisioningProfilePath,
        ),
      }
    : undefined;
  const macEntitlementsPath = macPasskeySigning
    ? path.join(stageAppDir, "entitlements.mac.plist")
    : undefined;
  let macWebAuthn: MacWebAuthnEntitlements | undefined;
  if (macPasskeySigning && macEntitlementsPath) {
    if (!(yield* fs.exists(macPasskeySigning.provisioningProfilePath))) {
      return yield* new MacProvisioningProfileNotFoundError({
        provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
      });
    }
    macWebAuthn = resolveMacWebAuthnEntitlements(
      yield* fs.readFileString(macPasskeySigning.provisioningProfilePath),
      macPasskeySigning,
    );
    yield* Effect.log(
      `[desktop-artifact] In-app browser passkeys: Touch ID ${macWebAuthn.touchIdKeychainAccessGroup ? "enabled" : "disabled"}, browser passkeys ${macWebAuthn.browserPasskeys ? "enabled" : "disabled"}.`,
    );
    yield* fs.writeFileString(
      macEntitlementsPath,
      renderMacPasskeyEntitlements(macPasskeySigning, macWebAuthn),
    );
  }

  const stageDependencies = resolveMergedStageDependencies({
    serverDependencies: resolvedServerDependencies,
    desktopDependencies: resolvedDesktopRuntimeDependencies,
    arch: options.arch,
    fffNodeVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
  });
  const stagePatchedDependencies = createStagePatchedDependencies(
    workspacePatchedDependencies,
    stageDependencies,
  );
  const stagePackageJson: StagePackageJson = {
    name: "t3code",
    version: appVersion,
    buildVersion: appVersion,
    t3codeCommitHash: commitHash,
    // Read by apps/desktop/src/preview/Passkeys.ts; must match the signed entitlements.
    ...(macWebAuthn ? { t3codeWebAuthn: macWebAuthn } : {}),
    private: true,
    packageManager: rootPackageJson.packageManager,
    description:
      "T3 Code is an open-source desktop app for coding agents. Work with your existing agent subscriptions, review code changes, and run commands in your projects. Connect from desktop, web, or mobile to continue working remotely.",
    license: "MIT",
    homepage: "https://t3.codes",
    author: "T3 Tools",
    main: "apps/desktop/dist-electron/boot.cjs",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      appVersion,
      options.signed,
      options.mockUpdates,
      options.mockUpdateServerPort,
      macPasskeySigning && macEntitlementsPath
        ? {
            entitlementsPath: macEntitlementsPath,
            provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
          }
        : undefined,
      options.arch,
    ),
    dependencies: stageDependencies,
    devDependencies: {
      electron: electronVersion,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);
  const stageWorkspaceConfig = createStageWorkspaceConfig({
    arch: options.arch,
    allowBuilds: workspaceAllowBuilds,
    patchedDependencies: stagePatchedDependencies,
    overrides: resolvedOverrides,
  });
  const stageWorkspaceConfigString = yield* encodeStageWorkspaceConfig(stageWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(stageAppDir, "pnpm-workspace.yaml"),
    stageWorkspaceConfigString,
  );

  if (Object.keys(stagePatchedDependencies).length > 0) {
    yield* fs.copy(path.join(repoRoot, "patches"), path.join(stageAppDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: stageAppDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod", verbose: options.verbose },
  );
  yield* stageClerkPasskeyNativeBinaries(stageAppDir, options.platform, options.arch);
  yield* stageKeyringNativeBinaries(stageAppDir, options.platform, options.arch);
  yield* stageCursorSdkPlatformPackages(
    path.join(stageAppDir, "node_modules"),
    path.join(stageProdResourcesDir, "cursor-sdk"),
  );

  // electron-builder treats several set-but-empty variables (e.g. CSC_LINK="")
  // as enabled, so copy the host env and scrub empty values instead of relying
  // on `extendEnv` merging.
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  buildEnv.npm_config_user_agent = resolvePackageManagerUserAgent(rootPackageJson.packageManager);
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  if (options.verbose) {
    const debugNamespaces = [
      "electron-builder",
      "electron-builder:*",
      ...(options.platform === "mac" ? ["electron-osx-sign*", "electron-notarize*"] : []),
    ];
    buildEnv.DEBUG = [buildEnv.DEBUG, ...debugNamespaces].filter(Boolean).join(",");
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  const builderArgs = [
    "exec",
    "--filter",
    "@t3tools/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    platformConfig.cliFlag,
    `--${options.arch}`,
    "--publish",
    "never",
  ];
  const builderCommand = yield* resolveSpawnCommand("vp", builderArgs, { env: buildEnv });
  yield* runCommand(
    ChildProcess.make(builderCommand.command, builderCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: builderCommand.shell,
    }),
    {
      label: `vp exec --filter @t3tools/desktop -- electron-builder --projectDir ${stageAppDir} ${platformConfig.cliFlag} --${options.arch} --publish never`,
      verbose: options.verbose,
    },
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new DesktopBuildDistDirectoryMissingError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new DesktopBuildNoArtifactsProducedError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  return yield* withDesktopBuildLock(repoRoot, buildDesktopArtifactUnlocked(options));
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.Literals("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: T3CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.String("target").pipe(
    Flag.withDescription("Artifact target, for example dmg/zip (env: T3CODE_DESKTOP_TARGET)."),
    Flag.optional,
  ),
  arch: Flag.Literals("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: T3CODE_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.String("build-version").pipe(
    Flag.withDescription(
      "Compiled bundle and desktop package version (env: T3CODE_DESKTOP_VERSION).",
    ),
    Flag.optional,
  ),
  outputDir: Flag.String("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: T3CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.Boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `vp run build:desktop` and use existing dist artifacts (env: T3CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.Boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: T3CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.Boolean("signed").pipe(
    Flag.withDescription("Enable signing/notarization discovery (env: T3CODE_DESKTOP_SIGNED)."),
    Flag.optional,
  ),
  verbose: Flag.Boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: T3CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.Boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: T3CODE_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.Int("mock-update-server-port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Mock update server port (env: T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for T3 Code."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
