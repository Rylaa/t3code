// @effect-diagnostics nodeBuiltinImport:off - the tests start real sandbox processes and list them with ps.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import {
  runWorkflowScript,
  type WorkflowAgentRequest,
  type WorkflowEngineEvent,
  type WorkflowEngineInput,
  type WorkflowSandboxCommand,
} from "./WorkflowEngine.ts";

// The real `t3 workflow-sandbox`, run from source; Node strips the types.
const sandbox: WorkflowSandboxCommand = {
  command: process.execPath,
  args: [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), "workflow-sandbox"],
};

// A stand-in child for checks of the host side of the protocol.
const fakeSandbox = (source: string): WorkflowSandboxCommand => ({
  command: process.execPath,
  args: ["-e", source],
});

const echo = async (request: WorkflowAgentRequest) => `echo:${request.prompt}`;

const run = (script: string, overrides: Partial<WorkflowEngineInput> = {}) =>
  runWorkflowScript(
    { script, sandbox, runAgent: echo, ...overrides },
    new AbortController().signal,
  );

// Live (not yet reaped zombie) workflow-sandbox children of this test process.
const liveSandboxPids = () =>
  NodeChildProcess.execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([, ppid, stat, ...command]) =>
        Number(ppid) === process.pid &&
        !stat?.startsWith("Z") &&
        command.join(" ").includes("workflow-sandbox"),
    )
    .map(([pid]) => Number(pid));

// Starts a run whose agent() calls wait for the abort, and aborts it right
// after spawning or once the script has called agent().
const abortRun = async (script: string, abortAt: "spawn" | "agent") => {
  const controller = new AbortController();
  const reached = Promise.withResolvers<void>();
  const pending = runWorkflowScript(
    {
      script,
      sandbox,
      runAgent: (_request, signal) => {
        reached.resolve();
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)));
      },
    },
    controller.signal,
  );
  if (abortAt === "agent") await reached.promise;
  controller.abort();
  return pending;
};

const PERSON_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, count: { type: "number" } },
  required: ["name", "count"],
  additionalProperties: false,
};

describe("runWorkflowScript sandbox", () => {
  it("hides host globals and blocks code generation from strings", async () => {
    const result = await run(`
      const caught = (fn) => { try { fn(); return "no throw"; } catch (error) { return error.name; } };
      return {
        globals: [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof structuredClone],
        eval: caught(() => eval("1")),
        fn: caught(() => new Function("return 1")),
      };
    `);
    expect(result).toEqual({
      ok: true,
      value: {
        globals: ["undefined", "undefined", "undefined", "undefined", "undefined"],
        eval: "EvalError",
        fn: "EvalError",
      },
    });
  });

  it("makes the clock and randomness throw", async () => {
    const result = await run(`
      const caught = (fn) => { try { fn(); return "no throw"; } catch (error) { return error.message; } };
      return [caught(() => Date.now()), caught(() => Math.random()), caught(() => new Date()), new Date(0).getTime()];
    `);
    expect(result.ok && result.value).toEqual([
      expect.stringContaining("Date.now() is unavailable"),
      expect.stringContaining("Math.random() is unavailable"),
      expect.stringContaining("new Date() is unavailable"),
      0,
    ]);
  });

  it("removes the globals that allocate outside the capped heap", async () => {
    const result = await run(`
      let typed;
      try { new Uint8Array(5e8); typed = "allocated"; } catch (error) { typed = error.name; }
      const offHeap = /Array|Buffer|DataView|Atomics|WebAssembly|Intl|Temporal/;
      return [typed, Object.getOwnPropertyNames(globalThis).filter((name) => offHeap.test(name))];
    `);
    expect(result).toEqual({ ok: true, value: ["ReferenceError", ["Array"]] });
  });

  it("accepts Claude's export const meta header", async () => {
    const result = await run(`export const meta = { name: "demo" };\nreturn meta.name;`);
    expect(result).toEqual({ ok: true, value: "demo" });
  });

  it(
    "stops a script spinning after an agent() call when the signal aborts",
    { timeout: 10_000 },
    async () => {
      const controller = new AbortController();
      const reached = Promise.withResolvers<AbortSignal>();
      const pending = runWorkflowScript(
        {
          script: `agent("hang"); while (true) {}`,
          sandbox,
          runAgent: (_request, signal) => {
            reached.resolve(signal);
            return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)));
          },
        },
        controller.signal,
      );
      const agentSignal = await reached.promise;
      controller.abort();
      expect(await pending).toEqual({ ok: false, error: "aborted", aborted: true });
      expect(agentSignal.aborted).toBe(true);
    },
  );

  it("stops a script at the wall-clock limit", async () => {
    const result = await run(`while (true) {}`, { limits: { maxWallClockMs: 50 } });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("wall-clock limit"),
      aborted: false,
    });
  });
});

