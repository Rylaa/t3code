import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshot,
  UsageLimitSourceSwitchAccountInput,
  UsageLimitSourceSwitchAccountResult,
} from "@t3tools/contracts";
import {
  canSwitchToClaudeSwapAccount,
  CLAUDE_SWAP_SWITCH_EFFECT,
  formatDuration,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { StatusPill } from "../../components/StatusPill";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AccountLimits } from "./UsageLimitsSection";

/** A login expiring sooner than this is worth a warning line. */
const LOGIN_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

const REASON_TEXT: Partial<Record<string, string>> = {
  switched: "Switched. Claude on that machine now uses the new account.",
  "already-active": "That account is already active.",
  "already-best": "The active account already has the most headroom.",
  "usage-unavailable": "claude-swap could not read usage to pick an account.",
  "only-one-account": "claude-swap has only one account.",
  "no-valid-target": "No other account can take over right now.",
};

type AccountSwitchInput = Extract<
  UsageLimitSourceSwitchAccountInput,
  { readonly accountId: string }
>;

export interface ClaudeSwapSource {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly source: UsageLimitSourceSnapshot;
}

/** Every claude-swap snapshot on the given environments, failed ones included. */
export function collectClaudeSwapSources(
  presentations: LimitPresentations,
): readonly ClaudeSwapSource[] {
  const sources: ClaudeSwapSource[] = [];
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.kind !== "claudeSwap") continue;
      sources.push({ environmentId, environmentLabel: presentation.entry.target.label, source });
    }
  }
  return sources;
}

/**
 * The switch input for an account that can take over the machine's login:
 * not already active, pinned by email, and not in a state that cannot serve turns.
 */
export function switchInputFor(
  sourceId: UsageLimitSourceSnapshot["id"],
  account: UsageLimitSourceAccount,
): AccountSwitchInput | null {
  if (!account.email || !canSwitchToClaudeSwapAccount(account)) return null;
  return { sourceId, accountId: account.id, email: account.email };
}

/** The alias, else the email, else the slot. */
function accountName(account: UsageLimitSourceAccount): string {
  return account.alias ?? account.email ?? `Account ${account.id}`;
}

function resultText(result: UsageLimitSourceSwitchAccountResult): string {
  return (
    (result.reason ? REASON_TEXT[result.reason] : undefined) ??
    (result.switched ? "Switched." : "No switch was made.")
  );
}

/**
 * Confirmed switching for one environment. The command is single-flight per
 * environment, so one pending key disables every switch action there.
 */
export function useClaudeSwapSwitch(environmentId: EnvironmentId | null, environmentLabel: string) {
  const canSwitch = useAtomValue(
    serverEnvironment.switchUsageLimitSourceAccount.permissionAtom(environmentId),
  );
  const switchAccount = useAtomCommand(serverEnvironment.switchUsageLimitSourceAccount, {
    reportFailure: false,
  });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [status, setStatus] = useState<{ readonly key: string; readonly text: string } | null>(
    null,
  );

  const run = async (key: string, input: UsageLimitSourceSwitchAccountInput) => {
    if (environmentId === null) return;
    setPendingKey(key);
    setStatus(null);
    const result = await switchAccount({ environmentId, input });
    setPendingKey(null);
    if (result._tag === "Success") {
      void Haptics.notificationAsync(
        result.value.switched
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      );
      setStatus({ key, text: resultText(result.value) });
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setStatus({
      key,
      text:
        "error" in result.cause && result.cause.error instanceof Error
          ? result.cause.error.message
          : "Could not switch the Claude account.",
    });
  };

  const confirm = (
    key: string,
    input: UsageLimitSourceSwitchAccountInput,
    title: string,
    body: string,
  ) => {
    if (!canSwitch || pendingKey !== null) return;
    Alert.alert(title, `${body} ${CLAUDE_SWAP_SWITCH_EFFECT}`, [
      { text: "Cancel", style: "cancel" },
      { text: "Switch", onPress: () => void run(key, input) },
    ]);
  };

  return {
    canSwitch,
    pendingKey,
    status,
    confirmAccount: (input: AccountSwitchInput, name: string) =>
      confirm(
        input.accountId,
        input,
        "Switch Claude account?",
        `Claude on ${environmentLabel} will sign in as ${name}.`,
      ),
    confirmBest: (sourceId: UsageLimitSourceSnapshot["id"]) =>
      confirm(
        "best",
        { sourceId, strategy: "best" },
        "Switch to the best account?",
        `claude-swap picks the account with the most headroom and signs Claude on ${environmentLabel} in as it.`,
      ),
  };
}

export function SwitchButton(props: {
  readonly label: string;
  readonly busyLabel: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, busy: props.busy }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-[44px] justify-center rounded-full bg-subtle-strong px-3 py-1.5 disabled:opacity-[0.45]"
    >
      <Text className="text-sm font-t3-medium text-foreground">
        {props.busy ? props.busyLabel : props.label}
      </Text>
    </Pressable>
  );
}

