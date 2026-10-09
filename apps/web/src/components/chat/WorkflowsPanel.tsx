/**
 * Workflows right-panel surface: every provider workflow run of the thread in
 * detail, newest first. Live runs lead; settled ones collect under a Previous
 * workflows group, open by default here.
 *
 * Visualization rules:
 * - Agent order is stable. Activity and completion update rows in place.
 * - Agent rows reserve three fixed lines for identity, activity, and metrics;
 *   changing data never changes their height.
 * - Run expansion is presentation state: a live run opens expanded; a settled
 *   run starts collapsed, and a run that settles remounts collapsed.
 * - Static status dots, and elapsed timers that write text without React commits.
 */
import {
  countWorkflowAgents,
  groupWorkflowAgentsByPhase,
  presentedWorkflow,
  splitWorkflowRuns,
  workflowAgentActivityLine,
  workflowAgentMetricsLabel,
  WORKFLOW_PHASE_STATE_LABEL,
  type WorkflowPhaseGroup,
} from "@t3tools/client-runtime/state/subagent-workflow";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowAgent,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileCode2Icon,
  LoaderCircleIcon,
  SquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import {
  PreviousWorkflows,
  useThreadWorkflows,
  useWorkflowRunActions,
  WORKFLOW_AGENT_DOT_CLASS,
  workflowDisplayName,
  WorkflowProgressBar,
  WorkflowScriptDialog,
  type WorkflowSubagent,
} from "./ThreadWorkflowsPanel";

export function WorkflowsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const workflows = useThreadWorkflows(props.environmentId, props.threadId);
  const { canStop, stoppingId, stop, openThread } = useWorkflowRunActions(
    props.environmentId,
    props.threadId,
  );
  const [scriptPath, setScriptPath] = useState<string | null>(null);

  if (workflows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <WorkflowIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No workflows yet</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          When the agent runs a workflow in this thread, its phases and agents show up here as they
          work.
        </p>
      </div>
    );
  }

  const { active, previous } = splitWorkflowRuns(workflows);
  const renderRuns = (runs: ReadonlyArray<WorkflowSubagent>, label: string) => (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-2 p-0">
      {runs.map((workflow) => (
        <WorkflowRunSection
          key={workflow.id}
          workflow={workflow}
          canStop={canStop}
          stopping={stoppingId === workflow.id}
          onStop={() => void stop(workflow)}
          onShowScript={setScriptPath}
          onOpenThread={openThread}
        />
      ))}
    </ul>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          {active.length > 0 ? renderRuns(active, "Workflows") : null}
          {/* Expanded here: "Open in panel" on a settled run must show it. */}
          <PreviousWorkflows
            key={scopedThreadKey(scopeThreadRef(props.environmentId, props.threadId))}
            runs={previous}
            expanded
          >
            {renderRuns(previous, "Previous workflows")}
          </PreviousWorkflows>
        </div>
      </ScrollArea>
      {scriptPath === null ? null : (
        <WorkflowScriptDialog
          environmentId={props.environmentId}
          threadId={props.threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptPath(null)}
        />
      )}
    </div>
  );
}

