import type {
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
  OrchestrationV2WorkflowPhase,
  OrchestrationV2WorkflowRunHandles,
} from "@t3tools/contracts";

import { field, text } from "../unknownField.ts";

export const CLAUDE_WORKFLOW_TASK_TYPE = "local_workflow";

export function hasClaudeWorkflowSnapshot(
  message: unknown,
): message is { readonly workflow_progress: ReadonlyArray<unknown> } {
  const entries = field(message, "workflow_progress");
  return Array.isArray(entries) && entries.length > 0;
}

const AGENT_STATES: Record<string, OrchestrationV2WorkflowAgent["state"] | undefined> = {
  queued: "queued",
  start: "running",
  done: "completed",
  error: "failed",
};

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  const milliseconds = count(value);
  return milliseconds !== undefined && milliseconds <= 8_640_000_000_000_000
    ? milliseconds
    : undefined;
}

function preview(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

function parsePhase(entry: unknown): OrchestrationV2WorkflowPhase | null {
  const index = count(field(entry, "index"));
  const title = text(field(entry, "title"));
  return index === undefined || title === undefined ? null : { index, title };
}

function parseAgent(entry: unknown): OrchestrationV2WorkflowAgent | null {
  const index = count(field(entry, "index"));
  const label = text(field(entry, "label"));
  if (index === undefined || label === undefined) return null;
  const reportedState = text(field(entry, "state")) ?? "";
  const queuedAt = timestamp(field(entry, "queuedAt"));
  const startedAt = timestamp(field(entry, "startedAt"));
  // Claude Code reports a queued agent as started without a start time.
  const state =
    reportedState === "start" && queuedAt !== undefined && startedAt === undefined
      ? "queued"
      : Object.hasOwn(AGENT_STATES, reportedState)
        ? (AGENT_STATES[reportedState] ?? "running")
        : "running";
  const live = state === "queued" || state === "running";
  const isolation = field(entry, "isolation");
  return {
    index,
    label,
    state,
    ...optional("agentId", text(field(entry, "agentId"))),
    ...optional("phaseIndex", count(field(entry, "phaseIndex"))),
    ...optional("phaseTitle", text(field(entry, "phaseTitle"))),
    ...optional("model", text(field(entry, "model"))),
    ...optional("attempt", count(field(entry, "attempt"))),
    ...optional("totalTokens", count(field(entry, "tokens"))),
    ...optional("toolCalls", count(field(entry, "toolCalls"))),
    ...optional("durationMs", count(field(entry, "durationMs"))),
    ...optional("queuedAt", queuedAt),
    ...optional("startedAt", startedAt),
    ...optional("prompt", preview(field(entry, "promptPreview"))),
    ...optional("result", preview(field(entry, "resultPreview"))),
    ...optional("agentType", line(field(entry, "agentType"))),
    ...optional(
      "isolation",
      isolation === "worktree" || isolation === "remote" ? isolation : undefined,
    ),
    ...optional("activity", live ? activity(entry) : undefined),
    ...optional("error", line(field(entry, "error"))),
    ...optional("lastProgressAt", live ? undefined : timestamp(field(entry, "lastProgressAt"))),
    ...(field(entry, "cached") === true ? { cached: true as const } : {}),
  };
}

// Agent rows show these on one line; every frame resends them for every agent.
const LINE_MAX = 120;

/** Text for a one-line row: whitespace runs collapse, then the line cap applies. */
function line(value: unknown): string | undefined {
  const collapsed = typeof value === "string" ? text(value.replace(/\s+/g, " ")) : undefined;
  return collapsed !== undefined && collapsed.length > LINE_MAX
    ? `${collapsed.slice(0, LINE_MAX - 1)}…`
    : collapsed;
}

/**
 * The agent's latest tool call as Claude Code shows it, `Grep(pattern)`: the tool
 * name with its first argument, or whichever of the two was reported.
 */
function activity(entry: unknown): string | undefined {
  const toolName = line(field(entry, "lastToolName"));
  const toolSummary = line(field(entry, "lastToolSummary"));
  return toolName !== undefined && toolSummary !== undefined
    ? line(`${toolName}(${toolSummary})`)
    : (toolName ?? toolSummary);
}

/**
 * Only a live agent shows activity, and only a settled one its lastProgressAt,
 * which moves on every frame. Merging over a prior snapshot must not keep the other.
 */
function withoutStaleDetail(agent: OrchestrationV2WorkflowAgent): OrchestrationV2WorkflowAgent {
  const live = agent.state === "queued" || agent.state === "running";
  const { activity: _activity, lastProgressAt: _lastProgressAt, ...rest } = agent;
  return live
    ? { ...rest, ...optional("activity", agent.activity) }
    : { ...rest, ...optional("lastProgressAt", agent.lastProgressAt) };
}

/**
 * A background launch answers the model with an acknowledgement rather than the run's output, and
 * that acknowledgement is the only place the run's filesystem handles appear — nothing later on
 * the event stream repeats them.
 */
export function parseClaudeWorkflowRunHandles(
  toolUseResult: unknown,
): OrchestrationV2WorkflowRunHandles | undefined {
  if (text(field(toolUseResult, "taskType")) !== CLAUDE_WORKFLOW_TASK_TYPE) return undefined;
  const handles = {
    ...optional("runId", text(field(toolUseResult, "runId"))),
    ...optional("transcriptDir", text(field(toolUseResult, "transcriptDir"))),
    ...optional("scriptPath", text(field(toolUseResult, "scriptPath"))),
  };
  return Object.keys(handles).length === 0 ? undefined : handles;
}

const META_SCAN_LIMIT = 64 * 1024;

type MetaToken = {
  readonly kind: "string" | "code";
  /** A string's value, undefined for a template with a substitution; otherwise the code text. */
  readonly value: string | undefined;
};

type MetaValue = string | Array<MetaValue> | Map<string, MetaValue> | undefined;

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

/** The string or template literal opening at `start`, or null when it never closes. */
function scanString(
  source: string,
  start: number,
): { readonly end: number; readonly value: string | undefined } | null {
  const quote = source[start];
  let value: string | undefined = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === quote) return { end: index + 1, value };
    if (char === "\\") {
      const escaped = source[index + 1] ?? "";
      const unicode =
        escaped === "u" ? /^[0-9a-fA-F]{4}/.exec(source.slice(index + 2, index + 6)) : null;
      if (value !== undefined) {
        value +=
          unicode !== null
            ? String.fromCharCode(Number.parseInt(unicode[0], 16))
            : (ESCAPES[escaped] ?? escaped);
      }
      index += unicode !== null ? 6 : 2;
    } else if (quote === "`" && source.startsWith("${", index)) {
      value = undefined;
      let depth = 0;
      let closed = false;
      const tokens = metaTokens(source, index + 2);
      for (const token of tokens) {
        if (token.kind === "code" && token.value === "{") depth += 1;
        if (token.kind === "code" && token.value === "}" && depth-- === 0) {
          index = token.end;
          closed = true;
          break;
        }
      }
      if (!closed) return null;
    } else if (quote !== "`" && char === "\n") {
      return null;
    } else {
      if (value !== undefined) value += char;
      index += 1;
    }
  }
  return null;
}

