import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

import { resolveChromiumKeys } from "./ChromiumKeys.ts";

const { getPassword } = vi.hoisted(() => ({ getPassword: vi.fn<() => string | null>() }));

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    getPassword = getPassword;
  },
}));

beforeEach(() => {
  getPassword.mockReset();
});

describe("macOS Chromium secrets", () => {
  const request = {
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
  } as const;

  it.effect("derives the cookie key from the keychain secret", () =>
    Effect.gen(function* () {
      getPassword.mockReturnValue("macos-secret");
      const keys = yield* resolveChromiumKeys(request);
      expect(keys.cbcV10.toString("hex")).toBe("3df7306fb1eac353289565a2f6b64f74");
    }),
  );

  it.effect("preserves a denied keychain approval", () =>
    Effect.gen(function* () {
      const denied = new Error("User denied access");
      getPassword.mockImplementation(() => {
        throw denied;
      });
      const error = yield* resolveChromiumKeys(request).pipe(Effect.flip);
      expect(error.reason).toBe("needsKeychainApproval");
      expect(error.cause).toBe(denied);
    }),
  );
});
