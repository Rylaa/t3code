import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/**
 * `id` is stable per provider (`five_hour`, `seven_day_opus`, `primary`) so a
 * sparse turn-driven update lands on the same row a full probe produced.
 */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/**
 * `unavailable` distinguishes an account that can never report windows (API
 * key, Bedrock) from a probe that failed this time, so clients can keep the
 * last good bars for the latter and clear them for the former.
 */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/**
 * Sparse by contract: Claude's `rate_limit_event` names one window at a time
 * and Codex documents its notification as a partial. Windows merge by `id` onto
 * the instance's published snapshot; omitted windows are unchanged.
 */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
  /** The machine's current login, for sources that can switch between accounts. */
  active: Schema.optional(Schema.Boolean),
  /** The user's own name for the account in the source. */
  alias: Schema.optional(TrimmedNonEmptyString),
  /** Held out of the source's automatic rotation; a direct switch still works. */
  disabled: Schema.optional(Schema.Boolean),
  /** The source's own status word (claude-swap `usageStatus`, e.g. `ok`, `relogin_required`). */
  status: Schema.optional(TrimmedNonEmptyString),
  /** The windows are the last good reading, older than the source would act on. */
  stale: Schema.optional(Schema.Boolean),
  /** When the stored login's refresh token runs out, if the source knows. */
  loginExpiresAt: Schema.optional(IsoDateTime),
  /** The source's own weekly pace: the share it expected used by now. */
  weeklyPace: Schema.optional(
    Schema.Struct({
      expectedPercent: Schema.Number,
      aheadOfPace: Schema.Boolean,
    }),
  ),
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literals(["cliproxy", "claudeSwap"]),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
  /**
   * claude-swap only: the server's last automatic switch attempt that did
   * something, held in memory and replaced by the next one. Accounts are slot
   * ids; `detail` is fixed text, never claude-swap's own output.
   */
  autoSwitch: Schema.optional(
    Schema.Struct({
      at: IsoDateTime,
      outcome: Schema.Literals(["switched", "blocked", "failed"]),
      fromAccountId: Schema.optional(TrimmedNonEmptyString),
      toAccountId: Schema.optional(TrimmedNonEmptyString),
      /** The from account's binding usage when claude-swap switched. */
      usedPercent: Schema.optional(Schema.Number),
      window: Schema.optional(Schema.Literals(["session", "weekly"])),
      detail: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;
export type UsageLimitSourceAutoSwitch = NonNullable<UsageLimitSourceSnapshot["autoSwitch"]>;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({ instanceId: ProviderInstanceId }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

/**
 * Make one source account the machine's login, or let the source pick the one
 * with the most headroom. `email` pins the account the client saw: slot ids
 * can be renumbered between the read and the switch.
 */
export const UsageLimitSourceSwitchAccountInput = Schema.Union([
  Schema.Struct({
    sourceId: UsageLimitSourceId,
    accountId: TrimmedNonEmptyString,
    email: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    sourceId: UsageLimitSourceId,
    strategy: Schema.Literal("best"),
  }),
]);
export type UsageLimitSourceSwitchAccountInput = typeof UsageLimitSourceSwitchAccountInput.Type;

export const UsageLimitSourceSwitchAccountResult = Schema.Struct({
  /** False when the source kept the current login, e.g. it already had the most headroom. */
  switched: Schema.Boolean,
  /** The source's reason word (`switched`, `already-active`, `already-best`, ...). */
  reason: Schema.optional(TrimmedNonEmptyString),
  fromEmail: Schema.optional(TrimmedNonEmptyString),
  toEmail: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSwitchAccountResult = typeof UsageLimitSourceSwitchAccountResult.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
