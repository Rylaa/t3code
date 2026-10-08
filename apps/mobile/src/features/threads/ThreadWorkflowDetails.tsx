import { useAtomValue } from "@effect/atom-react";
import {
  countWorkflowAgents,
  groupWorkflowAgentsByPhase,
  presentedWorkflow,
  workflowAgentActivityLine,
  workflowAgentMetricsLabel,
  workflowProgressFraction,
  workflowScriptFileName,
  type WorkflowPhaseGroup,
} from "@t3tools/client-runtime/state/subagent-workflow";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowAgent,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import * as Haptics from "expo-haptics";
import { createContext, memo, use, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SourceFileSurface } from "../files/SourceFileSurface";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import type { SubagentRowTone } from "./threadAgentsPresentation";
import { useVisibleSecondClock } from "./use-visible-second-clock";

const PHASE_STATE_LABEL = { pending: "Not started", running: "Running", done: "Done" } as const;

type WorkflowAgentStatus = OrchestrationV2WorkflowAgent["status"];

const AGENT_STATUS = {
  pending: { tone: "stopped", label: "Waiting to start" },
  running: { tone: "working", label: "Running" },
  completed: { tone: "completed", label: "Completed" },
  failed: { tone: "failed", label: "Failed" },
  cancelled: { tone: "stopped", label: "Cancelled" },
} as const satisfies Record<
  WorkflowAgentStatus,
  { readonly tone: SubagentRowTone; readonly label: string }
>;

/**
 * A provider workflow's phases with their agents, its script, and Stop while
 * it runs, shown under its row in the Agents sheet. Its agents have no threads
 * to open. The running phase starts expanded and settled ones collapsed, so a
 * long run stays short; tapping a phase overrides that.
 */
