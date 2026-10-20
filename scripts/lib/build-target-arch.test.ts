import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { getDefaultBuildArch } from "./build-target-arch.ts";

describe("build-target-arch", () => {
  it.effect("uses the host arch when the platform supports it", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch({ archChoices: ["arm64", "x64", "universal"] }).pipe(
        Effect.provideService(HostProcess.Architecture, "x64"),
      );

      assert.equal(arch, "x64");
    }),
  );

  it.effect("falls back to the first supported arch for an unsupported host arch", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch({ archChoices: ["arm64", "x64", "universal"] }).pipe(
        Effect.provideService(HostProcess.Architecture, "ia32"),
      );

      assert.equal(arch, "arm64");
    }),
  );
});
