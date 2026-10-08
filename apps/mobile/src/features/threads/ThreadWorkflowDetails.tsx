import { useAtomValue } from "@effect/atom-react";
import {
  countWorkflowAgents,
  groupWorkflowAgentsByPhase,
  workflowProgressFraction,
  workflowScriptFileName,
} from "@t3tools/client-runtime/state/subagent-workflow";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SourceFileSurface } from "../files/SourceFileSurface";

const PHASE_STATE_LABEL = { pending: "Not started", running: "Running", done: "Done" } as const;

/**
 * A provider workflow's phases, its script, and Stop while it runs, shown
 * under its row in the Agents sheet. Its agents have no threads to open, so
 * the running phase lists them by name.
 */
export function ThreadWorkflowDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly workflow: OrchestrationV2SubagentWorkflow;
}) {
  const { subagent, workflow } = props;
  const active = isOrchestrationV2WorkActive(subagent.status);
  const phases = groupWorkflowAgentsByPhase(workflow);
  const counts = countWorkflowAgents(workflow);
  const canStop = useAtomValue(
    orchestrationEnvironment.stopSubagent.permissionAtom(props.environmentId),
  );
  const stopSubagent = useAtomCommand(orchestrationEnvironment.stopSubagent, {
    label: "stop workflow",
  });
  const [stopping, setStopping] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);

  const stop = async () => {
    if (stopping) return;
    void Haptics.selectionAsync();
    setStopping(true);
    await stopSubagent({
      environmentId: props.environmentId,
      input: { threadId: subagent.threadId, subagentId: subagent.id },
    });
    setStopping(false);
  };

  return (
    <View className="gap-2 pb-3.5 pl-5">
      {active ? <WorkflowProgressBar fraction={workflowProgressFraction(workflow)} /> : null}
      {phases.length === 0 ? (
        <Text className="text-xs text-foreground-muted">
          {active ? "Waiting for the first phase." : "No phases reported."}
        </Text>
      ) : (
        <View className="gap-1.5">
          {phases.map((phase) => (
            <View key={phase.index ?? "unphased"} className="gap-0.5">
              <View className="flex-row items-center gap-2">
                <Text
                  numberOfLines={1}
                  className={cn(
                    "min-w-0 flex-1 text-xs font-t3-medium",
                    phase.state === "pending" ? "text-foreground-muted" : "text-foreground",
                  )}
                >
                  {phase.title ?? "Other agents"}
                </Text>
                <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
                  {phase.agents.length > 0
                    ? `${phase.agents.filter((agent) => agent.status !== "pending" && agent.status !== "running").length}/${phase.agents.length} · ${PHASE_STATE_LABEL[phase.state]}`
                    : PHASE_STATE_LABEL[phase.state]}
                </Text>
              </View>
              {phase.state === "running"
                ? phase.agents
                    .filter((agent) => agent.status === "running" || agent.status === "pending")
                    .map((agent) => (
                      <Text
                        key={agent.index}
                        numberOfLines={1}
                        className="pl-3 text-xs text-foreground-muted"
                      >
                        {agent.label}
                      </Text>
                    ))
                : null}
            </View>
          ))}
          {counts.failed > 0 ? (
            <Text className="text-xs text-adaptive-rose-600-400">
              {counts.failed} {counts.failed === 1 ? "agent" : "agents"} failed
            </Text>
          ) : null}
        </View>
      )}
      <View className="flex-row gap-2">
        {workflow.scriptPath === null ? null : (
          <WorkflowAction
            label={scriptOpen ? "Hide script" : "View script"}
            onPress={() => setScriptOpen((open) => !open)}
          />
        )}
        {active && canStop ? (
          <WorkflowAction
            label="Stop"
            destructive
            busy={stopping}
            accessibilityLabel={`Stop workflow ${workflow.name ?? subagent.title ?? ""}`.trim()}
            onPress={() => void stop()}
          />
        ) : null}
      </View>
      {scriptOpen && workflow.scriptPath !== null ? (
        <WorkflowScript
          environmentId={props.environmentId}
          threadId={subagent.threadId}
          scriptPath={workflow.scriptPath}
        />
      ) : null}
    </View>
  );
}

function WorkflowAction(props: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly destructive?: boolean;
  readonly busy?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.busy === true, busy: props.busy === true }}
      disabled={props.busy === true}
      onPress={props.onPress}
      className="min-h-8 flex-row items-center gap-1.5 rounded-full border border-border px-3 active:opacity-70"
    >
      {props.busy ? <ActivityIndicator size="small" /> : null}
      <Text
        className={cn(
          "text-xs font-t3-medium",
          props.destructive ? "text-adaptive-rose-600-400" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** Fetched through the contained getWorkflowScript RPC, only while open. */
function WorkflowScript(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: OrchestrationV2Subagent["threadId"];
  readonly scriptPath: string;
}) {
  const script = useEnvironmentQuery(
    orchestrationEnvironment.workflowScript({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, scriptPath: props.scriptPath },
    }),
  );
  if (script.data === null) {
    return (
      <View className="h-24 items-center justify-center rounded-xl border border-border">
        {script.error ? (
          <Text className="px-4 text-center text-xs text-adaptive-rose-600-400">
            {script.error}
          </Text>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    );
  }
  return (
    <View className="gap-1">
      {script.data.truncated ? (
        <Text className="text-xs text-foreground-muted">Showing the first 256 KB.</Text>
      ) : null}
      <View className="h-80 overflow-hidden rounded-xl border border-border">
        <SourceFileSurface
          embedded
          contents={script.data.contents}
          path={workflowScriptFileName(props.scriptPath)}
        />
      </View>
    </View>
  );
}

function WorkflowProgressBar(props: { readonly fraction: number }) {
  const percent = Math.round(props.fraction * 100);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Workflow progress"
      accessibilityValue={{ min: 0, max: 100, now: percent }}
      className="h-1 flex-row overflow-hidden rounded-full bg-border"
    >
      <View className="h-full rounded-full bg-foreground-muted" style={{ width: `${percent}%` }} />
    </View>
  );
}
