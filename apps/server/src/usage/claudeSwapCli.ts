/**
 * claude-swap (`cswap`) through its schema-v1 `--json` output: every Claude
 * account it manages, with the same window ids the native Claude probe uses,
 * and a direct switch of the machine's Claude login.
 *
 * cswap reads and refreshes credentials in the host's Keychain, so nothing
 * here runs unless the user opted in. Its messages can name accounts, so
 * errors map to fixed text and stdout or stderr is never logged.
 *
 * @module usage/claudeSwapCli
 */
import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ServerProviderUsageLimits,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSwitchAccountResult,
} from "@t3tools/contracts";
import { CLAUDE_SWAP_DEAD_STATUSES } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProcessRunner from "../processRunner.ts";
import { claudeUsageResponseToLimits } from "../provider/claudeUsageLimits.ts";
import { isCommandMissingCause } from "@t3tools/provider-core/server/snapshotProbe";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";

const Window = Schema.Struct({
  pct: Schema.Number,
  resetsAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const WeeklyWindow = Schema.Struct({
  ...Window.fields,
  expectedPct: Schema.optional(Schema.Number),
  aheadOfPace: Schema.optional(Schema.Boolean),
});
const Usage = Schema.Struct({
  fiveHour: Schema.optional(Schema.NullOr(Window)),
  sevenDay: Schema.optional(Schema.NullOr(WeeklyWindow)),
  scoped: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ ...Window.fields, name: Schema.String }))),
  ),
});
type Usage = typeof Usage.Type;

/** Everything past `number` and `email` arrived in later cswap releases, so all of it is optional. */
const Row = Schema.Struct({
  number: Schema.Number,
  email: Schema.String,
  active: Schema.optional(Schema.Boolean),
  usageStatus: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.NullOr(Usage)),
  usageFetchedAt: Schema.optional(Schema.String),
  lastGoodUsage: Schema.optional(Schema.NullOr(Usage)),
  lastGoodFetchedAt: Schema.optional(Schema.String),
  alias: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  loginExpiresAt: Schema.optional(Schema.String),
});
type ClaudeSwapRow = typeof Row.Type;

const Envelope = Schema.Struct({
  schemaVersion: Schema.Number,
  error: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
});
const ListPayload = Schema.Struct({ accounts: Schema.Array(Schema.Unknown) });
const AccountRef = Schema.NullOr(
  Schema.Struct({ number: Schema.optional(Schema.NullOr(Schema.Number)), email: Schema.String }),
);
const SwitchPayload = Schema.Struct({
  switched: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  from: Schema.optional(AccountRef),
  to: Schema.optional(AccountRef),
});

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);
const decodeListPayload = Schema.decodeUnknownOption(ListPayload);
const decodeRow = Schema.decodeUnknownOption(Row);
const decodeSwitchPayload = Schema.decodeUnknownOption(SwitchPayload);

const STATUS_MESSAGES: Readonly<Record<string, string>> = {
  relogin_required: "This login has expired. Sign in to the account again with claude-swap.",
  no_credentials: "claude-swap has no stored login for this account.",
  keychain_unavailable: "claude-swap could not read the Keychain. Unlock it on this machine.",
  token_expired: "The login token expired. Claude Code or claude-swap will refresh it.",
  foreign_credential: "The current login belongs to another account. Switching repairs it.",
};
const NO_READING = "claude-swap has no recent usage reading for this account.";

export function claudeSwapStatusMessage(status: string): string {
  return STATUS_MESSAGES[status] ?? NO_READING;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  LockError: "claude-swap is busy with another command. Try again in a moment.",
  ClaudeCodeLockTimeout: "Claude Code is refreshing its login. Try again in a moment.",
  AccountNotFoundError: "claude-swap no longer has that account. Refresh and try again.",
  ValidationError: "claude-swap rejected the account. Refresh and try again.",
  CredentialReadError: "claude-swap could not read the stored login. Is the Keychain locked?",
  SwitchError: "claude-swap could not switch accounts. Its own log has the details.",
};