/**
 * Active, Disabled and Stale, as compact pills. `stale` overrides the
 * account's own flag where the bars shown are another report's reading.
 */
export function ClaudeSwapBadges({
  account,
  stale = account.stale === true,
}: {
  readonly account: UsageLimitSourceAccount;
  readonly stale?: boolean;
}) {
  const limitReached = account.usageLimits.windows.some((window) => window.usedPercent >= 100);
  if (!account.active && !account.disabled && !stale && !limitReached) return null;
  return (
    <View className="flex-row gap-1">
      {account.active ? (
        <StatusPill
          size="compact"
          label="Active"
          pillClassName="bg-adaptive-emerald-500-a12-a16"
          textClassName="text-adaptive-emerald-700-300"
        />
      ) : null}
      {account.disabled ? (
        <StatusPill
          size="compact"
          label="Disabled"
          pillClassName="bg-subtle"
          textClassName="text-foreground-secondary"
        />
      ) : null}
      {stale ? (
        <StatusPill
          size="compact"
          label="Stale"
          pillClassName="bg-warning"
          textClassName="text-warning-foreground"
        />
      ) : null}
      {limitReached ? (
        <StatusPill
          size="compact"
          label="Limit reached"
          pillClassName="bg-danger"
          textClassName="text-danger-foreground"
        />
      ) : null}
    </View>
  );
}

/** Staleness, cswap's weekly pace and an expiring login: the lines bars cannot show. */
export function ClaudeSwapAccountNotes(props: {
  readonly account: UsageLimitSourceAccount;
  readonly now: number;
  /** Overrides the account's own flag, as on ClaudeSwapBadges. */
  readonly stale?: boolean;
}) {
  const { account, now } = props;
  const stale = props.stale ?? account.stale === true;
  const readAt = Date.parse(account.usageLimits.checkedAt);
  const loginExpiresAt = account.loginExpiresAt ? Date.parse(account.loginExpiresAt) : NaN;
  const loginWarning =
    Number.isFinite(loginExpiresAt) && loginExpiresAt - now < LOGIN_WARNING_MS
      ? loginExpiresAt <= now
        ? "Login expired. Sign in again with cswap on that machine."
        : `Login expires in ${formatDuration(loginExpiresAt - now)}. Sign in again with cswap before then.`
      : null;
  const pace = account.weeklyPace;
  if (!stale && !pace && !loginWarning) return null;
  return (
    <View className="gap-1">
      {stale && Number.isFinite(readAt) ? (
        <Text className="text-xs text-foreground-muted">
          Showing the last good reading, {formatDuration(now - readAt)} old.
        </Text>
      ) : null}
      {pace ? (
        <Text
          className={
            pace.aheadOfPace
              ? "text-xs tabular-nums text-adaptive-amber-700-300"
              : "text-xs tabular-nums text-foreground-muted"
          }
        >
          Weekly: {Math.round(pace.expectedPercent)}% expected used by now
          {pace.aheadOfPace ? " · ahead of pace" : ""}
        </Text>
      ) : null}
      {loginWarning ? (
        <Text className="text-xs text-warning-foreground">{loginWarning}</Text>
      ) : null}
    </View>
  );
}

