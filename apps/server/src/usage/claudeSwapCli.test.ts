import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { makeClaudeSwapCli } from "./claudeSwapCli.ts";

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

function fakeRunner(
  respond: (
    input: ProcessRunner.ProcessRunInput,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  fileSystem: Partial<FileSystem.FileSystem> = {},
) {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) => {
        calls.push(input);
        return respond(input);
      },
    }),
    FileSystem.layerNoop(fileSystem),
    Path.layer,
  );
  return { calls, layer };
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

const listPayload = {
  schemaVersion: 1,
  activeAccountNumber: 1,
  accounts: [
    {
      number: 1,
      email: "active@example.com",
      organizationName: "",
      organizationUuid: "org-1",
      isOrganization: true,
      active: true,
      usageStatus: "ok",
      usage: {
        fiveHour: { pct: 42.5, resetsAt: "2026-10-08T15:00:00+00:00", countdown: "2h" },
        sevenDay: {
          pct: 120,
          resetsAt: "2026-10-12T00:00:00+00:00",
          expectedPct: 61.3,
          aheadOfPace: true,
        },
        scoped: [{ name: "Opus", pct: 10, resetsAt: "2026-10-12T00:00:00+00:00" }],
        spend: { used: 1, limit: 10, pct: 10, currency: "USD" },
      },
      usageFetchedAt: "2026-10-08T12:00:00Z",
      usageAgeSeconds: 12.5,
      loginExpiresAt: "2026-12-01T00:00:00Z",
    },
    {
      number: 2,
      email: "stale@example.com",
      organizationName: "",
      organizationUuid: "org-2",
      isOrganization: true,
      active: false,
      usageStatus: "unavailable",
      usage: null,
      lastGoodUsage: { fiveHour: { pct: 5 }, sevenDay: { pct: 30 } },
      lastGoodFetchedAt: "2026-10-08T09:00:00Z",
      lastGoodAgeSeconds: 10800,
      alias: "work",
      disabled: true,
    },
    {
      number: 3,
      email: "api-key-3@token.local",
      active: false,
      usageStatus: "api_key",
      usage: null,
    },
    {
      number: 4,
      email: "dead@example.com",
      active: false,
      usageStatus: "relogin_required",
      usage: null,
      lastGoodUsage: { fiveHour: { pct: 5 } },
      lastGoodFetchedAt: "2026-10-01T09:00:00Z",
    },
    { number: "not-a-slot", email: 7 },
  ],
};