const WORD = /[\w$]+/y;

/** JavaScript tokens from `start`, skipping comments; ends early at an unterminated literal. */
function* metaTokens(
  source: string,
  start: number,
): Generator<MetaToken & { readonly end: number }> {
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      if (end === -1) return;
      index = end + 1;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) return;
      index = end + 2;
    } else if (char === "'" || char === '"' || char === "`") {
      const scanned = scanString(source, index);
      if (scanned === null) return;
      index = scanned.end;
      yield { kind: "string", value: scanned.value, end: index };
    } else {
      WORD.lastIndex = index;
      const word = WORD.exec(source)?.[0] ?? char;
      index += word.length;
      yield { kind: "code", value: word, end: index };
    }
  }
}

const isCode = (token: MetaToken | undefined, chars: string): boolean =>
  token?.kind === "code" &&
  token.value !== undefined &&
  token.value.length === 1 &&
  chars.includes(token.value);

/**
 * Reads one value starting at `first`: a string, array or object literal, or anything else as
 * undefined. Returns the token after it, or null when a literal inside it is malformed or cut off.
 */
function readMetaValue(
  first: MetaToken | undefined,
  next: () => MetaToken | undefined,
): { readonly value: MetaValue; readonly after: MetaToken | undefined } | null {
  if (isCode(first, "[")) {
    const items: Array<MetaValue> = [];
    let token = next();
    while (!isCode(token, "]")) {
      const item = readMetaValue(token, next);
      if (item === null) return null;
      items.push(item.value);
      token = isCode(item.after, ",") ? next() : item.after;
      if (!isCode(item.after, ",") && !isCode(token, "]")) return null;
    }
    return { value: items, after: next() };
  }
  if (isCode(first, "{")) {
    const fields = new Map<string, MetaValue>();
    let key = next();
    while (!isCode(key, "}")) {
      if (key === undefined || key.value === undefined || !isCode(next(), ":")) return null;
      const field = readMetaValue(next(), next);
      if (field === null) return null;
      fields.set(key.value, field.value);
      key = isCode(field.after, ",") ? next() : field.after;
      if (!isCode(field.after, ",") && !isCode(key, "}")) return null;
    }
    return { value: fields, after: next() };
  }
  let token = first?.kind === "string" ? next() : first;
  const value = first?.kind === "string" && isCode(token, ",]})") ? first.value : undefined;
  // Anything else (a call, a concatenation, an identifier) runs to the next separator.
  let depth = 0;
  while (token !== undefined && (depth > 0 || !isCode(token, ",]})"))) {
    if (isCode(token, "[{(")) depth += 1;
    if (isCode(token, "]})")) depth -= 1;
    token = next();
  }
  return { value, after: token };
}

