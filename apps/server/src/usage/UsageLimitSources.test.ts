// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerConfigStreamEvent,
  type ServerProvider,
  UsageLimitSourceError,
  UsageLimitSourceId,
  type ServerSettings,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { FetchHttpClient, HttpClient } from "effect/http";

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

const output = (value: unknown, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
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
  readonly settings?: Partial<
    Pick<
      ServerSettings,
      | "claudeSwapUsageEnabled"
      | "claudeSwapAutoSwitchEnabled"
      | "claudeSwapAutoSwitchAtPercent"
      | "claudeSwapAntigravityFallbackEnabled"
      | "providerHealthRefreshInterval"
    >
  >;
  /** Runs before the fake answers, e.g. to hold cswap mid-command. */
  readonly beforeAnswer?: (args: ReadonlyArray<string>) => Effect.Effect<void>;
  /** What a switch printed and exited with, by default a switch to the slot asked for. */
  readonly switchAnswer?: { readonly stdout: string; readonly code: number };
}) {
  const calls: Array<ReadonlyArray<string>> = [];
  // The default Claude instances' snapshots, and a hook run whenever the service reads them.
  let providers: ReadonlyArray<ServerProvider> = [];
  let onReadProviders: Effect.Effect<void> = Effect.void;
  const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) => {
      calls.push(input.args);
      const answer = options.beforeAnswer?.(input.args) ?? Effect.void;
      if (input.args[0] === "--list") {
        return answer.pipe(Effect.as(output({ schemaVersion: 1, accounts: options.accounts })));
      }
      if (options.switchAnswer) {
        const { stdout, code } = options.switchAnswer;
        return answer.pipe(Effect.as(output(stdout, code)));
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
    const providerChanges = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
    const layer = UsageLimitSources.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          runner,
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(false),
          }),
          // The cliproxy reader is built but never called here.
          FetchHttpClient.layer,
          NodeCrypto.layer,
          NodePathLayer.layer,
          FileSystem.layerNoop({}),
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
            getProviders: Effect.suspend(() => onReadProviders.pipe(Effect.as(providers))),
            streamChanges: Stream.fromPubSub(providerChanges),
          }),
        ),
      ),
      Layer.provideMerge(Settings.layerTest({ claudeSwapUsageEnabled: true, ...options.settings })),
    );
    // Built in the test's scope so the service's background fibers outlive this call.
    const context = yield* Layer.build(layer);
    const service = Context.get(context, UsageLimitSources.UsageLimitSources);
    const settings = Context.get(context, Settings.ServerSettingsService);
    /**
     * Publishes new default Claude snapshots and resolves once the service's
     * automatic-switch check has read them, so a drain afterwards covers it.
     */
    const changeProviders = (next: ReadonlyArray<ServerProvider>) =>
      Effect.gen(function* () {
        const read = yield* Deferred.make<void>();
        providers = next;
        onReadProviders = Deferred.succeed(read, undefined).pipe(Effect.asVoid);
        yield* PubSub.publish(providerChanges, next);
        yield* Deferred.await(read);
      });
    return { service, settings, calls, refreshed, changeProviders };
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