describe("claudeSwapCli.readAccounts", () => {
  it.effect("maps cswap rows onto the native Claude window ids", () => {
    const runner = fakeRunner(() => Effect.succeed(output(json(listPayload))));
    return Effect.gen(function* () {
      const cli = yield* makeClaudeSwapCli;
      const accounts = yield* cli.readAccounts("~/.local/bin/cswap");

      expect(runner.calls).toHaveLength(1);
      const call = runner.calls[0]!;
      expect(call.command).toBe(`${NodeOS.homedir()}/.local/bin/cswap`);
      expect(call.args).toEqual(["--list", "--json"]);
      expect(call.stdin).toBe("");
      expect(call.env).toHaveProperty("CLAUDE_CONFIG_DIR", undefined);
      expect(call.env?.NO_COLOR).toBe("1");

      expect(accounts.map((account) => account.id)).toEqual(["1", "2", "3", "4"]);
      const [active, stale, apiKey, dead] = accounts;

      expect(active).toMatchObject({
        email: "active@example.com",
        active: true,
        status: "ok",
        loginExpiresAt: "2026-12-01T00:00:00.000Z",
        weeklyPace: { expectedPercent: 61.3, aheadOfPace: true },
      });
      expect(active!.stale).toBeUndefined();
      expect(active!.usageLimits.checkedAt).toBe("2026-10-08T12:00:00.000Z");
      expect(active!.usageLimits.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["five_hour", 42.5],
        ["seven_day", 100],
        ["seven_day_opus", 10],
      ]);

      expect(stale).toMatchObject({
        active: false,
        alias: "work",
        disabled: true,
        status: "unavailable",
        stale: true,
      });
      expect(stale!.usageLimits.checkedAt).toBe("2026-10-08T09:00:00.000Z");
      expect(stale!.usageLimits.windows.map((window) => window.id)).toEqual([
        "five_hour",
        "seven_day",
      ]);

      expect(apiKey!.usageLimits.unavailable?.reason).toBe("unsupported");

      // A dead login shows why, not last week's bars.
      expect(dead!.usageLimits.windows).toEqual([]);
      expect(dead!.usageLimits.unavailable).toMatchObject({ reason: "probeFailed" });
      expect(dead!.stale).toBeUndefined();
    }).pipe(Effect.provide(runner.layer));
  });

  it.effect("labels each plan from the profile cswap keeps, parsing it once per change", () => {
    const profiles: Record<string, unknown> = {
      "/configs/.claude-config-1-active@example.com.json": {
        oauthAccount: {
          organizationType: "claude_max",
          organizationRateLimitTier: "default_claude_max_20x",
          organizationName: "active@example.com's Organization",
        },
      },
      "/configs/.claude-config-2-stale@example.com.json": {
        oauthAccount: {
          organizationType: "claude_team",
          organizationRateLimitTier: "default_raven",
          seatTier: "team_standard",
          organizationName: "Acme",
        },
      },
    };
    const profileFor = (file: string) =>
      Object.entries(profiles).find(([suffix]) => file.endsWith(suffix))?.[1];
    const noop = FileSystem.makeNoop({});
    let reads = 0;
    const runner = fakeRunner(() => Effect.succeed(output(json(listPayload))), {
      stat: (file) =>
        profileFor(file)
          ? Effect.succeed({
              mtime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(1))),
            } as FileSystem.File.Info)
          : noop.stat(file),
      readFileString: (file) => {
        reads += 1;
        return Effect.succeed(JSON.stringify(profileFor(file)));
      },
    });
    return Effect.gen(function* () {
      const cli = yield* makeClaudeSwapCli;
      const accounts = yield* cli.readAccounts("");
      expect(accounts.map((account) => account.plan)).toEqual([
        "Max 20x",
        "Team Standard · Acme",
        undefined,
        undefined,
      ]);
      yield* cli.readAccounts("");
      expect(reads).toBe(2);
    }).pipe(Effect.provide(runner.layer));
  });

  it.effect("reads past a warning line cswap 0.26 prints before the JSON", () => {
    const runner = fakeRunner(() =>
      Effect.succeed(output(`Warning: could not persist refreshed token\n${json(listPayload)}`)),
    );
    return Effect.gen(function* () {
      const cli = yield* makeClaudeSwapCli;
      const accounts = yield* cli.readAccounts("");
      expect(runner.calls[0]!.command).toBe("cswap");
      expect(accounts).toHaveLength(4);
    }).pipe(Effect.provide(runner.layer));
  });

  it.effect("reports an error envelope with fixed text, never cswap's message", () => {
    const runner = fakeRunner(() =>
      Effect.succeed(
        output(
          json({
            schemaVersion: 1,
            error: { type: "LockError", message: "lock held for secret@example.com" },
          }),
          1,
        ),
      ),
    );
    return Effect.gen(function* () {
      const cli = yield* makeClaudeSwapCli;
      const error = yield* Effect.flip(cli.readAccounts(""));
      expect(error.detail).toBe("claude-swap is busy with another command. Try again in a moment.");
      expect(error.detail).not.toContain("example.com");
    }).pipe(Effect.provide(runner.layer));
  });

  it.effect("refuses another schema version", () => {
    const runner = fakeRunner(() =>
      Effect.succeed(output(json({ schemaVersion: 2, accounts: [] }))),
    );
    return Effect.gen(function* () {
      const cli = yield* makeClaudeSwapCli;
      const error = yield* Effect.flip(cli.readAccounts(""));
      expect(error.detail).toContain("not supported");
    }).pipe(Effect.provide(runner.layer));
  });

  it.effect("reports a failed run without JSON by exit code only", () => {
    const runner = fakeRunner(() => Effect.succeed(output("Traceback: boom", 1)));
    return Effect.gen(function* () {
      const cli = yield* makeClaudeSwapCli;
      const error = yield* Effect.flip(cli.readAccounts(""));
      expect(error.detail).toBe("claude-swap failed (exit code 1).");
    }).pipe(Effect.provide(runner.layer));
  });

  it.effect("says cswap is missing when the binary cannot be found", () => {
    const runner = fakeRunner((input) =>
      Effect.fail(
        new ProcessRunner.ProcessSpawnError({
          command: input.command,
          argumentCount: input.args.length,
          cause: PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
          }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const cli = yield* makeClaudeSwapCli;
      const error = yield* Effect.flip(cli.readAccounts(""));
      expect(error.detail).toContain("was not found");
    }).pipe(Effect.provide(runner.layer));
  });

  it.effect("says cswap timed out", () => {
    const runner = fakeRunner((input) =>
      Effect.fail(
        new ProcessRunner.ProcessTimeoutError({
          command: input.command,
          argumentCount: input.args.length,
          timeoutMs: 60_000,
        }),
      ),
    );
    return Effect.gen(function* () {
      const cli = yield* makeClaudeSwapCli;
      const error = yield* Effect.flip(cli.readAccounts(""));
      expect(error.detail).toBe("claude-swap did not answer in time.");
    }).pipe(Effect.provide(runner.layer));
  });
});

