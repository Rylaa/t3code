// @effect-diagnostics nodeBuiltinImport:off - the engine runs scripts in a node:child_process child.
// @effect-diagnostics globalTimers:off - the wall-clock limit is a plain timer around a Promise API.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import { extractJsonObject, formatSchemaError } from "@t3tools/shared/schemaJson";
import * as Exit from "effect/Exit";
import * as JsonSchema from "effect/JsonSchema";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

export interface WorkflowAgentRequest {
  readonly index: number;
  readonly prompt: string;
  readonly label: string | undefined;
  readonly phase: string | undefined;
  readonly model: string | undefined;
}

export type WorkflowEngineEvent =
  | { readonly type: "phase"; readonly title: string }
  | { readonly type: "log"; readonly message: string }
  | {
      readonly type: "agent";
      readonly index: number;
      readonly label: string | undefined;
      readonly phase: string | undefined;
      readonly status: "running" | "completed" | "failed";
    };

export interface WorkflowLimits {
  readonly maxConcurrentAgents: number;
  readonly maxAgents: number;
  readonly maxItemsPerCall: number;
  readonly maxScriptChars: number;
  readonly maxArgsChars: number;
  readonly maxWallClockMs: number;
  readonly schemaRetries: number;
}

const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxConcurrentAgents: Math.max(1, Math.min(8, NodeOS.availableParallelism() - 2)),
  maxAgents: 1000,
  maxItemsPerCall: 4096,
  maxScriptChars: 120_000,
  maxArgsChars: 120_000,
  maxWallClockMs: 6 * 60 * 60 * 1000,
  schemaRetries: 2,
};

// Matches OrchestratorMcpPrompt.
const MAX_PROMPT_CHARS = 120_000;
// Followed by the JSON schema; the full prompt, instruction included, stays within MAX_PROMPT_CHARS.
const SCHEMA_INSTRUCTION =
  "\n\nYour final message must be only a JSON object matching this JSON Schema: ";
// The child's result is capped at 4 MB, which JSON-encoding it again at most doubles.
const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** How to start `t3 workflow-sandbox` for this install. */
export interface WorkflowSandboxCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface WorkflowEngineInput {
  readonly script: string;
  readonly args?: unknown;
  readonly sandbox: WorkflowSandboxCommand;
  readonly runAgent: (request: WorkflowAgentRequest, signal: AbortSignal) => Promise<string | null>;
  readonly onEvent?: (event: WorkflowEngineEvent) => void;
  readonly limits?: Partial<WorkflowLimits>;
}

export type WorkflowEngineResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly aborted: boolean };

const AgentMessage = Schema.Struct({
  type: Schema.Literal("agent"),
  id: Schema.Number,
  prompt: Schema.String,
  label: Schema.optionalKey(Schema.String),
  phase: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  schema: Schema.optionalKey(Schema.Unknown),
});

const decodeSandboxMessage = Schema.decodeUnknownExit(
  Schema.fromJsonString(
    Schema.Union([
      AgentMessage,
      Schema.Struct({ type: Schema.Literal("phase"), title: Schema.String }),
      Schema.Struct({ type: Schema.Literal("log"), message: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("result"),
        value: Schema.fromJsonString(Schema.Unknown),
      }),
      Schema.Struct({ type: Schema.Literal("error"), error: Schema.String }),
    ]),
  ),
);

// A model often copies Claude's script format, which declares `export const meta`.
const META_EXPORT = /^(\s*)export\s+(?=const\s+meta\b)/m;
const ABORTED: WorkflowEngineResult = { ok: false, error: "aborted", aborted: true };

const failure = (error: string): WorkflowEngineResult => ({ ok: false, error, aborted: false });

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).trim().slice(0, 1000);

// Cheap enough to run before an agent() call queues.
function checkOutputSchemaRoot(schema: unknown) {
  if (!Predicate.isObject(schema) || schema.type !== "object") {
    throw new Error('agent() schema must have { type: "object" } at its root.');
  }
  const properties = Predicate.isObject(schema.properties) ? schema.properties : {};
  const required: unknown = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    !required.every((key) => typeof key === "string" && Object.hasOwn(properties, key))
  ) {
    throw new Error('agent() schema "required" must list only keys of "properties".');
  }
}