describe("UsageLimitSources automatic switching", () => {
  const on = { claudeSwapAutoSwitchEnabled: true } as const;
  const activeAt = (pct: number) =>
    row(1, "one@example.com", {
      active: true,
      usage: { fiveHour: { pct }, sevenDay: { pct: 20 } },
    });
  const spare = row(2, "two@example.com");
  /** The default Claude instance's snapshot after a turn's rate-limit update. */
  const defaultClaude = (usedPercent: number): ServerProvider => ({
    instanceId: defaultInstanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "one@example.com" },
    checkedAt: "2026-10-08T12:05:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-10-08T12:05:00.000Z",
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent }],
    },
  });
  const statusOf = (
    service: UsageLimitSources.UsageLimitSources["Service"],
    outcome: NonNullable<UsageLimitSourceSnapshot["autoSwitch"]>["outcome"],
  ) =>
    service.streamChanges.pipe(
      Stream.map((sources) => sources.find((source) => source.id === sourceId)?.autoSwitch),
      Stream.filter((status) => status?.outcome === outcome),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
    );

  it.effect("switches once when claude-swap's reading reaches the threshold", () =>
    Effect.gen(function* () {
      const { service, calls, refreshed } = yield* harness({
        accounts: [activeAt(91), spare],
        settings: on,
      });
      expect(yield* statusOf(service, "switched")).toMatchObject({
        fromAccountId: "1",
        toAccountId: "2",
        usedPercent: 91,
        window: "session",
      });
      // The isolated instance is listed first, so refreshing it would win the deferred.
      expect(yield* Deferred.await(refreshed)).toBe(defaultInstanceId);
      yield* service.drainAutoSwitch;
      // claude-swap still lists the account at 91%, but a switch settles before the next one.
      expect(switchCalls(calls)).toEqual([["--switch-to", "2", "--json"]]);
      expect(calls.slice(calls.findIndex((args) => args[0] === "--switch-to") + 1)).toContainEqual([
        "--list",
        "--json",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("switches when a turn's rate-limit update reaches the threshold", () =>
    Effect.gen(function* () {
      const { service, calls, changeProviders } = yield* harness({
        accounts: [activeAt(50), spare],
        settings: on,
      });
      yield* afterStartupRead(service, calls);
      yield* service.drainAutoSwitch;
      expect(switchCalls(calls)).toEqual([]);
      yield* changeProviders([defaultClaude(91)]);
      expect(yield* statusOf(service, "switched")).toMatchObject({ toAccountId: "2" });
      yield* service.drainAutoSwitch;
      expect(switchCalls(calls)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("waits behind an in-flight claude-swap read", () =>
    Effect.gen(function* () {
      const listing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let hold = false;
      const { service, calls, changeProviders } = yield* harness({
        accounts: [activeAt(50), spare],
        settings: on,
        beforeAnswer: (args): Effect.Effect<void> =>
          args[0] === "--list" && hold
            ? Effect.sync(() => {
                hold = false;
              }).pipe(
                Effect.andThen(Deferred.succeed(listing, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.sync(() => calls.push(["list answered"]))),
              )
            : Effect.void,
      });
      yield* afterStartupRead(service, calls);
      yield* service.drainAutoSwitch;
      hold = true;
      yield* service.refresh;
      yield* Deferred.await(listing);
      yield* changeProviders([defaultClaude(91)]);
      // The check resumed this fiber mid-run. Two turns let it reach the lock,
      // and a tick that skipped the lock run on its own fiber, before the release.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* statusOf(service, "switched");
      expect(calls.map((args) => args[0])).toEqual([
        "--list",
        "list answered",
        "--list",
        "--switch-to",
        "--list",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("drops a switch still waiting for claude-swap once it is turned off", () =>
    Effect.gen(function* () {
      const listing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let hold = false;
      const { service, settings, calls, changeProviders } = yield* harness({
        accounts: [activeAt(50), spare],
        settings: on,
        beforeAnswer: (args) =>
          args[0] === "--list" && hold
            ? Effect.sync(() => {
                hold = false;
              }).pipe(
                Effect.andThen(Deferred.succeed(listing, undefined)),
                Effect.andThen(Deferred.await(release)),
              )
            : Effect.void,
      });
      yield* afterStartupRead(service, calls);
      yield* service.drainAutoSwitch;
      hold = true;
      yield* service.refresh;
      yield* Deferred.await(listing);
      // The check has decided to switch and now waits for the read to finish.
      yield* changeProviders([defaultClaude(91)]);
      yield* settings.updateSettings({ claudeSwapAutoSwitchEnabled: false });
      yield* Deferred.succeed(release, undefined);
      yield* service.drainAutoSwitch;
      expect(switchCalls(calls)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("backs off after a failed switch", () =>
    Effect.gen(function* () {
      const { service, calls, changeProviders } = yield* harness({
        accounts: [activeAt(91), spare],
        settings: on,
        switchAnswer: { stdout: "Traceback: boom", code: 1 },
      });
      expect(yield* statusOf(service, "failed")).toMatchObject({
        detail: "claude-swap failed (exit code 1).",
      });
      // Inside the five-minute back-off.
      yield* TestClock.adjust("2 minutes");
      yield* changeProviders([defaultClaude(95)]);
      yield* service.drainAutoSwitch;
      expect(switchCalls(calls)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("reports when no account has room, without switching", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness({
        accounts: [
          activeAt(99),
          row(2, "two@example.com", { usage: { fiveHour: { pct: 95 }, sevenDay: { pct: 20 } } }),
        ],
        settings: on,
      });
      expect(yield* statusOf(service, "blocked")).toMatchObject({ outcome: "blocked" });
      expect(switchCalls(calls)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("never runs while switching automatically is off", () =>
    Effect.gen(function* () {
      const { service, calls, changeProviders } = yield* harness({
        accounts: [activeAt(99), spare],
      });
      yield* changeProviders([defaultClaude(99)]);
      yield* service.drainAutoSwitch;
      expect(switchCalls(calls)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("never runs while claude-swap is off", () =>
    Effect.gen(function* () {
      const { service, calls, changeProviders } = yield* harness({
        accounts: [activeAt(99), spare],
        settings: { ...on, claudeSwapUsageEnabled: false },
      });
      yield* changeProviders([defaultClaude(99)]);
      yield* service.drainAutoSwitch;
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not read claude-swap with no client while switching automatically is off", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness({ accounts: [activeAt(50), spare] });
      yield* afterStartupRead(service, calls);
      // The background policy fake refuses provider-status work, as with no client connected.
      yield* TestClock.adjust("30 minutes");
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads claude-swap with no client at most every 3 minutes", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness({
        accounts: [activeAt(50), spare],
        settings: { ...on, providerHealthRefreshInterval: Duration.minutes(1) },
      });
      yield* afterStartupRead(service, calls);
      yield* TestClock.adjust("2 minutes");
      expect(calls).toEqual([]);
      yield* TestClock.adjust("1 minute");
      yield* service.drainAutoSwitch;
      expect(calls.filter((args) => args[0] === "--list")).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a reading from a Claude instance with its own home", () =>
    Effect.gen(function* () {
      const { service, calls, changeProviders } = yield* harness({
        accounts: [activeAt(50), spare],
        settings: on,
      });
      yield* afterStartupRead(service, calls);
      yield* changeProviders([{ ...defaultClaude(99), instanceId: isolatedInstanceId }]);
      yield* service.drainAutoSwitch;
      expect(switchCalls(calls)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps reading claude-swap with no client in the foreground", () =>
    Effect.gen(function* () {
      const listed = yield* Deferred.make<void>();
      let armed = false;
      const { service, calls } = yield* harness({
        accounts: [activeAt(50), spare],
        settings: on,
        beforeAnswer: (args) =>
          args[0] === "--list" && armed
            ? Deferred.succeed(listed, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      yield* afterStartupRead(service, calls);
      armed = true;
      // The background policy fake refuses provider-status work, as with no client connected.
      yield* TestClock.adjust("5 minutes");
      yield* Deferred.await(listed);
    }).pipe(Effect.scoped),
  );
});

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      Settings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
      NodePathLayer.layer,
      FileSystem.layerNoop({}),
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("Unexpected claude-swap run"),
      }),
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: () => Effect.succeed(undefined),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
        streamChanges: Stream.empty,
      }),
    ]),
    Effect.scoped,
  ),
);

describe("UsageLimitSources Antigravity fallback", () => {
  const settings = {
    claudeSwapAutoSwitchEnabled: true,
    claudeSwapAntigravityFallbackEnabled: true,
  } as const;
  const fullAt = (number: number, email: string, active = false) =>
    row(number, email, { active, usage: { fiveHour: { pct: 97 }, sevenDay: { pct: 20 } } });
  const antigravity: ServerProvider = {
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-08T12:05:00.000Z",
    models: [{ slug: "claude-opus", name: "Claude Opus 4.6", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-10-08T12:05:00.000Z",
      windows: [{ id: "3p-5h", kind: "session", label: "Claude & GPT", usedPercent: 30 }],
    },
  };

  it.effect(
    "targets Antigravity only for default Claude instances once every account is full",
    () =>
      Effect.gen(function* () {
        const { service, calls, changeProviders } = yield* harness({
          accounts: [fullAt(1, "one@example.com", true), fullAt(2, "two@example.com")],
          settings,
        });
        yield* afterStartupRead(service, calls);
        yield* changeProviders([antigravity]);
        expect(yield* service.antigravityFallbackFor(defaultInstanceId)).toEqual({
          instanceId: antigravity.instanceId,
          model: "claude-opus",
        });
        // Its own CLAUDE_CONFIG_DIR keeps a login claude-swap does not manage.
        expect(yield* service.antigravityFallbackFor(isolatedInstanceId)).toBeNull();
        expect(yield* service.claudeSwapHasRoom).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("leaves the thread to claude-swap while an account has room", () =>
    Effect.gen(function* () {
      const { service, calls, changeProviders } = yield* harness({
        accounts: [fullAt(1, "one@example.com", true), row(2, "two@example.com")],
        settings,
      });
      yield* afterStartupRead(service, calls);
      yield* changeProviders([antigravity]);
      expect(yield* service.antigravityFallbackFor(defaultInstanceId)).toBeNull();
      expect(yield* service.claudeSwapHasRoom).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("reports no room while no claude-swap account can be read", () =>
    Effect.gen(function* () {
      const { service, calls, changeProviders } = yield* harness({
        accounts: [
          row(1, "one@example.com", { usageStatus: "error", usage: null }),
          row(2, "two@example.com", { usageStatus: "error", usage: null }),
        ],
        settings,
      });
      yield* afterStartupRead(service, calls);
      yield* changeProviders([antigravity]);
      // Unknown is neither full nor room: no fallback, and nothing returns.
      expect(yield* service.antigravityFallbackFor(defaultInstanceId)).toBeNull();
      expect(yield* service.claudeSwapHasRoom).toBe(false);
    }).pipe(Effect.scoped),
  );
});

describe("UsageLimitSources.claudeLoginMovedAt", () => {
  it.effect("is when a switch settled, for default Claude instances only", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness({
        accounts: [row(1, "one@example.com", { active: true }), row(2, "two@example.com")],
      });
      yield* afterStartupRead(service, calls);
      expect(yield* service.claudeLoginMovedAt(defaultInstanceId)).toBeNull();
      const switchedAtMs = yield* Clock.currentTimeMillis;
      yield* service.switchAccount({ sourceId, accountId: "2", email: "two@example.com" });
      expect(yield* service.claudeLoginMovedAt(defaultInstanceId)).toBeNull();
      yield* TestClock.adjust("1 minute");
      expect(yield* service.claudeLoginMovedAt(defaultInstanceId)).toBe(switchedAtMs + 60_000);
      // Its own CLAUDE_CONFIG_DIR keeps a login claude-swap does not move.
      expect(yield* service.claudeLoginMovedAt(isolatedInstanceId)).toBeNull();
    }).pipe(Effect.scoped),
  );
});