describe("claudeSwapCli.switchTo", () => {
  it.effect("switches by slot number and reports both accounts", () => {
    const runner = fakeRunner(() =>
      Effect.succeed(
        output(
          json({
            schemaVersion: 1,
            switched: true,
            from: { number: 1, email: "active@example.com" },
            to: { number: 2, email: "stale@example.com" },
            strategy: "direct",
            reason: "switched",
            message: "Switched to Account-2 (stale@example.com)",
            warnings: [],
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const cli = yield* makeClaudeSwapCli;
      const result = yield* cli.switchTo("", { accountId: "2" });
      expect(runner.calls[0]!.args).toEqual(["--switch-to", "2", "--json"]);
      expect(result).toEqual({
        switched: true,
        reason: "switched",
        fromEmail: "active@example.com",
        toEmail: "stale@example.com",
      });
    }).pipe(Effect.provide(runner.layer));
  });

  it.effect("lets cswap pick the best account", () => {
    const runner = fakeRunner(() =>
      Effect.succeed(
        output(
          json({
            schemaVersion: 1,
            switched: false,
            from: null,
            to: null,
            strategy: "best",
            reason: "already-best",
            message: "Already on the best account",
            warnings: [],
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const cli = yield* makeClaudeSwapCli;
      const result = yield* cli.switchTo("", { strategy: "best" });
      expect(runner.calls[0]!.args).toEqual(["--switch", "--strategy", "best", "--json"]);
      expect(result).toEqual({ switched: false, reason: "already-best" });
    }).pipe(Effect.provide(runner.layer));
  });
});

describe("claudeSwapCli.autoTick", () => {
  const event = (value: Record<string, unknown>) =>
    JSON.stringify({ schemaVersion: 1, ts: "2026-10-08T12:00:00Z", ...value });
  const poll = event({
    event: "poll",
    active: { number: 1, email: "active@example.com" },
    headroomPct: { "1": 8.5, "2": 70 },
    threshold: 90,
    windowsPct: { "1": { "5h": 91.5, "7d": 40, Opus: 100 }, "2": { "5h": 30, "7d": 10 } },
  });
  const switched = event({
    event: "switch",
    trigger: "proactive",
    from: { number: 1, email: "active@example.com" },
    to: { number: 2, email: "spare@example.com" },
    warnings: [],
    dryRun: false,
  });
  const tick = (stdout: string, code: number) => {
    const runner = fakeRunner(() => Effect.succeed(output(stdout, code)));
    return makeClaudeSwapCli.pipe(
      Effect.flatMap((cli) => cli.autoTick("~/.local/bin/cswap", 92)),
      Effect.provide(runner.layer),
      Effect.map((result) => ({ result, calls: runner.calls })),
    );
  };

  it.effect("runs one tick of claude-swap's engine and reports the switch by slot", () =>
    Effect.gen(function* () {
      const stdout = [
        "Warning: could not persist refreshed token for active@example.com",
        poll,
        event({ event: "account-unquarantined", number: "3", email: "x@example.com" }),
        event({ event: "a-future-event", detail: { nested: true } }),
        "{not json",
        switched,
        "",
      ].join("\n");
      const { result, calls } = yield* tick(stdout, 0);
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.command).toBe(`${NodeOS.homedir()}/.local/bin/cswap`);
      expect(call.args).toEqual([
        "auto",
        "--once",
        "--json",
        "--threshold",
        "92",
        "--strategy",
        "best",
      ]);
      expect(call.stdin).toBe("");
      expect(call.env).toHaveProperty("CLAUDE_CONFIG_DIR", undefined);
      expect(call.env?.NO_COLOR).toBe("1");
      // The 5-hour window bound; the per-model weekly is not counted.
      expect(result).toEqual({
        outcome: "switched",
        fromAccountId: "1",
        toAccountId: "2",
        usedPercent: 91.5,
        window: "session",
      });
    }),
  );

  it.effect("names the weekly window when it is the fuller one", () =>
    Effect.gen(function* () {
      const weekly = event({
        event: "poll",
        windowsPct: { "1": { "5h": 20, "7d": 96 } },
      });
      const { result } = yield* tick(`${weekly}\n${switched}\n`, 0);
      expect(result).toMatchObject({ usedPercent: 96, window: "weekly" });
    }),
  );

  it.effect("reads the outcome from the exit code alone when no event parses", () =>
    Effect.gen(function* () {
      const { result } = yield* tick("garbage\n", 0);
      expect(result).toEqual({ outcome: "switched" });
    }),
  );

  it.effect.each([
    ["below-threshold", 2, event({ event: "no-switch", reason: "below-threshold" }), "noAction"],
    ["cooldown", 2, event({ event: "no-switch", reason: "cooldown" }), "noAction"],
    ["all-exhausted", 3, event({ event: "all-exhausted", earliestResetAt: null }), "blocked"],
    ["no-viable-target", 3, event({ event: "no-switch", reason: "no-viable-target" }), "blocked"],
  ] as const)("reads %s (exit %s) as %s", ([, code, line, outcome]) =>
    Effect.gen(function* () {
      const { result } = yield* tick(`${poll}\n${line}\n`, code);
      expect(result).toEqual({ outcome });
    }),
  );

  it.effect.each([
    [
      "an error event",
      1,
      event({ event: "error", message: "lock held by active@example.com", transient: true }),
      "claude-swap failed (exit code 1).",
    ],
    [
      "an error envelope",
      1,
      JSON.stringify({
        schemaVersion: 1,
        error: { type: "LockError", message: "lock held by active@example.com" },
      }),
      "claude-swap is busy with another command. Try again in a moment.",
    ],
    [
      "a claude-swap without auto",
      2,
      "usage: cswap [-h] ... error: argument: invalid choice: 'auto'",
      "This claude-swap version cannot switch automatically. Update claude-swap.",
    ],
  ] as const)("fails with fixed text on %s", ([, code, stdout, detail]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(tick(stdout, code));
      expect(error.detail).toBe(detail);
    }),
  );
});
