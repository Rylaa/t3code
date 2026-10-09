// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceError,
  UsageLimitSourceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { FetchHttpClient } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const sourceId = UsageLimitSourceId.make("claude-swap");
const defaultInstanceId = ProviderInstanceId.make("claude");
const isolatedInstanceId = ProviderInstanceId.make("claude-work");

const row = (number: number, email: string, overrides: Record<string, unknown> = {}) => ({
  number,
  email,
  active: false,
  usageStatus: "ok",
  usage: { fiveHour: { pct: 10 }, sevenDay: { pct: 20 } },
  usageFetchedAt: "2026-10-08T12:00:00Z",
  ...overrides,
});

const output = (value: unknown): ProcessRunner.ProcessRunOutput => ({
  stdout: JSON.stringify(value),
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const claudeInstance = (instanceId: ProviderInstanceId, home: string) =>
  ({
    instanceId,
    driverKind: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("claudeAgent"),
      continuationKey: `claude:home:${home}`,
    },
    invalidateCaches: Effect.void,
  }) as ProviderInstance;

function harness(options: {
  readonly accounts: ReadonlyArray<ReturnType<typeof row>>;
  readonly settings?: Partial<Pick<ServerSettings, "claudeSwapUsageEnabled">>;
  /** Runs before the fake answers, e.g. to hold cswap mid-command. */
  readonly beforeAnswer?: (args: ReadonlyArray<string>) => Effect.Effect<void>;
}) {
  const calls: Array<ReadonlyArray<string>> = [];
  const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) => {
      calls.push(input.args);
      const answer = options.beforeAnswer?.(input.args) ?? Effect.void;
      if (input.args[0] === "--list") {
        return answer.pipe(Effect.as(output({ schemaVersion: 1, accounts: options.accounts })));
      }
      return answer.pipe(
        Effect.as(
          output({
            schemaVersion: 1,
            switched: true,
            from: { number: 1, email: "one@example.com" },
            to: { number: Number(input.args[1]), email: "two@example.com" },
            reason: "switched",
          }),
        ),
      );
    },
  });
  return Effect.gen(function* () {
    const refreshed = yield* Deferred.make<ProviderInstanceId>();
    const layer = UsageLimitSources.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          runner,
          Settings.layerTest({ claudeSwapUsageEnabled: true, ...options.settings }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(false),
          }),
          // The cliproxy reader is built but never called here.
          FetchHttpClient.layer,
          NodeCrypto.layer,
          NodePathLayer.layer,
          Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
            getInstance: () => Effect.succeed(undefined),
            // The isolated instance comes first so refreshing it would win the deferred.
            listInstances: Effect.succeed([
              claudeInstance(isolatedInstanceId, "/elsewhere/.claude-work"),
              claudeInstance(
                defaultInstanceId,
                NodePath.resolve(NodePath.join(NodeOS.homedir(), ".claude")),
              ),
            ]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.never,
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            refreshInstance: (instanceId) =>
              Deferred.succeed(refreshed, instanceId).pipe(Effect.as([])),
          }),
        ),
      ),
    );
    // Built in the test's scope so the service's background fibers outlive this call.
    const service = Context.get(yield* Layer.build(layer), UsageLimitSources.UsageLimitSources);
    return { service, calls, refreshed };
  });
}

const switchCalls = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter((args) => args[0] !== "--list");

/**
 * Waits for the service's startup claude-swap read to publish, then forgets
 * its calls so a test sees only the commands its own request ran.
 */
const afterStartupRead = (
  service: UsageLimitSources.UsageLimitSources["Service"],
  calls: Array<ReadonlyArray<string>>,
) =>
  service.streamChanges.pipe(
    Stream.filter((sources) => sources.some((source) => source.id === sourceId)),
    Stream.runHead,
    Effect.andThen(Effect.sync(() => calls.splice(0))),
  );

/** A switch guard that records itself in the same log as the cswap commands. */
const recordGuard = (calls: Array<ReadonlyArray<string>>) =>
  Effect.sync(() => {
    calls.push(["guard"]);
  });