describe("runWorkflowScript agents", () => {
  it("resolves agent() to the child's text", async () => {
    const requests: Array<WorkflowAgentRequest> = [];
    const result = await run(`return await agent("hi", { label: "Greeter", model: "m1" });`, {
      runAgent: async (request) => {
        requests.push(request);
        return "hello";
      },
    });
    expect(result).toEqual({ ok: true, value: "hello" });
    expect(requests).toEqual([
      { index: 0, prompt: "hi", label: "Greeter", phase: undefined, model: "m1" },
    ]);
  });

  it("resolves agent() to null when runAgent returns null or throws", async () => {
    const result = await run(`return [await agent("null"), await agent("throw")];`, {
      runAgent: async (request) => {
        if (request.prompt === "null") return null;
        throw new Error("child crashed");
      },
    });
    expect(result).toEqual({ ok: true, value: [null, null] });
  });

  it("turns a throwing parallel() thunk into null", async () => {
    const result = await run(
      `return await parallel([() => agent("a"), () => { throw new Error("x"); }, () => 3]);`,
    );
    expect(result).toEqual({ ok: true, value: ["echo:a", null, 3] });
  });

  it("drops a pipeline() item whose stage throws and skips its later stages", async () => {
    const logs: Array<string> = [];
    const result = await run(
      `return await pipeline(
        [1, 2, 3],
        (n) => n * 10,
        (prev, item, index) => { if (item === 2) throw new Error("bad"); return prev + index; },
        (prev, item) => { log("third " + item); return prev; },
      );`,
      { onEvent: (event) => event.type === "log" && logs.push(event.message) },
    );
    expect(result).toEqual({ ok: true, value: [10, null, 32] });
    expect(logs.toSorted()).toEqual(["third 1", "third 3"]);
  });

  it("never runs more than maxConcurrentAgents at once and runs every call", async () => {
    const requested = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let inFlight = 0;
    let maxInFlight = 0;
    const pending = run(
      `const all = parallel(Array.from({ length: 6 }, (_, i) => () => agent("a" + i)));
       log("requested");
       return await all;`,
      {
        limits: { maxConcurrentAgents: 2 },
        onEvent: (event) => event.type === "log" && requested.resolve(),
        runAgent: async (request) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await gate.promise;
          inFlight--;
          return request.prompt;
        },
      },
    );
    await requested.promise;
    expect(inFlight).toBe(2);
    gate.resolve();
    expect(await pending).toEqual({ ok: true, value: ["a0", "a1", "a2", "a3", "a4", "a5"] });
    expect(maxInFlight).toBe(2);
  });

  it("throws inside the script past maxAgents", async () => {
    let calls = 0;
    const result = await run(
      `await agent("one");
       try { await agent("two"); return "no throw"; } catch (error) { return error.message; }`,
      {
        limits: { maxAgents: 1 },
        runAgent: async () => {
          calls++;
          return "ok";
        },
      },
    );
    expect(result).toEqual({ ok: true, value: expect.stringContaining("agent limit reached") });
    expect(calls).toBe(1);
  });

  it("emits phase, log and agent events in order", async () => {
    const events: Array<WorkflowEngineEvent> = [];
    await run(
      `phase("Scan");
       log("x".repeat(500));
       await agent("a");
       await agent("b", { phase: "Other", label: "B" });
       phase("s".repeat(500));`,
      {
        onEvent: (event) => events.push(event),
        runAgent: async (request) => (request.prompt === "a" ? "ok" : null),
      },
    );
    expect(events).toEqual([
      { type: "phase", title: "Scan" },
      { type: "log", message: "x".repeat(200) },
      { type: "agent", index: 0, label: undefined, phase: "Scan", status: "running" },
      { type: "agent", index: 0, label: undefined, phase: "Scan", status: "completed" },
      { type: "agent", index: 1, label: "B", phase: "Other", status: "running" },
      { type: "agent", index: 1, label: "B", phase: "Other", status: "failed" },
      { type: "phase", title: "s".repeat(200) },
    ]);
  });

  it("clamps a phase title from the sandbox on the host too", async () => {
    const events: Array<WorkflowEngineEvent> = [];
    // Skips the prelude's clamp.
    const child = `process.stdout.write(
      JSON.stringify({ type: "phase", title: "t".repeat(500) }) + "\\n" +
      JSON.stringify({ type: "result", value: "null" }) + "\\n");
      process.stdin.resume();`;
    await run("", { sandbox: fakeSandbox(child), onEvent: (event) => events.push(event) });
    expect(events).toEqual([{ type: "phase", title: "t".repeat(200) }]);
  });
});