/**
 * The phases a workflow script's `export const meta` declares, in order. Claude Code numbers
 * them from 1 before the run starts, so the i-th one is phase i+1. Empty when the meta is
 * missing, cut off, computed, or names a phase twice, since the numbering is then unknown.
 *
 * shortcut: regex scanner, not a JS parser; upgrade if computed meta shows up.
 */
export function parseClaudeWorkflowMetaPhases(
  script: string,
): ReadonlyArray<{ readonly title: string; readonly detail?: string }> {
  const source = script.slice(0, META_SCAN_LIMIT);
  const start = /\bexport\s+const\s+meta\s*=\s*/.exec(source);
  if (start === null) return [];
  const tokens = metaTokens(source, start.index + start[0].length);
  const next = () => {
    const result = tokens.next();
    return result.done === true ? undefined : result.value;
  };
  const meta = readMetaValue(next(), next)?.value;
  const declared = meta instanceof Map ? meta.get("phases") : undefined;
  if (!Array.isArray(declared)) return [];
  const phases: Array<{ readonly title: string; readonly detail?: string }> = [];
  const seen = new Set<string>();
  for (const entry of declared) {
    if (!(entry instanceof Map)) return [];
    const rawTitle = entry.get("title");
    const title = typeof rawTitle === "string" ? text(rawTitle) : undefined;
    if (title === undefined || seen.has(title.toLowerCase())) return [];
    seen.add(title.toLowerCase());
    const detail = entry.get("detail");
    phases.push({
      title,
      ...optional("detail", typeof detail === "string" ? text(detail) : undefined),
    });
  }
  return phases;
}

function parseClaudeWorkflowProgress(message: unknown): {
  readonly phases: ReadonlyArray<OrchestrationV2WorkflowPhase>;
  readonly agents: ReadonlyArray<OrchestrationV2WorkflowAgent>;
} | null {
  if (!hasClaudeWorkflowSnapshot(message)) return null;
  const phases: OrchestrationV2WorkflowPhase[] = [];
  const agents: OrchestrationV2WorkflowAgent[] = [];
  for (const entry of message.workflow_progress) {
    const type = text(field(entry, "type"));
    if (type === "workflow_phase") {
      const phase = parsePhase(entry);
      if (phase !== null) phases.push(phase);
    } else if (type === "workflow_agent") {
      const agent = parseAgent(entry);
      if (agent !== null) agents.push(agent);
    }
  }
  return phases.length === 0 && agents.length === 0 ? null : { phases, agents };
}

