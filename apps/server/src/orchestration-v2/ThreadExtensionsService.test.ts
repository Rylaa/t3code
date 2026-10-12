import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2McpServers,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderInventoryStore from "./ProviderInventoryStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import type { ThreadExtensionUsageItem } from "./ThreadExtensionUsage.ts";
import * as ThreadExtensionsService from "./ThreadExtensionsService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const codexInstanceId = ProviderInstanceId.make("codex");

function makeLayer(input: {
  readonly providers: ReadonlyArray<unknown>;
  readonly items?: ReadonlyArray<ThreadExtensionUsageItem>;
  readonly records: () => unknown;
  /** The live runtime's MCP servers; absent means no live session. */
  readonly mcpServers?: ProviderAdapterV2McpServers;
}) {
  return ThreadExtensionsService.layer.pipe(
    Layer.provideMerge(ProviderInventoryStore.layerMemory),
    Layer.provide(
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        get: () =>
          Effect.succeed(
            input.mcpServers === undefined
              ? Option.none()
              : Option.some({ mcpServers: input.mcpServers } as never),
          ),
      }),
    ),
    Layer.provide(ProviderRegistryMock.layer(input.providers as ReadonlyArray<ServerProvider>)),
    Layer.provide(ThreadManagementService.layer),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getExtensionUsageItems: () => Effect.succeed(input.items ?? []),
        getThreadRecords: () =>
          Effect.sync(() => input.records() as OrchestrationV2ThreadProjection),
      }),
    ),
  );
}

it.effect("reads the active provider thread's stored inventory", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:extensions");
    const claudeThreadId = ProviderThreadId.make("provider-thread:claude");
    const codexThreadId = ProviderThreadId.make("provider-thread:codex");
    const inventory = {
      skills: ["review"],
      plugins: [],
      mcpServers: [{ name: "context7", status: "connected" }],
      agents: [],
    };
    let providerInstanceId = claudeInstanceId;
    let activeProviderThreadId: ProviderThreadId | null = null;
    const layerTest = makeLayer({
      providers: [
        {
          instanceId: claudeInstanceId,
          driver: ProviderDriverKind.make("claudeAgent"),
          skills: [],
        },
        { instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), skills: [] },
      ],
      records: () => ({
        thread: { id: threadId, providerInstanceId, activeProviderThreadId, worktreePath: null },
        providerThreads: [
          {
            id: claudeThreadId,
            driver: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeInstanceId,
          },
          {
            id: codexThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
          },
        ],
        providerSessions: [],
      }),
    });

    yield* Effect.gen(function* () {
      const service = yield* ThreadExtensionsService.ThreadExtensionsService;
      const inventories = yield* ProviderInventoryStore.ProviderInventoryStore;
      const read = () =>
        service
          .get(threadId)
          .pipe(Effect.map(({ inventoryStatus, inventory }) => ({ inventoryStatus, inventory })));

      // A Claude thread with no session yet has loaded nothing so far.
      expect(yield* read()).toEqual({ inventoryStatus: "pending", inventory: null });
      // A new Codex thread, or a fork, with no session yet never reports one.
      providerInstanceId = codexInstanceId;
      expect(yield* read()).toEqual({ inventoryStatus: "unsupported", inventory: null });

      activeProviderThreadId = claudeThreadId;
      expect(yield* read()).toEqual({ inventoryStatus: "pending", inventory: null });

      expect(
        yield* inventories.record({ providerThreadId: claudeThreadId, threadId, inventory }),
      ).toBe(true);
      // The same init again, as after a restart, writes nothing.
      expect(
        yield* inventories.record({ providerThreadId: claudeThreadId, threadId, inventory }),
      ).toBe(false);
      expect(yield* read()).toEqual({ inventoryStatus: "available", inventory });

      activeProviderThreadId = codexThreadId;
      expect(yield* read()).toEqual({ inventoryStatus: "unsupported", inventory: null });
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("counts a Codex $skill the provider discovered for the session's cwd", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:codex-skills");
    const providerThreadId = ProviderThreadId.make("provider-thread:codex-skills");
    const providerSessionId = ProviderSessionId.make("provider-session:codex-skills");
    const prompt = (id: string, text: string): ThreadExtensionUsageItem => ({
      type: "prompt",
      threadId,
      itemId: TurnItemId.make(id),
      runId: RunId.make(`run:${id}`),
      at: DateTime.makeUnsafe(Date.UTC(2026, 9, 8, 12)),
      text,
    });
    const skill = (name: string) => ({ name, path: `/skills/${name}/SKILL.md`, enabled: true });
    const layerTest = makeLayer({
      providers: [
        {
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          // The machine scan; the session's workspace has its own list.
          skills: [skill("elsewhere")],
          workspaceSnapshots: [
            {
              cwd: "/repo",
              checkedAt: "2026-10-08T12:00:00.000Z",
              slashCommands: [],
              skills: [skill("review"), { ...skill("disabled"), enabled: false }],
            },
          ],
        },
      ],
      items: [
        prompt("item:review", "$review fix this"),
        prompt("item:shell", "cd $repo && echo $elsewhere $disabled"),
      ],
      records: () => ({
        thread: {
          id: threadId,
          providerInstanceId: codexInstanceId,
          activeProviderThreadId: providerThreadId,
          worktreePath: null,
        },
        providerThreads: [
          {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            providerSessionId,
          },
        ],
        providerSessions: [{ id: providerSessionId, cwd: "/repo" }],
      }),
    });

    const extensions = yield* ThreadExtensionsService.ThreadExtensionsService.pipe(
      Effect.flatMap((service) => service.get(threadId)),
      Effect.provide(layerTest),
    );

    expect(extensions.inventoryStatus).toBe("unsupported");
    expect(extensions.used.map(({ kind, name, count }) => ({ kind, name, count }))).toEqual([
      { kind: "skill", name: "review", count: 1 },
    ]);
  }),
);