function ClaudeSwapSourceCard(props: {
  readonly entry: ClaudeSwapSource;
  readonly labelEnvironment: boolean;
  readonly now: number;
}) {
  const { entry, now } = props;
  const { source } = entry;
  const swap = useClaudeSwapSwitch(entry.environmentId, entry.environmentLabel);
  const busy = swap.pendingKey !== null;
  const anySwitchable = source.accounts.some((account) => switchInputFor(source.id, account));
  return (
    <View className="overflow-hidden rounded-[24px] border-continuous bg-grouped-card">
      <View className="flex-row items-center justify-between gap-3 px-4 pt-3">
        <Text className="min-w-0 shrink text-sm text-foreground-muted" numberOfLines={1}>
          {props.labelEnvironment ? `${entry.environmentLabel} · ${source.label}` : source.label}
        </Text>
        {anySwitchable && source.error === undefined ? (
          <SwitchButton
            label="Switch to best"
            busyLabel="Switching…"
            busy={swap.pendingKey === "best"}
            disabled={busy || !swap.canSwitch}
            onPress={() => swap.confirmBest(source.id)}
          />
        ) : null}
      </View>
      {swap.status?.key === "best" ? (
        <Text className="px-4 pt-1 text-sm text-foreground">{swap.status.text}</Text>
      ) : null}
      {source.error ? (
        <Text className="px-4 py-3 text-sm text-warning-foreground">{source.error}</Text>
      ) : source.accounts.length === 0 ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          claude-swap has no saved accounts. Add one with cswap on that machine.
        </Text>
      ) : null}
      {source.accounts.map((account, index) => {
        const label = accountName(account);
        const switchInput = switchInputFor(source.id, account);
        const ownStatus = swap.status?.key === account.id ? swap.status.text : null;
        return (
          <AccountLimits
            key={account.id}
            driver={account.driver}
            label={label}
            instanceLabel={account.email ?? label}
            detail={account.plan}
            limits={account.usageLimits}
            now={now}
            first={index === 0}
            trailing={<ClaudeSwapBadges account={account} />}
            footer={
              <>
                <ClaudeSwapAccountNotes account={account} now={now} />
                {switchInput ? (
                  <View className="flex-row">
                    <SwitchButton
                      label="Switch"
                      busyLabel="Switching…"
                      busy={swap.pendingKey === account.id}
                      disabled={busy || !swap.canSwitch}
                      onPress={() => swap.confirmAccount(switchInput, label)}
                    />
                  </View>
                ) : null}
                {ownStatus ? <Text className="text-sm text-foreground">{ownStatus}</Text> : null}
              </>
            }
          />
        );
      })}
      {anySwitchable && !swap.canSwitch ? (
        <Text className="border-t border-border-subtle px-4 py-3 text-xs text-foreground-tertiary">
          This connection cannot switch Claude accounts.
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The machine's claude-swap logins, dead ones included, with switching. The
 * pooled bars above only hold accounts that report; this lists every slot.
 */
export function ClaudeSwapAccounts(props: {
  readonly sources: readonly ClaudeSwapSource[];
  readonly labelEnvironment: boolean;
  readonly now: number;
}) {
  if (props.sources.length === 0) return null;
  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2 px-1">
        <ProviderIcon provider="claudeAgent" size={18} />
        <Text className="text-base font-t3-medium text-foreground">Claude accounts</Text>
      </View>
      {props.sources.map((entry) => (
        <ClaudeSwapSourceCard
          key={`${entry.environmentId}:${entry.source.id}`}
          entry={entry}
          labelEnvironment={props.labelEnvironment}
          now={props.now}
        />
      ))}
    </View>
  );
}