/**
 * Returns undefined when nothing identifies the task as a workflow. Progress frames do not repeat
 * `task_type`, so this is the single place that decides whether a task is a coordinator; without
 * it every ordinary subagent's usage frame would mint an empty workflow and render as a
 * coordinator.
 */
export function mergeClaudeWorkflowProgress(input: {
  readonly previous: OrchestrationV2SubagentWorkflow | undefined;
  readonly name?: string | undefined;
  readonly runHandles?: OrchestrationV2WorkflowRunHandles | undefined;
  readonly message: unknown;
}): OrchestrationV2SubagentWorkflow | undefined {
  const { previous } = input;
  const snapshot = parseClaudeWorkflowProgress(input.message);
  if (
    previous === undefined &&
    input.name === undefined &&
    input.runHandles === undefined &&
    snapshot === null
  ) {
    return undefined;
  }
  const reported = field(input.message, "usage");
  const phasesByIndex = new Map(
    (previous?.phases ?? []).map((phase) => [phase.index, phase] as const),
  );
  // Only the launch carries the script; a resume's task_started carries the sent message.
  const script =
    field(input.message, "subtype") === "task_started" ? field(input.message, "prompt") : undefined;
  if (typeof script === "string") {
    parseClaudeWorkflowMetaPhases(script).forEach((phase, position) => {
      const index = position + 1;
      if (!phasesByIndex.has(index)) phasesByIndex.set(index, { index, ...phase });
    });
  }
  for (const phase of snapshot?.phases ?? []) {
    const prior = phasesByIndex.get(phase.index);
    // Frames carry no detail; it stays only while the frame names the phase the plan declared.
    phasesByIndex.set(
      phase.index,
      prior?.detail !== undefined && prior.title.toLowerCase() === phase.title.toLowerCase()
        ? { ...phase, detail: prior.detail }
        : phase,
    );
  }
  const agentsByIndex = new Map(
    (previous?.agents ?? []).map((agent) => [agent.index, agent] as const),
  );
  for (const agent of snapshot?.agents ?? []) {
    const prior = agentsByIndex.get(agent.index);
    const attempt = agent.attempt ?? prior?.attempt ?? 1;
    if (prior !== undefined && attempt < (prior.attempt ?? 1)) continue;
    const restarted = prior !== undefined && attempt > (prior.attempt ?? 1);
    const regressed =
      !restarted &&
      (((prior?.state === "completed" || prior?.state === "failed") &&
        agent.state !== prior.state) ||
        (prior?.state === "running" && agent.state === "queued"));
    agentsByIndex.set(
      agent.index,
      withoutStaleDetail(
        regressed
          ? { ...agent, ...prior }
          : {
              ...(restarted
                ? {
                    ...optional("phaseIndex", prior.phaseIndex),
                    ...optional("phaseTitle", prior.phaseTitle),
                  }
                : prior),
              ...agent,
            },
      ),
    );
  }
  const runHandles =
    input.runHandles === undefined
      ? previous?.runHandles
      : { ...previous?.runHandles, ...input.runHandles };
  return {
    ...optional("name", input.name ?? previous?.name),
    ...optional("runHandles", runHandles),
    phases: Array.from(phasesByIndex.values()).sort((left, right) => left.index - right.index),
    agents: Array.from(agentsByIndex.values()).sort((left, right) => left.index - right.index),
    ...optional("totalTokens", count(field(reported, "total_tokens")) ?? previous?.totalTokens),
    ...optional("toolCalls", count(field(reported, "tool_uses")) ?? previous?.toolCalls),
    ...optional("durationMs", count(field(reported, "duration_ms")) ?? previous?.durationMs),
  };
}