// A compiled decoder is tens of times larger than its schema text, so only a call
// holding a slot compiles one.
function compileOutputSchema(schemaText: string) {
  const imported = SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft07(JSON.parse(schemaText)),
  );
  return Schema.decodeUnknownExit(
    Schema.fromJsonString(Schema.make<Schema.Codec<unknown>>(imported.ast)),
    { onExcessProperty: "error" },
  );
}

/**
 * Runs a workflow script in a fresh `t3 workflow-sandbox` child process. Every
 * `agent()` call in the script becomes one `runAgent` call (plus schema
 * retries); the result is the script's JSON-serialized return value.
 */
export async function runWorkflowScript(
  input: WorkflowEngineInput,
  signal: AbortSignal,
): Promise<WorkflowEngineResult> {
  const limits = { ...DEFAULT_WORKFLOW_LIMITS, ...input.limits };
  if (input.script.length > limits.maxScriptChars) {
    return failure(`Workflow script is longer than ${limits.maxScriptChars} characters.`);
  }
  let args: string;
  try {
    args = JSON.stringify(input.args) ?? "null";
  } catch (error) {
    return failure(`Workflow args are not JSON-serializable: ${errorText(error)}`);
  }
  if (args.length > limits.maxArgsChars) {
    return failure(`Workflow args are longer than ${limits.maxArgsChars} characters as JSON.`);
  }
  if (signal.aborted) return ABORTED;

  return new Promise((resolve) => {
    const controller = new AbortController();
    const queue: Array<() => void> = [];
    let active = 0;
    let agentCount = 0;
    let settled = false;

    // The child process contains crashes and out-of-memory aborts and can be killed;
    // node:vm inside it is not a security boundary against a malicious script.
    // The caller is gated elsewhere to full-access threads.
    const child = NodeChildProcess.spawn(input.sandbox.command, input.sandbox.args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      cwd: NodeOS.tmpdir(),
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--max-old-space-size=256",
        // Node on Windows needs SystemRoot to start; other platforms do not set it.
        ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      },
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

    const finish = (result: WorkflowEngineResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      controller.abort();
      child.kill("SIGKILL");
      resolve(result);
    };
    const onAbort = () => finish(ABORTED);
    const timer = setTimeout(
      () => finish(failure(`Workflow exceeded its ${limits.maxWallClockMs} ms wall-clock limit.`)),
      limits.maxWallClockMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });

    const emit = (event: WorkflowEngineEvent) => {
      if (!settled) input.onEvent?.(event);
    };
    const acquire = async () => {
      if (active < limits.maxConcurrentAgents) {
        active++;
        return;
      }
      await new Promise<void>((wake) => queue.push(wake));
    };
    // Hands the slot straight to the next queued call, so `active` never overshoots.
    const release = () => {
      const next = queue.shift();
      if (next) next();
      else active--;
    };
    const runAgent = async (request: WorkflowAgentRequest) => {
      try {
        return await input.runAgent(request, controller.signal);
      } catch {
        return null;
      }
    };

    // One entry, so calls sharing a schema compile it once.
    let lastSchema: { text: string; decode: ReturnType<typeof compileOutputSchema> } | undefined;
    const decoderFor = (text: string) => {
      if (lastSchema?.text !== text) lastSchema = { text, decode: compileOutputSchema(text) };
      return lastSchema.decode;
    };

    type AgentReply = { readonly value: unknown } | { readonly error: string };
    // Takes the full prompt and the schema text (the prompt's tail), not the decoded
    // message, so a queued call holds neither the raw schema nor a compiled decoder.
    const runQueuedAgent = async (
      request: WorkflowAgentRequest,
      schemaText: string | undefined,
    ): Promise<AgentReply> => {
      const tags = { index: request.index, label: request.label, phase: request.phase };
      await acquire();
      try {
        if (settled) return { value: null };
        let decode: ReturnType<typeof compileOutputSchema> | undefined;
        try {
          decode = schemaText === undefined ? undefined : decoderFor(schemaText);
        } catch (error) {
          return { error: errorText(error) };
        }
        emit({ type: "agent", ...tags, status: "running" });
        const attempts = decode ? limits.schemaRetries + 1 : 1;
        let prompt = request.prompt;
        let value: unknown = null;
        for (let attempt = 0; attempt < attempts && !controller.signal.aborted; attempt++) {
          const text = await runAgent({ ...request, prompt });
          if (text === null || decode === undefined) {
            value = text;
            break;
          }
          const exit = decode(extractJsonObject(text));
          if (Exit.isSuccess(exit)) {
            value = exit.value;
            break;
          }
          // Cuts only the rejection: request.prompt is already within the cap.
          prompt =
            `${request.prompt}\n\nYour previous answer was rejected:\n${formatSchemaError(exit.cause)}`.slice(
              0,
              MAX_PROMPT_CHARS,
            );
        }
        emit({ type: "agent", ...tags, status: value === null ? "failed" : "completed" });
        return { value };
      } finally {
        release();
      }
    };
    // Runs only cheap checks before queueing, so a waiting call holds at most
    // MAX_PROMPT_CHARS of prompt.
    const handleAgent = async (message: typeof AgentMessage.Type): Promise<AgentReply> => {
      if (agentCount >= limits.maxAgents) {
        return {
          error: `Workflow agent limit reached: at most ${limits.maxAgents} agent() calls.`,
        };
      }
      const schemaText = message.schema === undefined ? undefined : JSON.stringify(message.schema);
      const instruction = schemaText === undefined ? "" : SCHEMA_INSTRUCTION + schemaText;
      const prompt = message.prompt + instruction;
      if (prompt.length > MAX_PROMPT_CHARS) {
        const what = instruction ? "prompt including the schema instruction" : "prompt";
        return { error: `agent() ${what} is longer than ${MAX_PROMPT_CHARS} characters.` };
      }
      try {
        if (message.schema !== undefined) checkOutputSchemaRoot(message.schema);
      } catch (error) {
        return { error: errorText(error) };
      }
      const { label, phase, model } = message;
      return runQueuedAgent({ index: agentCount++, prompt, label, phase, model }, schemaText);
    };

    const onLine = (line: string) => {
      if (settled) return;
      if (line.length > MAX_LINE_CHARS) {
        return finish(failure("Workflow sandbox output was too large."));
      }
      const decoded = decodeSandboxMessage(line);
      if (Exit.isFailure(decoded)) {
        return finish(failure("Workflow sandbox sent an invalid message."));
      }
      const message = decoded.value;
      switch (message.type) {
        case "phase":
          return emit({ type: "phase", title: message.title.slice(0, 200) });
        case "log":
          return emit({ type: "log", message: message.message.slice(0, 200) });
        case "agent": {
          // Keeps only the id in the reply closure, not the whole message.
          const { id } = message;
          void handleAgent(message).then((reply) => {
            if (!settled) send({ id, ...reply });
          });
          return;
        }
        case "result":
          return finish({ ok: true, value: message.value });
        case "error":
          return finish(failure(message.error));
      }
    };

    // Searches only the new chunk for line ends, so a long line costs no rescans.
    let partial = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      let start = 0;
      for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
        onLine(partial + chunk.slice(start, end));
        partial = "";
        start = end + 1;
      }
      partial += chunk.slice(start);
      if (partial.length > MAX_LINE_CHARS)
        finish(failure("Workflow sandbox output was too large."));
    });
    // The child may exit before reading its input; "close" reports that.
    child.stdin.on("error", () => {});
    child.on("error", (error) =>
      finish(failure(`Workflow sandbox failed to start: ${errorText(error)}`)),
    );
    // "close", not "exit": the result line may still be in the pipe when the child exits.
    child.on("close", (code, killSignal) => {
      const memory =
        killSignal === "SIGABRT" || code === 134 ? "; it may have run out of memory" : "";
      finish(
        failure(
          `Workflow sandbox exited before the script finished (${killSignal ?? `exit code ${code}`})${memory}.`,
        ),
      );
    });
    send({
      script: input.script.replace(META_EXPORT, "$1"),
      args,
      maxItemsPerCall: limits.maxItemsPerCall,
      maxPromptChars: MAX_PROMPT_CHARS,
      schemaInstruction: SCHEMA_INSTRUCTION,
    });
  });
}
