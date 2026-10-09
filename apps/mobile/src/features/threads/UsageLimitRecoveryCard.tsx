import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, UsageLimitSourceSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import { SwitchButton, useClaudeSwapSwitch } from "../usage/ClaudeSwapAccounts";
import { useAtomCommand } from "../../state/use-atom-command";

export function UsageLimitRecoveryCard({
  thread,
  environmentId,
  environmentLabel,
  switchSourceId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
  environmentLabel: string;
  /** The claude-swap source that can move this thread's Claude login to another account. */
  switchSourceId: UsageLimitSourceSnapshot["id"] | null;
}) {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const swap = useClaudeSwapSwitch(environmentId, environmentLabel);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetAt = thread.runtime?.usageLimitResetAt ?? null;
  const canSchedule =
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  const runId = thread.latestRun?.runId;
  const recovery = thread.limitRecovery;
  const scheduled =
    recovery?.runId === runId && recovery?.resetAt === resetAt && recovery?.autoResume;
  if (
    thread.runtime?.status !== "failed" ||
    thread.runtime.lastErrorClass !== "usage_limit" ||
    !runId
  )
    return null;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    thread.snoozedUntil !== null &&
    Date.parse(thread.snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze") {
    if (!resetAt || !runId || !canSchedule) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await updateMetadata({
        environmentId,
        input: {
          threadId: thread.id,
          limitRecovery: {
            runId,
            resetAt,
            ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    } finally {
      setPending(false);
    }
  }
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text className="text-sm text-warning-foreground">
        {resetAt
          ? `Usage limit resets ${DateTime.toDateUtc(DateTime.makeUnsafe(resetAt)).toLocaleString()}.`
          : "The provider did not report a reset time. Retry manually when your limit is available."}
      </Text>
      {switchSourceId !== null ? (
        <View className="flex-row">
          <SwitchButton
            label="Switch Claude account"
            busyLabel="Switching…"
            busy={swap.pendingKey === "best"}
            disabled={swap.pendingKey !== null || !swap.canSwitch}
            onPress={() => swap.confirmBest(switchSourceId)}
          />
        </View>
      ) : null}
      {swap.status ? <Text className="text-sm text-foreground">{swap.status.text}</Text> : null}
      {canSchedule ? (
        <View className="flex-row flex-wrap gap-2">
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => void toggle("resume")}
            className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
          >
            <Text className="text-sm text-foreground">
              {scheduled ? "Cancel auto-resume" : "Resume at reset"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={pending || (!snoozed && Date.parse(resetAt!) <= Date.now())}
            onPress={() => void toggle("snooze")}
            className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
          >
            <Text className="text-sm text-foreground">
              {snoozed ? "Wake now" : "Snooze until reset"}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