describe("runWorkflowScript schema", () => {
  const schemaRun = (replies: Array<string>, limits: WorkflowEngineInput["limits"] = {}) => {
    const prompts: Array<string> = [];
    const result = run(`return await agent("count", { schema: args });`, {
      args: PERSON_SCHEMA,
      limits,
      runAgent: async (request) => {
        prompts.push(request.prompt);
        return replies[prompts.length - 1] ?? null;
      },
    });
    return { result, prompts };
  };

  it("throws before any runAgent call for a bad schema", async () => {
    let calls = 0;
    const result = await run(
      `const caught = async (schema) => { try { await agent("x", { schema }); return "no throw"; } catch (error) { return error.message; } };
       return [
         await caught({ type: "array" }),
         await caught({ type: "object", properties: { a: {} }, required: ["b"] }),
         await caught({ type: "object", properties: { a: { type: "string", pattern: "^x" } } }),
       ];`,
      {
        runAgent: async () => {
          calls++;
          return "{}";
        },
      },
    );
    expect(result.ok && result.value).toEqual([
      expect.stringContaining('{ type: "object" }'),
      expect.stringContaining('"required"'),
      expect.stringContaining("pattern"),
    ]);
    expect(calls).toBe(0);
  });

  // A compiled decoder is far larger than its schema text, so a call waiting for a
  // slot must not hold one. A bad schema shows when the compile runs: its error
  // reaches the script only after the call ahead of it frees the single slot.
  it("compiles a schema only once the call holds a slot", async () => {
    const queued = Promise.withResolvers<string>();
    const prompts: Array<string> = [];
    const result = await run(
      `const held = agent("held").then(() => "held");
       const bad = agent("bad", { schema: { type: "object", properties: { a: { type: "string", pattern: "^x" } } } })
         .then(() => "accepted", (error) => error.message);
       log("queued");
       return [await Promise.race([held, bad]), await bad];`,
      {
        limits: { maxConcurrentAgents: 1 },
        onEvent: (event) => event.type === "log" && queued.resolve("ok"),
        runAgent: (request) => {
          prompts.push(request.prompt);
          return queued.promise;
        },
      },
    );
    expect(result).toEqual({ ok: true, value: ["held", expect.stringContaining("pattern")] });
    expect(prompts).toEqual(["held"]);
  });

  it("decodes a valid object and tells the agent the schema", async () => {
    const { result, prompts } = schemaRun(['Here you go: {"name":"n","count":2}']);
    expect(await result).toEqual({ ok: true, value: { name: "n", count: 2 } });
    expect(prompts[0]).toContain(
      `Your final message must be only a JSON object matching this JSON Schema: ${JSON.stringify(PERSON_SCHEMA)}`,
    );
  });

  it("retries with the failure summary and then succeeds", async () => {
    const { result, prompts } = schemaRun(['{"name":1,"count":2}', '{"name":"n","count":2}']);
    expect(await result).toEqual({ ok: true, value: { name: "n", count: 2 } });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Your previous answer was rejected:\nInvalid type");
  });

  it("resolves null once retries are exhausted", async () => {
    const { result, prompts } = schemaRun(["nope", "nope", "nope", "nope"], { schemaRetries: 2 });
    expect(await result).toEqual({ ok: true, value: null });
    expect(prompts).toHaveLength(3);
  });

  it("rejects an extra property", async () => {
    const { result } = schemaRun(['{"name":"n","count":2,"extra":true}'], { schemaRetries: 0 });
    expect(await result).toEqual({ ok: true, value: null });
  });

  it("caps the prompt including the schema instruction, retries included", async () => {
    const instruction =
      "\n\nYour final message must be only a JSON object matching this JSON Schema: ";
    const emptySchema = '{"type":"object","properties":{"a":{"type":"string","description":""}}}';
    // "p" plus the instruction for schema(fits) is exactly 120000 characters.
    const fits = 120_000 - 1 - instruction.length - emptySchema.length;
    const prompts: Array<string> = [];
    const result = await run(
      `const schema = (n) => ({ type: "object", properties: { a: { type: "string", description: "d".repeat(n) } } });
       let caught;
       try { await agent("p", { schema: schema(args + 1) }); } catch (error) { caught = error.name + ": " + error.message; }
       return [caught, await agent("p", { schema: schema(args) })];`,
      {
        args: fits,
        runAgent: async (request) => {
          prompts.push(request.prompt);
          return prompts.length === 1 ? "nope" : '{"a":"x"}';
        },
      },
    );
    expect(result).toEqual({
      ok: true,
      value: [
        "RangeError: agent() prompt including the schema instruction is longer than 120000 characters.",
        { a: "x" },
      ],
    });
    expect(prompts.map((prompt) => prompt.length)).toEqual([120_000, 120_000]);
  });
});

