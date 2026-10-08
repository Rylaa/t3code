import type {
  EnvironmentId,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshot,
  UsageLimitSourceSwitchAccountInput,
  UsageLimitSourceSwitchAccountResult,
} from "@t3tools/contracts";
import {
  canSwitchToClaudeSwapAccount,
  formatDuration,
  type LimitPresentations,
  readingAge,
} from "@t3tools/shared/usageLimits";

const DAY = 24 * 60 * 60_000;

/** A switch the user asked for, with what the confirm and the outcome need to say. */
export interface ClaudeSwapSwitchRequest {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly input: UsageLimitSourceSwitchAccountInput;
  /** The alias or slot of the target; null when claude-swap picks the account. */
  readonly name: string | null;
}

export interface ClaudeSwapAccountView {
  readonly account: UsageLimitSourceAccount;
  readonly name: string;
  readonly switchTo: ClaudeSwapSwitchRequest | null;
}

export interface ClaudeSwapSourceView {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly source: UsageLimitSourceSnapshot;
  readonly accounts: readonly ClaudeSwapAccountView[];
  /** Null when there is no other account claude-swap could move to. */
  readonly switchBest: ClaudeSwapSwitchRequest | null;
}

/** An account as the user named it in claude-swap, else its slot. Never the email. */
export function claudeSwapAccountName(account: UsageLimitSourceAccount): string {
  return account.alias ?? `Account ${account.id}`;
}

function slotOrder(left: UsageLimitSourceAccount, right: UsageLimitSourceAccount): number {
  const byNumber = Number(left.id) - Number(right.id);
  return Number.isNaN(byNumber) || byNumber === 0 ? left.id.localeCompare(right.id) : byNumber;
}

/** Every claude-swap source on the given environments, accounts in slot order. */
export function collectClaudeSwapSources(
  presentations: LimitPresentations,
): readonly ClaudeSwapSourceView[] {
  const views: ClaudeSwapSourceView[] = [];
  for (const [environmentId, presentation] of presentations) {
    const environmentLabel = presentation.entry.target.label;
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.kind !== "claudeSwap") continue;
      const accounts = [...source.accounts].toSorted(slotOrder).map((account) => {
        const name = claudeSwapAccountName(account);
        return {
          account,
          name,
          switchTo:
            canSwitchToClaudeSwapAccount(account) && account.email
              ? {
                  environmentId,
                  environmentLabel,
                  input: { sourceId: source.id, accountId: account.id, email: account.email },
                  name,
                }
              : null,
        };
      });
      views.push({
        environmentId,
        environmentLabel,
        source,
        accounts,
        switchBest:
          source.error === undefined && accounts.some((view) => view.switchTo !== null)
            ? {
                environmentId,
                environmentLabel,
                input: { sourceId: source.id, strategy: "best" },
                name: null,
              }
            : null,
      });
    }
  }
  return views;
}

/** The same target, though the views are rebuilt on every snapshot. */
export function sameSwitchRequest(
  left: ClaudeSwapSwitchRequest,
  right: ClaudeSwapSwitchRequest,
): boolean {
  return (
    JSON.stringify([left.environmentId, left.input]) ===
    JSON.stringify([right.environmentId, right.input])
  );
}

/** The status line after a switch, naming accounts by alias or slot, never by email. */
export function claudeSwapSwitchOutcome(
  result: UsageLimitSourceSwitchAccountResult,
  request: ClaudeSwapSwitchRequest,
  accounts: readonly ClaudeSwapAccountView[],
): string {
  if (result.switched) {
    const toEmail = result.toEmail?.toLowerCase();
    const target =
      request.name ??
      (toEmail
        ? accounts.find((view) => view.account.email?.toLowerCase() === toEmail)?.name
        : undefined);
    return target ? `Switched to ${target}.` : "Switched accounts.";
  }
  switch (result.reason) {
    case "already-active":
      return "That account is already the active login.";
    case "already-best":
      return "The active account already has the most headroom.";
    case "usage-unavailable":
      return "claude-swap has no usage readings to compare yet.";
    case "only-one-account":
      return "claude-swap has only one account.";
    case "no-valid-target":
      return "No other account can take over right now.";
    default:
      return "claude-swap kept the current account.";
  }
}

/** A warning when the stored login runs out within a week; null otherwise. */
export function loginExpiryNotice(loginExpiresAt: string | undefined, now: number): string | null {
  if (!loginExpiresAt) return null;
  const expiresAt = Date.parse(loginExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - now > 7 * DAY) return null;
  return expiresAt <= now
    ? "Login expired. Sign in to it again with claude-swap."
    : `Login expires in ${formatDuration(expiresAt - now)}. Sign in to it again with claude-swap.`;
}

/** `3h 12m old` for bars drawn from an older reading; null for a fresh one. */
export function staleAge(account: UsageLimitSourceAccount, now: number): string | null {
  return account.stale === true ? readingAge(account.usageLimits.checkedAt, now) : null;
}
