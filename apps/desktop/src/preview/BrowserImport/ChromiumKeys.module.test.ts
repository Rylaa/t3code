import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("@napi-rs/keyring", () => {
  throw new Error("Cannot find native binding");
});

it.effect("reports an unavailable keychain when the macOS binding cannot load", () =>
  Effect.gen(function* () {
    const { ChromiumKeyError, resolveChromiumKeys } = yield* Effect.promise(
      () => import("./ChromiumKeys.ts"),
    );
    const error = yield* resolveChromiumKeys({
      keychainService: "Chrome Safe Storage",
      keychainAccount: "Chrome",
    }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(ChromiumKeyError);
    expect(error.reason).toBe("keychainUnavailable");
    expect(error.cause).toBeInstanceOf(Error);
  }),
);