describe("runWorkflowScript results", () => {
  it("reports syntax errors and thrown errors", async () => {
    expect(await run(`return (;`)).toEqual({
      ok: false,
      error: expect.stringContaining("SyntaxError"),
      aborted: false,
    });
    expect(await run(`throw new Error("boom");`)).toEqual({
      ok: false,
      error: "Error: boom",
      aborted: false,
    });
  });

  it("round-trips the return value and args as JSON", async () => {
    const args = { list: [1, "two", null, true], nested: { deep: { n: 5 } } };
    expect(await run(`return { args, missing: undefined };`, { args })).toEqual({
      ok: true,
      value: { args },
    });
    expect(await run(`return undefined;`)).toEqual({ ok: true, value: null });
    expect(await run(`return 10n;`)).toEqual({
      ok: false,
      error: expect.stringContaining("BigInt"),
      aborted: false,
    });
  });

  it("enforces script and args size limits before starting", async () => {
    let calls = 0;
    const runAgent = async () => {
      calls++;
      return "ok";
    };
    expect(
      await run(`return await agent("x");`, { runAgent, limits: { maxScriptChars: 10 } }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("longer than 10 characters"),
      aborted: false,
    });
    expect(
      await run(`return await agent("x");`, {
        runAgent,
        args: "x".repeat(20),
        limits: { maxArgsChars: 10 },
      }),
    ).toEqual({ ok: false, error: expect.stringContaining("args are longer"), aborted: false });
    expect(calls).toBe(0);
  });
});