export function ThreadWorkflowDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly workflow: OrchestrationV2SubagentWorkflow;
}) {
  const { subagent } = props;
  const active = isOrchestrationV2WorkActive(subagent.status);
  const workflow = presentedWorkflow(props.workflow, active);
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
  // Only phases the user tapped; the rest follow their state as the run moves on.
  const [expandedOverrides, setExpandedOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );

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

  const togglePhase = (key: string, expanded: boolean) => {
    void Haptics.selectionAsync();
    setExpandedOverrides((current) => new Map(current).set(key, !expanded));
  };

  return (
    <WorkflowClock enabled={counts.settled < counts.total}>
      <View className="gap-2 pb-3.5 pl-5">
        {active ? <WorkflowProgressBar fraction={workflowProgressFraction(workflow)} /> : null}
        {phases.length === 0 ? (
          <Text className="text-xs text-foreground-muted">
            {active ? "Waiting for the first phase." : "No phases reported."}
          </Text>
        ) : (
          <View className="gap-1.5">
            {phases.map((phase) => {
              const key = String(phase.index ?? "unphased");
              const expanded =
                phase.agents.length > 0 &&
                (expandedOverrides.get(key) ?? phase.state === "running");
              return (
                <View key={key} className="gap-1">
                  <WorkflowPhaseHeader
                    phase={phase}
                    expanded={expanded}
                    onToggle={
                      phase.agents.length === 0 ? undefined : () => togglePhase(key, expanded)
                    }
                  />
                  {expanded
                    ? phase.agents.map((agent) => {
                        const live =
                          active && (agent.status === "pending" || agent.status === "running");
                        return (
                          <WorkflowAgentRow
                            key={agent.index}
                            label={agent.label}
                            agentType={agent.agentType ?? null}
                            status={agent.status}
                            activity={workflowAgentActivityLine(agent)}
                            metrics={workflowAgentMetricsLabel(agent)}
                            startedAtMs={
                              agent.startedAt === undefined
                                ? null
                                : DateTime.toEpochMillis(agent.startedAt)
                            }
                            live={live}
                            // Left out while live: it moves on every progress frame.
                            endedAtMs={
                              live || agent.lastProgressAt === undefined
                                ? null
                                : DateTime.toEpochMillis(agent.lastProgressAt)
                            }
                          />
                        );
                      })
                    : null}
                </View>
              );
            })}
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
    </WorkflowClock>
  );
}

const WorkflowClockContext = createContext(0);

/**
 * One clock for every live agent's elapsed time: only the elapsed leaves read
 * it, so a tick re-renders them and nothing else.
 */
function WorkflowClock(props: { readonly enabled: boolean; readonly children: ReactNode }) {
  const nowMs = useVisibleSecondClock(props.enabled);
  return <WorkflowClockContext value={nowMs}>{props.children}</WorkflowClockContext>;
}

function WorkflowPhaseHeader(props: {
  readonly phase: WorkflowPhaseGroup;
  readonly expanded: boolean;
  readonly onToggle: (() => void) | undefined;
}) {
  const { phase } = props;
  const settled = phase.agents.filter(
    (agent) => agent.status !== "pending" && agent.status !== "running",
  ).length;
  const title = phase.title ?? "Other agents";
  const content = (
    <View className="min-h-6 flex-row items-center gap-2">
      <Text
        numberOfLines={1}
        className={cn(
          "min-w-0 flex-1 text-xs font-t3-medium",
          phase.state === "pending" ? "text-foreground-muted" : "text-foreground",
        )}
      >
        {title}
      </Text>
      <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
        {phase.agents.length > 0
          ? `${settled}/${phase.agents.length} · ${PHASE_STATE_LABEL[phase.state]}`
          : PHASE_STATE_LABEL[phase.state]}
      </Text>
      {props.onToggle === undefined ? null : (
        <SymbolView
          name="chevron.down"
          size={12}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
          style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
        />
      )}
    </View>
  );
  if (props.onToggle === undefined) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${PHASE_STATE_LABEL[phase.state]}`}
      accessibilityHint={props.expanded ? "Hides this phase's agents" : "Shows this phase's agents"}
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onToggle}
      className="active:opacity-70"
    >
      {content}
    </Pressable>
  );
}

/**
 * One workflow agent in three fixed lines: identity and elapsed, what it is
 * doing or how it ended, and its metrics. Props are the shown values only, so
 * progress frames that move nothing visible skip the render.
 */
const WorkflowAgentRow = memo(function WorkflowAgentRow(props: {
  readonly label: string;
  readonly agentType: string | null;
  readonly status: WorkflowAgentStatus;
  readonly activity: string | null;
  readonly metrics: string | null;
  readonly startedAtMs: number | null;
  readonly live: boolean;
  /** The last progress report, the closest end time the coordinator sends. */
  readonly endedAtMs: number | null;
}) {
  const status = AGENT_STATUS[props.status];
  return (
    <View
      accessible
      accessibilityLabel={[props.label, status.label, props.activity, props.metrics]
        .filter((part) => part !== null)
        .join(", ")}
      className="flex-row gap-2.5 pl-1"
    >
      <View className="min-h-5 justify-center">
        <SubagentStatusDot tone={status.tone} />
      </View>
      <View className="min-w-0 flex-1">
        <View className="min-h-5 flex-row items-center gap-2">
          <View className="min-w-0 flex-1 flex-row items-baseline gap-1.5">
            <Text
              numberOfLines={1}
              className="min-w-0 shrink text-xs font-t3-medium text-foreground"
            >
              {props.label}
            </Text>
            {props.agentType === null ? null : (
              <Text
                numberOfLines={1}
                className="max-w-[120px] min-w-0 shrink text-xs text-foreground-muted"
              >
                {props.agentType}
              </Text>
            )}
          </View>
          {props.startedAtMs === null ? null : (
            <WorkflowAgentElapsed
              startedAtMs={props.startedAtMs}
              live={props.live}
              endedAtMs={props.endedAtMs}
            />
          )}
        </View>
        <Text
          numberOfLines={1}
          className={cn(
            "text-xs",
            props.status === "failed" ? SUBAGENT_TONE_TEXT_CLASS.failed : "text-foreground-muted",
          )}
        >
          {props.activity ?? status.label}
        </Text>
        {/* A blank line keeps the row's height when no metrics arrived yet. */}
        <Text numberOfLines={1} className="text-xs tabular-nums text-foreground-muted">
          {props.metrics ?? " "}
        </Text>
      </View>
    </View>
  );
});

function WorkflowAgentElapsed(props: {
  readonly startedAtMs: number;
  readonly live: boolean;
  readonly endedAtMs: number | null;
}) {
  if (props.live) return <LiveWorkflowAgentElapsed startedAtMs={props.startedAtMs} />;
  if (props.endedAtMs === null) return null;
  return <WorkflowAgentElapsedText elapsedMs={props.endedAtMs - props.startedAtMs} />;
}

/** Reads the shared clock, inside this leaf only, so the row never re-renders for time. */
function LiveWorkflowAgentElapsed(props: { readonly startedAtMs: number }) {
  const nowMs = use(WorkflowClockContext);
  return <WorkflowAgentElapsedText elapsedMs={nowMs - props.startedAtMs} />;
}

function WorkflowAgentElapsedText(props: { readonly elapsedMs: number }) {
  if (!Number.isFinite(props.elapsedMs) || props.elapsedMs <= 0) return null;
  return (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
      {formatDuration(props.elapsedMs)}
    </Text>
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