describe("live MCP servers", () => {
  const threadId = ThreadId.make("thread:live-mcp");
  const providerThreadId = ProviderThreadId.make("provider-thread:live-mcp");
  const providerSessionId = ProviderSessionId.make("provider-session:live-mcp");
  const snapshot = {
    skills: ["review"],
    plugins: [],
    mcpServers: [{ name: "context7", status: "pending" }],
    agents: [],
  };
  const live = [
    { name: "context7", status: "connected", source: "user", tools: ["resolve", "docs"] },
    { name: "linear", status: "failed", error: "connect ECONNREFUSED" },
  ];
  const records = (driver: string, instanceId: ProviderInstanceId) => () => ({
    thread: {
      id: threadId,
      providerInstanceId: instanceId,
      activeProviderThreadId: providerThreadId,
      worktreePath: null,
    },
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make(driver),
        providerInstanceId: instanceId,
        providerSessionId,
      },
    ],
    providerSessions: [{ id: providerSessionId, cwd: "/repo" }],
  });
  const claudeLayer = (mcpServers: ProviderAdapterV2McpServers) =>
    makeLayer({
      providers: [
        {
          instanceId: claudeInstanceId,
          driver: ProviderDriverKind.make("claudeAgent"),
          skills: [],
        },
      ],
      records: records("claudeAgent", claudeInstanceId),
      mcpServers,
    });
  const recordSnapshot = Effect.gen(function* () {
    const inventories = yield* ProviderInventoryStore.ProviderInventoryStore;
    yield* inventories.record({ providerThreadId, threadId, inventory: snapshot });
  });
  const storedInventory = ProviderInventoryStore.ProviderInventoryStore.pipe(
    Effect.flatMap((inventories) => inventories.get(providerThreadId)),
  );
  const read = ThreadExtensionsService.ThreadExtensionsService.pipe(
    Effect.flatMap((service) => service.get(threadId)),
  );

  it.effect("replaces the snapshot's servers with the live session's, and stores nothing", () =>
    Effect.gen(function* () {
      yield* recordSnapshot;
      const extensions = yield* read;
      expect(extensions.inventoryStatus).toBe("available");
      expect(extensions.inventory).toEqual({ ...snapshot, mcpServers: live });
      expect(extensions.mcpServersLive).toBe(true);
      expect(yield* storedInventory).toEqual(snapshot);
    }).pipe(Effect.provide(claudeLayer({ status: () => Effect.succeed(live) }))),
  );

  it.effect("falls back to the snapshot when the live read fails", () =>
    Effect.gen(function* () {
      yield* recordSnapshot;
      const extensions = yield* read;
      expect(extensions.inventory).toEqual(snapshot);
      expect(extensions.mcpServersLive).toBeUndefined();
    }).pipe(
      Effect.provide(
        claudeLayer({
          status: () =>
            Effect.fail(
              new ProviderAdapterProtocolError({
                driver: ProviderDriverKind.make("claudeAgent"),
                detail: "no live query",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("falls back to the snapshot when the live read takes over 2 seconds", () =>
    Effect.gen(function* () {
      yield* recordSnapshot;
      const fiber = yield* read.pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const extensions = yield* Fiber.join(fiber);
      expect(extensions.inventory).toEqual(snapshot);
      expect(extensions.mcpServersLive).toBeUndefined();
    }).pipe(Effect.provide(claudeLayer({ status: () => Effect.never }))),
  );

  it.effect(
    "shows live servers for a provider without a stored inventory and keeps its discovered skills",
    () =>
      Effect.gen(function* () {
        const extensions = yield* read;
        expect(extensions.inventoryStatus).toBe("unsupported");
        expect(extensions.inventory).toEqual({
          skills: [],
          plugins: [],
          agents: [],
          mcpServers: live,
        });
        expect(extensions.mcpServersLive).toBe(true);
        expect(extensions.used.map(({ kind, name }) => ({ kind, name }))).toEqual([
          { kind: "skill", name: "review" },
        ]);
        expect(yield* storedInventory).toBeNull();
      }).pipe(
        Effect.provide(
          makeLayer({
            providers: [
              {
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                skills: [{ name: "review", path: "/skills/review/SKILL.md", enabled: true }],
              },
            ],
            items: [
              {
                type: "prompt",
                threadId,
                itemId: TurnItemId.make("item:live-review"),
                runId: RunId.make("run:live-review"),
                at: DateTime.makeUnsafe(Date.UTC(2026, 9, 11, 12)),
                text: "$review this",
              },
            ],
            records: records("codex", codexInstanceId),
            mcpServers: { status: () => Effect.succeed(live) },
          }),
        ),
      ),
  );
});