describe("UsageLimitSources.switchAccount", () => {
  it.effect("switches a verified slot, re-reads it and refreshes default Claude instances", () =>
    Effect.gen(function* () {
      const { service, calls, refreshed } = yield* harness({
        accounts: [row(1, "one@example.com", { active: true }), row(2, "Two@Example.com")],
      });
      yield* afterStartupRead(service, calls);
      const result = yield* service.switchAccount(
        { sourceId, accountId: "2", email: "two@example.com" },
        { beforeSwitch: recordGuard(calls) },
      );
      expect(result).toMatchObject({ switched: true, toEmail: "two@example.com" });
      expect(switchCalls(calls)).toEqual([["guard"], ["--switch-to", "2", "--json"]]);
      // Verify read, then the caller's guard, then the switch, then the re-read.
      expect(calls.map((args) => args[0])).toEqual(["--list", "guard", "--switch-to", "--list"]);
      const current = yield* service.current;
      expect(current.find((source) => source.id === sourceId)).toMatchObject({
        kind: "claudeSwap",
        label: "claude-swap",
      });
      expect(yield* Deferred.await(refreshed)).toBe(defaultInstanceId);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses when the slot now holds another account", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness({
        accounts: [row(1, "one@example.com", { active: true }), row(2, "other@example.com")],
      });
      const error = yield* Effect.flip(
        service.switchAccount({ sourceId, accountId: "2", email: "two@example.com" }),
      );
      expect(error.detail).toContain("changed");
      expect(switchCalls(calls)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a login that cannot serve turns", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness({
        accounts: [
          row(1, "one@example.com", { active: true }),
          row(2, "two@example.com", { usageStatus: "relogin_required", usage: null }),
        ],
      });
      const error = yield* Effect.flip(
        service.switchAccount({ sourceId, accountId: "2", email: "two@example.com" }),
      );
      expect(error.detail).toContain("Sign in");
      expect(switchCalls(calls)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses while claude-swap is turned off", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness({
        accounts: [row(1, "one@example.com")],
        settings: { claudeSwapUsageEnabled: false },
      });
      const error = yield* Effect.flip(service.switchAccount({ sourceId, strategy: "best" }));
      expect(error.detail).toContain("cannot switch");
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a switch running after the caller is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const killed = yield* Deferred.make<void>();
      const { service, calls, refreshed } = yield* harness({
        accounts: [row(1, "one@example.com", { active: true }), row(2, "two@example.com")],
        beforeAnswer: (args) =>
          args[0] === "--switch-to"
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.onInterrupt(() => Deferred.succeed(killed, undefined)),
              )
            : Effect.void,
      });
      const caller = yield* service
        .switchAccount({ sourceId, accountId: "2", email: "two@example.com" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      // A client disconnect or MCP cancel interrupts the request fiber.
      yield* Fiber.interrupt(caller);
      expect(yield* Deferred.isDone(killed)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      // The post-switch read and the default-instance refresh still run.
      expect(yield* Deferred.await(refreshed)).toBe(defaultInstanceId);
      const switchIndex = calls.findIndex((args) => args[0] === "--switch-to");
      expect(calls.slice(switchIndex + 1).some((args) => args[0] === "--list")).toBe(true);
      expect(yield* Deferred.isDone(killed)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("runs the caller's guard after the verify read and stops on its failure", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness({
        accounts: [row(1, "one@example.com", { active: true }), row(2, "two@example.com")],
      });
      yield* afterStartupRead(service, calls);
      const error = yield* Effect.flip(
        service.switchAccount(
          { sourceId, accountId: "2", email: "two@example.com" },
          {
            beforeSwitch: recordGuard(calls).pipe(
              Effect.andThen(Effect.fail(new UsageLimitSourceError({ detail: "denied" }))),
            ),
          },
        ),
      );
      expect(error.detail).toBe("denied");
      expect(calls.map((args) => args[0])).toEqual(["--list", "guard"]);
    }).pipe(Effect.scoped),
  );

  it.effect("passes the best strategy through without a verify read", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness({ accounts: [row(1, "one@example.com")] });
      yield* service.switchAccount({ sourceId, strategy: "best" });
      expect(switchCalls(calls)).toEqual([["--switch", "--strategy", "best", "--json"]]);
    }).pipe(Effect.scoped),
  );
});

describe("UsageLimitSources with a slow claude-swap read", () => {
  const slowList = Effect.gen(function* () {
    const listing = yield* Deferred.make<void>();
    const { service } = yield* harness({
      accounts: [row(1, "one@example.com", { active: true })],
      // cswap never answers --list, as with a locked Keychain.
      beforeAnswer: (args) =>
        args[0] === "--list"
          ? Deferred.succeed(listing, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
    });
    yield* Deferred.await(listing);
    return service;
  });

  it.effect("refreshes without waiting for it", () =>
    Effect.gen(function* () {
      const service = yield* slowList;
      yield* service.refresh;
      expect(yield* service.current).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not hold up hub reset-credit redemptions", () =>
    Effect.gen(function* () {
      const service = yield* slowList;
      const error = yield* Effect.flip(
        service.consumeResetCredit({
          sourceId: UsageLimitSourceId.make("hub"),
          accountId: "account",
          creditId: "credit",
        }),
      );
      expect(error.detail).toContain("missing or disabled");
    }).pipe(Effect.scoped),
  );
});