// Last resort only: a locked Keychain makes cswap wait seconds per slot, and a
// switch can wait on cswap's and Claude Code's own locks first.
const LIST_TIMEOUT: Duration.Input = "120 seconds";
const SWITCH_TIMEOUT: Duration.Input = "120 seconds";
const MAX_OUTPUT_BYTES = 1024 * 1024;

const fail = (detail: string) => new UsageLimitSourceError({ detail });

/**
 * The JSON document on stdout. cswap 0.26.0 can print a warning line before
 * it when a refreshed token fails to persist, so a document that does not
 * parse whole is retried from the first line that opens an object.
 */
function parseClaudeSwapJson(stdout: string): Option.Option<unknown> {
  const whole = decodeJson(stdout);
  if (Option.isSome(whole)) return whole;
  const start = stdout.search(/^\{/m);
  return start > 0 ? decodeJson(stdout.slice(start)) : Option.none();
}

function isoOrUndefined(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function usageToLimits(usage: Usage, checkedAt: string): ServerProviderUsageLimits {
  const window = (entry: typeof Window.Type | null | undefined) =>
    entry ? { utilization: entry.pct, resets_at: entry.resetsAt ?? null } : null;
  return claudeUsageResponseToLimits({
    checkedAt,
    response: {
      rate_limits_available: true,
      rate_limits: {
        five_hour: window(usage.fiveHour),
        seven_day: window(usage.sevenDay),
        model_scoped: (usage.scoped ?? []).map((entry) => ({
          display_name: entry.name,
          utilization: entry.pct,
          resets_at: entry.resetsAt ?? null,
        })),
      },
    },
  }).limits;
}

/**
 * One cswap row as a source account. Window ids match the native Claude
 * instance's, so the active account pools with the instance by email. A row
 * whose measurement is too old for cswap to act on still draws its last good
 * bars, marked stale, rather than an empty row that hides the account.
 */
function claudeSwapRowToAccount(row: ClaudeSwapRow, now: string): UsageLimitSourceAccount {
  const status = row.usageStatus?.trim() || "unavailable";
  const email = row.email.trim();
  const alias = row.alias?.trim();
  const loginExpiresAt = isoOrUndefined(row.loginExpiresAt);
  const reading = row.usage
    ? { usage: row.usage, fetchedAt: row.usageFetchedAt, stale: false }
    : row.lastGoodUsage
      ? { usage: row.lastGoodUsage, fetchedAt: row.lastGoodFetchedAt, stale: true }
      : null;
  const dead = CLAUDE_SWAP_DEAD_STATUSES.has(status);
  const checkedAt = (reading && isoOrUndefined(reading.fetchedAt)) ?? now;
  const usageLimits =
    status === "api_key"
      ? makeUnavailableUsageLimits({
          checkedAt: now,
          reason: "unsupported",
          message: "API-key logins have no subscription limits.",
        })
      : dead || !reading
        ? makeUnavailableUsageLimits({
            checkedAt: now,
            reason: "probeFailed",
            message: claudeSwapStatusMessage(status),
          })
        : usageToLimits(reading.usage, checkedAt);
  const sevenDay = !dead && reading ? reading.usage.sevenDay : undefined;
  return {
    id: String(row.number),
    driver: ProviderDriverKind.make("claudeAgent"),
    ...(email ? { email } : {}),
    usageLimits,
    active: row.active === true,
    ...(alias ? { alias } : {}),
    ...(row.disabled === true ? { disabled: true } : {}),
    status,
    ...(reading?.stale && usageLimits.unavailable === undefined ? { stale: true } : {}),
    ...(loginExpiresAt ? { loginExpiresAt } : {}),
    ...(sevenDay?.expectedPct !== undefined && sevenDay.aheadOfPace !== undefined
      ? {
          weeklyPace: { expectedPercent: sevenDay.expectedPct, aheadOfPace: sevenDay.aheadOfPace },
        }
      : {}),
  };
}

type ClaudeSwapSwitchTarget = { readonly accountId: string } | { readonly strategy: "best" };

export const makeClaudeSwapCli = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;

  /** Runs cswap and returns its JSON document, with every failure mapped to fixed text. */
  const runJson = Effect.fn("ClaudeSwapCli.runJson")(function* (
    binaryPath: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Input,
  ) {
    const output = yield* runner
      .run({
        command: expandHomePath(binaryPath.trim()) || "cswap",
        args,
        // EOF for any prompt cswap would otherwise wait on until the timeout.
        stdin: "",
        timeout,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        // cswap acts on CLAUDE_CONFIG_DIR when it is set; the switch targets
        // the default login that default Claude instances share.
        env: { NO_COLOR: "1", CLAUDE_CONFIG_DIR: undefined },
      })
      .pipe(
        Effect.catchTags({
          ProcessSpawnError: (error) =>
            Effect.fail(
              isCommandMissingCause(error.cause)
                ? fail("claude-swap (cswap) was not found. Install it or set its path in Settings.")
                : fail("claude-swap (cswap) could not be started."),
            ),
          ProcessTimeoutError: () => Effect.fail(fail("claude-swap did not answer in time.")),
          ProcessOutputLimitError: () =>
            Effect.fail(fail("claude-swap returned more output than expected.")),
          ProcessStdinError: () => Effect.fail(fail("claude-swap could not be started.")),
          ProcessReadError: () => Effect.fail(fail("claude-swap's output could not be read.")),
        }),
      );
    const document = parseClaudeSwapJson(output.stdout);
    if (Option.isNone(document)) {
      return yield* fail(
        output.code === 0 || output.code === null
          ? "claude-swap returned output T3 Code could not read."
          : `claude-swap failed (exit code ${output.code}).`,
      );
    }
    const envelope = decodeEnvelope(document.value);
    if (Option.isNone(envelope) || envelope.value.schemaVersion !== 1) {
      return yield* fail("This claude-swap version is not supported. Update claude-swap.");
    }
    const errorType = envelope.value.error?.type;
    if (envelope.value.error) {
      return yield* fail(
        (errorType && ERROR_MESSAGES[errorType]) ??
          (errorType && /^[A-Za-z]{1,64}$/.test(errorType)
            ? `claude-swap reported an error (${errorType}).`
            : "claude-swap reported an error."),
      );
    }
    return document.value;
  });

  const readAccounts = Effect.fn("ClaudeSwapCli.readAccounts")(function* (
    binaryPath: string,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const document = yield* runJson(binaryPath, ["--list", "--json"], LIST_TIMEOUT);
    const payload = decodeListPayload(document);
    if (Option.isNone(payload)) {
      return yield* fail("claude-swap returned output T3 Code could not read.");
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    // One malformed row from a newer cswap must not hide every other account.
    return payload.value.accounts.flatMap((raw) => {
      const row = decodeRow(raw);
      return Option.isSome(row) ? [claudeSwapRowToAccount(row.value, now)] : [];
    });
  });

  const switchTo = Effect.fn("ClaudeSwapCli.switchTo")(function* (
    binaryPath: string,
    target: ClaudeSwapSwitchTarget,
  ): Effect.fn.Return<UsageLimitSourceSwitchAccountResult, UsageLimitSourceError> {
    // Slot numbers, never emails: an email in several organizations is ambiguous.
    const args =
      "strategy" in target
        ? ["--switch", "--strategy", target.strategy, "--json"]
        : ["--switch-to", target.accountId, "--json"];
    const document = yield* runJson(binaryPath, args, SWITCH_TIMEOUT);
    const payload = decodeSwitchPayload(document);
    if (Option.isNone(payload)) {
      return yield* fail("claude-swap returned output T3 Code could not read.");
    }
    const { switched, reason, from, to } = payload.value;
    const fromEmail = from?.email.trim();
    const toEmail = to?.email.trim();
    const trimmedReason = reason?.trim();
    return {
      switched,
      ...(trimmedReason ? { reason: trimmedReason } : {}),
      ...(fromEmail ? { fromEmail } : {}),
      ...(toEmail ? { toEmail } : {}),
    };
  });

  return { readAccounts, switchTo };
});
