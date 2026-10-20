import type { EnvironmentMachineKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function machineKindFromAppleProductName(name: string): EnvironmentMachineKind | null {
  const normalized = name.trim().toLowerCase().replaceAll(/\s+/g, "");
  if (normalized.startsWith("macmini")) return "mac-mini";
  if (normalized.startsWith("macstudio")) return "mac-studio";
  if (normalized.startsWith("macbook")) return "laptop";
  if (normalized.startsWith("imac") || normalized.startsWith("macpro")) return "desktop";
  return null;
}

const runProbe = Effect.fn("runMachineProbe")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  return yield* processRunner
    .run({
      command: input.command,
      args: input.args,
      timeout: "5 seconds",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.map((result) => (result.code === 0 ? normalize(result.stdout) : null)),
      Effect.orElseSucceed(() => null),
    );
});

// IOKit's `product` node carries the marketing name ("Mac mini (2024)") on
// Apple silicon; Intel Macs lack it, so `hw.model` ("Macmini8,1") is the
// fallback.
export const detectServerEnvironmentMachineKind = Effect.fn("detectServerEnvironmentMachineKind")(
  function* () {
    const ioreg = yield* runProbe({ command: "ioreg", args: ["-rd1", "-n", "product"] });
    const productName = ioreg?.match(/"product-name"\s*=\s*<"([^"]+)">/)?.[1] ?? null;
    const fromProductName =
      productName === null ? null : machineKindFromAppleProductName(productName);
    if (fromProductName !== null) {
      return fromProductName;
    }
    const model = yield* runProbe({ command: "sysctl", args: ["-n", "hw.model"] });
    return model === null ? null : machineKindFromAppleProductName(model);
  },
);