function WorkflowRunSection(props: {
  readonly workflow: WorkflowSubagent;
  readonly canStop: boolean;
  readonly stopping: boolean;
  readonly onStop: () => void;
  readonly onShowScript: (scriptPath: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { workflow } = props;
  const active = isOrchestrationV2WorkActive(workflow.status);
  // Seeded on mount; a run that settles remounts collapsed under Previous workflows.
  const [expanded, setExpanded] = useState(active);
  const name = workflowDisplayName(workflow);
  const shown = presentedWorkflow(workflow.workflow, active);
  const counts = countWorkflowAgents(shown);
  const runtime = projectedSubagentsToRuntime([workflow])[0]!;
  const scriptPath = workflow.workflow.scriptPath;
  const childThreadId = workflow.childThreadId;

  return (
    <li className="flex flex-col rounded-lg border border-border/60">
      {/* The name gets its own full-width line so it never truncates to nothing. */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {expanded ? (
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <ThreadRelationshipIcon status={workflow.status} fallbackIcon={WorkflowIcon} />
        <span className="min-w-0 flex-1 break-words text-sm font-medium text-foreground/90">
          {name}
        </span>
        <span className="sr-only">{threadRelationshipStatusLabel(workflow.status)}</span>
      </button>
      {/* Indented to the name: px-2, chevron, gap, icon, gap. */}
      <div className="flex h-7 min-w-0 items-center gap-0.5 ps-13.5 pe-1">
        {/* Inline text, not flex, so truncate can show an ellipsis. */}
        <span className="min-w-0 flex-1 truncate text-2xs tabular-nums text-muted-foreground">
          {counts.failed > 0 ? (
            <span className="text-destructive">{counts.failed} failed · </span>
          ) : null}
          {counts.total > 0
            ? `${counts.settled}/${counts.total} ${counts.total === 1 ? "agent" : "agents"}`
            : null}
          {counts.total > 0 && runtime.startedAt ? " · " : null}
          <AgentElapsed agent={runtime} />
        </span>
        {scriptPath === null ? null : (
          <RunAction label="View script" onClick={() => props.onShowScript(scriptPath)}>
            <FileCode2Icon aria-hidden className="size-3.5" />
          </RunAction>
        )}
        {active && props.canStop ? (
          <RunAction
            label={`Stop workflow ${name}`}
            destructive
            disabled={props.stopping}
            onClick={props.onStop}
          >
            {props.stopping ? (
              <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
            ) : (
              <SquareIcon aria-hidden className="size-3 fill-current" />
            )}
          </RunAction>
        ) : null}
        {childThreadId === null ? null : (
          <RunAction label="Open workflow thread" onClick={() => props.onOpenThread(childThreadId)}>
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </RunAction>
        )}
      </div>
      {active ? (
        <WorkflowProgressBar name={name} workflow={workflow.workflow} className="mx-2 mb-1.5" />
      ) : null}
      {expanded ? <WorkflowRunDetails workflow={workflow} shown={shown} active={active} /> : null}
    </li>
  );
}

function WorkflowRunDetails(props: {
  readonly workflow: WorkflowSubagent;
  readonly shown: OrchestrationV2SubagentWorkflow;
  readonly active: boolean;
}) {
  const { workflow, active } = props;
  const phases = groupWorkflowAgentsByPhase(props.shown);
  const announcedPhases = phases.filter((phase) => phase.index !== null);
  return (
    <div className="flex flex-col gap-1 border-t border-border/50 px-1.5 pt-1.5 pb-1">
      {workflow.progress && active ? (
        <p className="truncate px-1 text-xs text-muted-foreground">{workflow.progress}</p>
      ) : null}
      {announcedPhases.length > 0 ? <PhaseRail phases={announcedPhases} /> : null}
      {phases.length === 0 ? (
        <p className="px-1 pb-1 text-xs text-muted-foreground">
          {active ? "Waiting for the first phase." : threadRelationshipStatusLabel(workflow.status)}
        </p>
      ) : (
        phases.map((phase) => <PhaseSection key={phase.index ?? "unphased"} phase={phase} />)
      )}
    </div>
  );
}

/** The run's shape at a glance: phases in order, each with one static dot per agent. */
function PhaseRail(props: { readonly phases: ReadonlyArray<WorkflowPhaseGroup> }) {
  return (
    <ol
      aria-label="Phases"
      className="m-0 flex list-none flex-wrap items-center gap-x-1 gap-y-1 px-1 py-0.5"
    >
      {props.phases.map((phase, index) => (
        <li key={phase.index} className="flex min-w-0 items-center gap-1">
          {index > 0 ? (
            <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/40" />
          ) : null}
          <span
            className={cn(
              "flex min-w-0 items-center gap-1 rounded-sm border px-1.5 py-0.5",
              phase.state === "running"
                ? "border-info/40"
                : phase.state === "done"
                  ? "border-success/30"
                  : "border-border/60",
            )}
          >
            <span
              className={cn(
                "max-w-32 truncate text-2xs",
                phase.state === "pending" ? "text-muted-foreground" : "text-foreground/80",
              )}
            >
              {phase.title}
            </span>
            <span className="sr-only">{WORKFLOW_PHASE_STATE_LABEL[phase.state]}</span>
            {phase.agents.length === 0 ? null : (
              <span aria-hidden className="flex min-w-0 flex-wrap items-center gap-0.5">
                {phase.agents.map((agent) => (
                  <span
                    key={agent.index}
                    className={cn("size-1.5 rounded-full", WORKFLOW_AGENT_DOT_CLASS[agent.status])}
                  />
                ))}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PhaseSection(props: { readonly phase: WorkflowPhaseGroup }) {
  const { phase } = props;
  return (
    <section className="flex flex-col">
      <div className="flex min-w-0 items-center gap-2 px-1 pt-1 text-xs">
        <span
          className={cn(
            "min-w-0 truncate font-medium",
            phase.state === "pending" ? "text-muted-foreground" : "text-foreground/80",
          )}
        >
          {phase.title ?? "Other agents"}
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {WORKFLOW_PHASE_STATE_LABEL[phase.state]}
          {phase.agents.length > 0 ? ` · ${phase.settled}/${phase.agents.length}` : null}
        </span>
      </div>
      {phase.agents.map((agent) => (
        <WorkflowAgentRow key={agent.index} {...agentRowProps(agent)} />
      ))}
    </section>
  );
}

/**
 * Only what a row shows, as primitives: progress frames replace every agent
 * object, so the memoized row skips frames that leave its text alone.
 */
function agentRowProps(agent: OrchestrationV2WorkflowAgent): WorkflowAgentRowProps {
  return {
    status: agent.status,
    label: agent.label,
    agentType:
      agent.agentType === undefined ||
      agent.agentType.toLocaleLowerCase() === agent.label.toLocaleLowerCase()
        ? null
        : agent.agentType,
    activity: workflowAgentActivityLine(agent),
    metrics: workflowAgentMetricsLabel(agent),
    startedAt: agent.startedAt === undefined ? null : DateTime.formatIso(agent.startedAt),
    completedAt: agentCompletedAt(agent),
  };
}

/**
 * When a settled agent finished: its start plus the duration it reported, or
 * else its last progress report. A cached agent did not run, so it has none.
 */
function agentCompletedAt(agent: OrchestrationV2WorkflowAgent): string | null {
  if (isOrchestrationV2WorkActive(agent.status) || agent.cached === true) return null;
  if (agent.startedAt !== undefined && agent.durationMs !== undefined) {
    return DateTime.formatIso(DateTime.add(agent.startedAt, { milliseconds: agent.durationMs }));
  }
  return agent.lastProgressAt === undefined ? null : DateTime.formatIso(agent.lastProgressAt);
}

interface WorkflowAgentRowProps {
  readonly status: OrchestrationV2WorkflowAgent["status"];
  readonly label: string;
  readonly agentType: string | null;
  readonly activity: string | null;
  readonly metrics: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** Three fixed lines: identity and elapsed, what it is doing or produced, metrics. */
const WorkflowAgentRow = memo(function WorkflowAgentRow(props: WorkflowAgentRowProps) {
  const statusLabel = threadRelationshipStatusLabel(props.status);
  const activityClassName = cn(
    "col-start-2 col-end-4 row-start-2 block truncate text-xs",
    props.status === "failed" ? "text-destructive" : "text-muted-foreground",
  );
  return (
    <div className="grid h-[3.875rem] grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1">
      <span
        aria-hidden
        className={cn(
          "col-start-1 row-start-1 size-1.5 rounded-full",
          WORKFLOW_AGENT_DOT_CLASS[props.status],
        )}
      />
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground/90">
          {props.label}
        </span>
        {props.agentType === null ? null : (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-3xs text-muted-foreground">
            {props.agentType}
          </span>
        )}
        <span className="sr-only">{statusLabel}</span>
      </span>
      <span className="col-start-3 row-start-1 min-w-12 text-right font-mono text-2xs text-muted-foreground">
        <AgentElapsed
          agent={{
            status: props.status,
            startedAt: props.startedAt,
            completedAt: props.completedAt,
          }}
        />
      </span>
      {props.activity === null ? (
        <span className={activityClassName}>{statusLabel}</span>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className={activityClassName} />}>
            {props.activity}
          </TooltipTrigger>
          <TooltipPopup side="left">{props.activity}</TooltipPopup>
        </Tooltip>
      )}
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-2xs tabular-nums text-muted-foreground/80">
        {props.metrics}
      </span>
    </div>
  );
});

function RunAction(props: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant={props.destructive ? "ghost-destructive" : "ghost-muted"}
            aria-label={props.label}
            disabled={props.disabled === true}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="left">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
