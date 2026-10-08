import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  countWorkflowAgents,
  groupWorkflowAgentsByPhase,
  workflowScriptFileName,
} from "@t3tools/client-runtime/state/subagent-workflow";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowAgent,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import {
  ArrowRightIcon,
  FileCode2Icon,
  LoaderCircleIcon,
  SquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import { FileSurfaceFailure, FileSurfaceLoading } from "../files/fileSurfaceChrome";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";

type WorkflowSubagent = OrchestrationV2Subagent & {
  readonly workflow: OrchestrationV2SubagentWorkflow;
};

const EMPTY_SUBAGENTS: ReadonlyArray<OrchestrationV2Subagent> = [];

function hasWorkflow(subagent: OrchestrationV2Subagent): subagent is WorkflowSubagent {
  return subagent.workflow !== undefined;
}

const AGENT_DOT_CLASS: Record<OrchestrationV2WorkflowAgent["status"], string> = {
  pending: "bg-muted-foreground/45",
  running: "bg-info",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/45",
};

/**
 * Thread details section for the provider workflows this thread launched
 * (Claude's Workflow tool, which Ultracode uses on every task): each run's
 * phases and agents, its script, and Stop while it runs. Renders nothing
 * until the thread has run one.
 */
export function ThreadWorkflowsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const subagents = useAtomValue(
    environmentThreadDetails.threadAtom(ref),
    (thread) => thread?.projection.subagents ?? EMPTY_SUBAGENTS,
  );
  const workflows = useMemo(
    () =>
      subagents
        .filter(hasWorkflow)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.startedAt ?? right.updatedAt) -
            DateTime.toEpochMillis(left.startedAt ?? left.updatedAt),
        ),
    [subagents],
  );
  const canStop = useAtomValue(
    orchestrationEnvironment.stopSubagent.permissionAtom(props.environmentId),
  );
  const stopSubagent = useAtomCommand(orchestrationEnvironment.stopSubagent, {
    label: "stop workflow",
  });
  const navigate = useNavigate();
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [scriptPath, setScriptPath] = useState<string | null>(null);

  if (workflows.length === 0) return null;
  const runningCount = workflows.filter((workflow) =>
    isOrchestrationV2WorkActive(workflow.status),
  ).length;

  const stop = async (workflow: WorkflowSubagent) => {
    if (stoppingId !== null) return;
    setStoppingId(workflow.id);
    await stopSubagent({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, subagentId: workflow.id },
    });
    setStoppingId(null);
  };

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-workflows-heading"
      title={runningCount > 0 ? `Workflows · ${runningCount} running` : "Workflows"}
    >
      <ul
        aria-label="Workflows"
        className="m-0 flex max-h-[24rem] list-none flex-col gap-1 overflow-y-auto overscroll-contain p-0"
      >
        {workflows.map((workflow) => (
          <WorkflowRun
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
      {scriptPath === null ? null : (
        <WorkflowScriptDialog
          environmentId={props.environmentId}
          threadId={props.threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptPath(null)}
        />
      )}
    </ThreadDetailsSection>
  );
}

function WorkflowRun(props: {
  readonly workflow: WorkflowSubagent;
  readonly canStop: boolean;
  readonly stopping: boolean;
  readonly onStop: () => void;
  readonly onShowScript: (scriptPath: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { workflow } = props;
  const active = isOrchestrationV2WorkActive(workflow.status);
  // Expansion follows the run until the user picks a side.
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
  const expanded = expandedChoice ?? active;
  const counts = countWorkflowAgents(workflow.workflow);
  const phases = groupWorkflowAgentsByPhase(workflow.workflow);
  const name = workflow.workflow.name ?? workflow.title ?? "Workflow";
  const runtime = projectedSubagentsToRuntime([workflow])[0]!;
  const scriptPath = workflow.workflow.scriptPath;
  const childThreadId = workflow.childThreadId;

  return (
    <li className="flex flex-col">
      <div className="group flex h-8 items-center gap-0.5 rounded-lg">
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="row"
          aria-expanded={expanded}
          onClick={() => setExpandedChoice(!expanded)}
        >
          <ThreadRelationshipIcon status={workflow.status} fallbackIcon={WorkflowIcon} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium leading-4 text-foreground/85">
            {name}
          </span>
          <span className="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">
            {counts.total > 0 ? `${counts.settled}/${counts.total}` : null}
            {counts.total > 0 && runtime.startedAt ? " · " : null}
            <AgentElapsed agent={runtime} compact />
          </span>
        </ThreadDetailsControl>
        {scriptPath === null ? null : (
          <WorkflowAction label="View script" onClick={() => props.onShowScript(scriptPath)}>
            <FileCode2Icon aria-hidden className="size-3.5" />
          </WorkflowAction>
        )}
        {active && props.canStop ? (
          <WorkflowAction
            label={`Stop workflow ${name}`}
            tone="destructive"
            disabled={props.stopping}
            onClick={props.onStop}
          >
            {props.stopping ? (
              <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
            ) : (
              <SquareIcon aria-hidden className="size-3 fill-current" />
            )}
          </WorkflowAction>
        ) : null}
        {childThreadId === null ? null : (
          <WorkflowAction
            label="Open workflow thread"
            onClick={() => props.onOpenThread(childThreadId)}
          >
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </WorkflowAction>
        )}
      </div>
      {expanded ? (
        <div className="flex flex-col gap-1.5 ps-9 pe-2 pt-0.5 pb-1.5">
          {workflow.progress && active ? (
            <p className="truncate text-xs text-muted-foreground">{workflow.progress}</p>
          ) : null}
          {phases.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {active
                ? "Waiting for the first phase."
                : threadRelationshipStatusLabel(workflow.status)}
            </p>
          ) : (
            phases.map((phase) => (
              <div key={phase.index ?? "unphased"} className="flex flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "min-w-0 truncate font-medium",
                      phase.state === "pending" ? "text-muted-foreground" : "text-foreground/80",
                    )}
                  >
                    {phase.title ?? "Other agents"}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {phase.state === "done"
                      ? "Done"
                      : phase.state === "running"
                        ? "Running"
                        : "Not started"}
                  </span>
                </div>
                {phase.agents.map((agent) => (
                  <div
                    key={agent.index}
                    className="flex min-w-0 items-center gap-2 ps-1 text-xs text-muted-foreground"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        AGENT_DOT_CLASS[agent.status],
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{agent.label}</span>
                    <span
                      className={cn(
                        "shrink-0 text-2xs",
                        agent.status === "failed" && "text-destructive",
                      )}
                    >
                      {threadRelationshipStatusLabel(agent.status)}
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </li>
  );
}

function WorkflowAction(props: {
  readonly label: string;
  readonly tone?: "destructive";
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            size="icon-xs"
            variant="ghost"
            part="icon"
            {...(props.tone ? { tone: props.tone } : {})}
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

/** Read-only view of a run's script, fetched through the contained getWorkflowScript RPC. */
function WorkflowScriptDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly scriptPath: string;
  readonly onClose: () => void;
}) {
  const script = useEnvironmentQuery(
    orchestrationEnvironment.workflowScript({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, scriptPath: props.scriptPath },
    }),
  );
  const fileName = workflowScriptFileName(props.scriptPath);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{fileName}</DialogTitle>
          <DialogDescription>
            <span className="block truncate">
              {script.data?.truncated
                ? `${props.scriptPath} · Showing the first 256 KB`
                : props.scriptPath}
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex h-[60vh] min-h-0 flex-col overflow-hidden border-t border-border">
          {script.data ? (
            <ReadOnlySourcePreview name={fileName} text={script.data.contents} />
          ) : script.error ? (
            <FileSurfaceFailure message={script.error} onRetry={script.refresh} />
          ) : (
            <FileSurfaceLoading />
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
