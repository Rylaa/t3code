// @effect-diagnostics nodeBuiltinImport:off - the sandbox child stays dependency-free so `t3 workflow-sandbox` starts fast.
// Runs as `t3 workflow-sandbox`, a child process of runWorkflowScript in
// WorkflowEngine.ts. Nothing here may run on import: inside the
// single-executable `import.meta.main` is true for the whole bundle.
import * as NodeVM from "node:vm";
import * as NodeWorkerThreads from "node:worker_threads";

// Runs inside the vm context. It receives the process's post function, keeps it
// in this closure only, and returns the receiver for host replies.
const PRELUDE = String.raw`(function install(post, argsJson, maxItemsPerCall, maxPromptChars, schemaInstruction) {
  "use strict";
  // Best effort like the rest of the vm: these allocate outside the capped JS heap
  // (Intl and Temporal objects hold ICU and time zone data in native memory).
  for (const name of [
    "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "WebAssembly", "Intl", "Temporal",
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
    "Uint32Array", "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  ]) delete globalThis[name];
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const pending = new Map();
  let nextId = 0;
  let currentPhase;
  const text = (value) => (value === undefined || value === null ? undefined : String(value).slice(0, 200));
  const checkItems = (items, name) => {
    if (!Array.isArray(items)) throw new TypeError(name + "() expects an array.");
    if (items.length > maxItemsPerCall) {
      throw new RangeError(name + "() accepts at most " + maxItemsPerCall + " items per call.");
    }
  };
  const unavailable = (name) => () => {
    throw new Error(name + " is unavailable in workflow scripts; pass times and seeds through args.");
  };
  Math.random = unavailable("Math.random()");
  Date.now = unavailable("Date.now()");
  globalThis.Date = new Proxy(Date, {
    apply: unavailable("Date()"),
    construct: (target, values, newTarget) =>
      values.length === 0 ? unavailable("new Date()")() : Reflect.construct(target, values, newTarget),
  });
  globalThis.args = parse(argsJson);
  globalThis.budget = Object.freeze({ total: null, spent: () => 0, remaining: () => Infinity });
  globalThis.phase = (title) => {
    currentPhase = text(String(title));
    post(stringify({ type: "phase", title: currentPhase }));
  };
  globalThis.log = (message) => post(stringify({ type: "log", message: String(message) }));
  globalThis.agent = async (prompt, opts = {}) => {
    if (typeof prompt !== "string") throw new TypeError("agent() expects a string prompt.");
    // Measures what the host builds, so an oversized schema is never posted.
    const schemaJson = stringify(opts.schema);
    const instruction = schemaJson === undefined ? "" : schemaInstruction + schemaJson;
    if (prompt.length + instruction.length > maxPromptChars) {
      const what = instruction ? "prompt including the schema instruction" : "prompt";
      throw new RangeError("agent() " + what + " is longer than " + maxPromptChars + " characters.");
    }
    const id = nextId++;
    const reply = await new Promise((resolve) => {
      pending.set(id, resolve);
      post(stringify({
        type: "agent",
        id,
        prompt,
        label: text(opts.label),
        phase: text(opts.phase ?? currentPhase),
        model: text(opts.model),
        schema: opts.schema,
      }));
    });
    if (reply.error !== undefined) throw new Error(reply.error);
    return reply.value;
  };
  globalThis.parallel = async (thunks) => {
    checkItems(thunks, "parallel");
    return Promise.all(thunks.map(async (thunk) => {
      try {
        return await thunk();
      } catch {
        return null;
      }
    }));
  };
  globalThis.pipeline = async (items, ...stages) => {
    checkItems(items, "pipeline");
    return Promise.all(items.map(async (item, index) => {
      try {
        let result = item;
        for (const stage of stages) result = await stage(result, item, index);
        return result;
      } catch {
        return null;
      }
    }));
  };
  return (raw) => {
    const reply = parse(raw);
    const resolve = pending.get(reply.id);
    pending.delete(reply.id);
    resolve(reply);
  };
})`;

const MAX_RESULT_CHARS = 4_000_000;

interface SandboxInit {
  readonly script: string;
  readonly args: string;
  readonly maxItemsPerCall: number;
  readonly maxPromptChars: number;
  readonly schemaInstruction: string;
}

// The main thread can be stuck in a script's busy loop and never see stdin end, so a
// worker thread kills the whole process once the parent is gone (POSIX re-parents the
// child; Windows keeps the old ppid, so it probes the parent pid there). Expects `parent`.
const WATCHDOG = `const gone = () => {
  if (process.platform !== "win32") return process.ppid !== parent;
  try { process.kill(parent, 0); return false; } catch { return true; }
};
setInterval(() => { if (gone()) process.kill(process.pid, "SIGKILL"); }, 1000);`;

const describe = (error: unknown) => {
  try {
    return String(error).trim().slice(0, 1000);
  } catch {
    return "Workflow script failed.";
  }
};

const runScript = async (context: NodeVM.Context, script: string) => {
  try {
    const source = "(async () => {\n" + script + "\n})()";
    const value: unknown = await new NodeVM.Script(source, {
      filename: "workflow.js",
    }).runInContext(context);
    const json = JSON.stringify(value) ?? "null";
    if (json.length > MAX_RESULT_CHARS) {
      return { type: "error", error: "Workflow result is larger than 4 MB." };
    }
    return { type: "result", value: json };
  } catch (error) {
    return { type: "error", error: describe(error) };
  }
};

/**
 * Runs one workflow script over newline-delimited JSON on stdio: the first
 * stdin line is the init, later lines are agent() replies; every stdout line
 * is one message, ending with `result` or `error`, after which the process exits.
 */
export async function runWorkflowSandboxProcess(): Promise<void> {
  // A script may leave an agent() promise unawaited; its rejection must not end the run.
  process.on("unhandledRejection", () => {});
  new NodeWorkerThreads.Worker(`const parent = ${process.ppid};\n${WATCHDOG}`, {
    eval: true,
  }).unref();
  const post = (message: string) => process.stdout.write(`${message}\n`);
  let receive: ((raw: string) => void) | undefined;
  const onLine = (line: string) => {
    if (receive) return receive(line);
    const init = JSON.parse(line) as SandboxInit;
    const context = NodeVM.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
    });
    const install = new NodeVM.Script(PRELUDE, { filename: "workflow-prelude.js" }).runInContext(
      context,
    );
    receive = install(
      post,
      init.args,
      init.maxItemsPerCall,
      init.maxPromptChars,
      init.schemaInstruction,
    );
    void runScript(context, init.script).then((message) =>
      process.stdout.write(`${JSON.stringify(message)}\n`, () => process.exit(0)),
    );
  };
  // Splits on "\n" only: node:readline also breaks lines at U+2028 and U+2029,
  // which JSON.stringify leaves unescaped.
  let partial = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
  // stdin ends when the server is gone.
  await new Promise((resolve) => process.stdin.once("end", resolve));
  process.exit(0);
}
