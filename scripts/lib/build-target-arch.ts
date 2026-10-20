import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

export type BuildArch = "arm64" | "x64" | "universal";

interface PlatformConfig {
  readonly archChoices: ReadonlyArray<BuildArch>;
}

export const getDefaultBuildArch = Effect.fn("getDefaultBuildArch")(function* (
  platformConfig: PlatformConfig,
) {
  const hostArch = yield* HostProcess.Architecture;
  if (
    (hostArch === "arm64" || hostArch === "x64") &&
    platformConfig.archChoices.includes(hostArch)
  ) {
    return hostArch;
  }

  return platformConfig.archChoices[0] ?? "x64";
});
