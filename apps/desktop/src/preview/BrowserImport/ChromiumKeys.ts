// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements the
// OSCrypt key derivation Chromium uses; Effect has no equivalent.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const KEY_SALT = "saltysalt";
const KEY_LENGTH = 16;
const KEY_ITERATIONS = 1003;

export const ChromiumKeyFailure = Schema.Literals([
  "needsKeychainApproval",
  "keychainItemMissing",
  "keychainUnavailable",
  "unsupportedPlatform",
  "readFailed",
]);
export type ChromiumKeyFailure = typeof ChromiumKeyFailure.Type;

export class ChromiumKeyError extends Schema.TaggedError<ChromiumKeyError>()("ChromiumKeyError", {
  reason: ChromiumKeyFailure,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Could not obtain the Chromium cookie key: ${this.reason}.`;
  }
}

export interface ChromiumKeyMaterial {
  readonly cbcV10: Buffer;
}

const derive = (passphrase: string) =>
  NodeCrypto.pbkdf2Sync(passphrase, KEY_SALT, KEY_ITERATIONS, KEY_LENGTH, "sha1");

/**
 * Via the CLI the prompt says "security" and "Always Allow" grants trust to a
 * tool every process on the machine can invoke; in-process it names this app
 * and the grant belongs to it.
 *
 * Deliberately untimed: macOS answers this with a modal, and a timeout racing
 * the user means the prompt can be approved while nothing is left listening,
 * which reads as "approving did nothing".
 */
const readKeychainSecret = Effect.fn("ChromiumKeys.readKeychainSecret")(function* (
  service: string,
  account: string,
) {
  // Loaded lazily so a broken native binding fails the import, not app startup.
  const Keyring = yield* Effect.tryPromise({
    try: () => import("@napi-rs/keyring"),
    catch: (cause) => new ChromiumKeyError({ reason: "keychainUnavailable", cause }),
  });
  const secret = yield* Effect.try({
    try: () => new Keyring.Entry(service, account).getPassword(),
    catch: (cause) => {
      const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
      const missing = /no (matching )?entry|not found/i.test(message);
      return new ChromiumKeyError({
        reason: missing ? "keychainItemMissing" : "needsKeychainApproval",
        cause,
      });
    },
  });
  if (secret === null || secret === "") {
    return yield* new ChromiumKeyError({ reason: "keychainItemMissing" });
  }
  return secret;
});

export interface ChromiumKeyRequest {
  readonly keychainService: string | undefined;
  readonly keychainAccount: string | undefined;
}

export const resolveChromiumKeys = Effect.fn("ChromiumKeys.resolveChromiumKeys")(function* (
  request: ChromiumKeyRequest,
): Effect.fn.Return<ChromiumKeyMaterial, ChromiumKeyError> {
  if (!request.keychainService || !request.keychainAccount) {
    return yield* new ChromiumKeyError({ reason: "unsupportedPlatform" });
  }
  const secret = yield* readKeychainSecret(request.keychainService, request.keychainAccount);
  return { cbcV10: derive(secret) };
});