describe("runWorkflowScript process", () => {
  it.each([
    ["one huge allocation", `await agent("first"); new Array(3e8).fill(1);`],
    ["one huge result", `await agent("first"); return "x".repeat(300000000);`],
    [
      "gradual growth",
      `await agent("first"); const keep = []; while (true) keep.push(new Array(1e5).fill(0));`,
    ],
  ])("contains an out-of-memory abort from %s", async (_name, script) => {
    expect(await run(script)).toEqual({
      ok: false,
      error: expect.stringContaining("it may have run out of memory"),
      aborted: false,
    });
    expect(await run(`return await agent("after");`)).toEqual({ ok: true, value: "echo:after" });
  });

  it("carries U+2028 and U+2029 through the stdio protocol", async () => {
    const text = "a\u2028b\u2029c";
    expect(await run(`return [args, "${text}", await agent(args)];`, { args: text })).toEqual({
      ok: true,
      value: [text, text, `echo:${text}`],
    });
  });

  it("fails a result larger than 4 MB", async () => {
    expect(await run(`return "x".repeat(4000000);`)).toEqual({
      ok: false,
      error: "Workflow result is larger than 4 MB.",
      aborted: false,
    });
  });

  it("caps agent() prompts in the script and clamps label, phase and model", async () => {
    const requests: Array<WorkflowAgentRequest> = [];
    const result = await run(
      `let caught;
       try { await agent("p".repeat(120001)); } catch (error) { caught = error.name + ": " + error.message; }
       await agent("p".repeat(120000), { label: "l".repeat(500), phase: "f".repeat(500), model: "m".repeat(500) });
       return caught;`,
      {
        runAgent: async (request) => {
          requests.push(request);
          return "ok";
        },
      },
    );
    expect(result).toEqual({
      ok: true,
      value: "RangeError: agent() prompt is longer than 120000 characters.",
    });
    expect(
      requests.map((request) => [
        request.prompt.length,
        request.label?.length,
        request.phase?.length,
        request.model?.length,
      ]),
    ).toEqual([[120000, 200, 200, 200]]);
  });

  it.each([
    ["prompt", `{ prompt: "p".repeat(120001) }`, "agent() prompt is longer"],
    [
      "prompt plus schema instruction",
      `{ prompt: "p", schema: { type: "object", properties: { a: { type: "string", description: "d".repeat(120000) } } } }`,
      "agent() prompt including the schema instruction is longer",
    ],
  ])("rejects an over-long %s on the host too", async (_name, fields, error) => {
    let calls = 0;
    // Skips the prelude's check and returns the reply agent() would throw.
    const child = `
      const lines = require("node:readline").createInterface({ input: process.stdin });
      process.stdout.write(JSON.stringify({ type: "agent", id: 0, ...${fields} }) + "\\n");
      lines.on("line", (line) => {
        const reply = JSON.parse(line);
        if (reply.id === 0) {
          process.stdout.write(JSON.stringify({ type: "result", value: JSON.stringify(reply.error) }) + "\\n");
        }
      });`;
    const result = await run("", {
      sandbox: fakeSandbox(child),
      runAgent: async () => {
        calls++;
        return "ok";
      },
    });
    expect(result).toEqual({ ok: true, value: `${error} than 120000 characters.` });
    expect(calls).toBe(0);
  });

  it("fails a sandbox line longer than 8 MiB", async () => {
    const child = `process.stdout.write("x".repeat(9 * 1024 * 1024) + "\\n"); process.stdin.resume();`;
    expect(await run("", { sandbox: fakeSandbox(child) })).toEqual({
      ok: false,
      error: "Workflow sandbox output was too large.",
      aborted: false,
    });
  });

  it("fails when the sandbox command does not exist", async () => {
    const missing = { command: "/nonexistent/t3-workflow-sandbox", args: [] };
    expect(await run(`return 1;`, { sandbox: missing })).toEqual({
      ok: false,
      error: expect.stringContaining("Workflow sandbox failed to start"),
      aborted: false,
    });
  });

  it("fails when the sandbox exits without a result", async () => {
    expect(await run(`return 1;`, { sandbox: fakeSandbox("process.exit(3)") })).toEqual({
      ok: false,
      error: "Workflow sandbox exited before the script finished (exit code 3).",
      aborted: false,
    });
  });

  it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "leaves no sandbox process behind",
    async () => {
      const before = liveSandboxPids();
      const results = await Promise.all([
        abortRun(`while (true) {}`, "spawn"),
        abortRun(`await agent("hang");`, "agent"),
        abortRun(`agent("hang"); while (true) {}`, "agent"),
      ]);
      expect(results).toEqual(
        Array.from({ length: 3 }, () => ({ ok: false, error: "aborted", aborted: true })),
      );
      expect(liveSandboxPids().filter((pid) => !before.includes(pid))).toEqual([]);
    },
  );

  it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "ends a busy sandbox once its parent is killed",
    { timeout: 10_000 },
    async () => {
      // A throwaway parent starts the sandbox on the parent's own stdout, so that pipe
      // closes only once the sandbox process is gone too.
      const parentSource = `
        const { command, args } = JSON.parse(process.argv[1]);
        const child = require("node:child_process").spawn(command, args, { stdio: ["pipe", "inherit", "ignore"] });
        process.stdout.write("pid " + child.pid + "\\n");
        child.stdin.write(JSON.stringify({ script: 'log("spinning"); for (;;) {}', args: "null" }) + "\\n");`;
      const parent = NodeChildProcess.spawn(
        process.execPath,
        ["-e", parentSource, JSON.stringify(sandbox)],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let output = "";
      let closed = false;
      const spinning = Promise.withResolvers<void>();
      const gone = Promise.withResolvers<void>();
      parent.stdout.setEncoding("utf8");
      parent.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("spinning")) spinning.resolve();
      });
      parent.stdout.on("close", () => {
        closed = true;
        gone.resolve();
      });
      // An open pipe means the sandbox we started still holds it, so its pid is still ours.
      onTestFinished(() => {
        const pid = Number(/^pid (\d+)/.exec(output)?.[1]);
        if (!closed && pid) process.kill(pid, "SIGKILL");
      });
      await spinning.promise;
      parent.kill("SIGKILL");
      await gone.promise;
    },
  );
});
