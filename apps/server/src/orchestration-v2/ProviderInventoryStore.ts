/**
 * What each provider thread's session reported loading: Claude's init
 * skills, plugins, MCP servers and agents. It is side data, not orchestration
 * state. Keeping it out of the event log keeps it off every
 * `provider-thread.updated` event and the thread streams clients receive;
 * only the thread extensions query reads it.
 *
 * @module orchestration-v2/ProviderInventoryStore
 */
import {
  OrchestrationV2ProviderInventory,
  type ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ProviderInventoryStoreError extends Schema.TaggedError<ProviderInventoryStoreError>()(
  "ProviderInventoryStoreError",
  {
    operation: Schema.Literals(["record", "read"]),
    providerThreadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the inventory of provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderInventoryStore extends Context.Service<
  ProviderInventoryStore,
  {
    /** Replaces the provider thread's inventory. True when it changed and was written. */
    readonly record: (input: {
      readonly providerThreadId: ProviderThreadId;
      readonly threadId: ThreadId;
      readonly inventory: OrchestrationV2ProviderInventory;
    }) => Effect.Effect<boolean, ProviderInventoryStoreError>;
    /** The provider thread's latest inventory, or null before its session reports one. */
    readonly get: (
      providerThreadId: ProviderThreadId,
    ) => Effect.Effect<OrchestrationV2ProviderInventory | null, ProviderInventoryStoreError>;
  }
>()("t3/orchestration-v2/ProviderInventoryStore") {}

const InventoryJson = Schema.fromJsonString(OrchestrationV2ProviderInventory);
const encodeInventory = Schema.encodeEffect(InventoryJson);
const decodeInventory = Schema.decodeUnknownEffect(InventoryJson);

export const layer = Layer.effect(
  ProviderInventoryStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const record: ProviderInventoryStore["Service"]["record"] = (input) =>
      Effect.gen(function* () {
        const inventoryJson = yield* encodeInventory(input.inventory);
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        // An unchanged inventory, such as the same init after a restart, writes nothing.
        const written = yield* sql<{ readonly provider_thread_id: string }>`
          INSERT INTO orchestration_v2_provider_inventories (
            provider_thread_id, thread_id, inventory_json, updated_at
          )
          VALUES (${input.providerThreadId}, ${input.threadId}, ${inventoryJson}, ${updatedAt})
          ON CONFLICT(provider_thread_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            inventory_json = excluded.inventory_json,
            updated_at = excluded.updated_at
          WHERE orchestration_v2_provider_inventories.inventory_json <> excluded.inventory_json
          RETURNING provider_thread_id
        `;
        return written.length > 0;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderInventoryStoreError({
              operation: "record",
              providerThreadId: input.providerThreadId,
              cause,
            }),
        ),
      );

    const get: ProviderInventoryStore["Service"]["get"] = (providerThreadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly inventory_json: string }>`
          SELECT inventory_json FROM orchestration_v2_provider_inventories
          WHERE provider_thread_id = ${providerThreadId}
        `;
        const row = rows[0];
        return row === undefined ? null : yield* decodeInventory(row.inventory_json);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderInventoryStoreError({ operation: "read", providerThreadId, cause }),
        ),
      );

    return ProviderInventoryStore.of({ record, get });
  }),
);

const inventoriesEqual = Schema.toEquivalence(OrchestrationV2ProviderInventory);

/** In-memory store for tests that run without SQLite. */
export const layerMemory = Layer.effect(
  ProviderInventoryStore,
  Effect.gen(function* () {
    const inventories = yield* Ref.make(
      new Map<ProviderThreadId, OrchestrationV2ProviderInventory>(),
    );
    return ProviderInventoryStore.of({
      record: (input) =>
        Ref.modify(inventories, (current) => {
          const existing = current.get(input.providerThreadId);
          if (existing !== undefined && inventoriesEqual(existing, input.inventory)) {
            return [false, current];
          }
          return [true, new Map(current).set(input.providerThreadId, input.inventory)];
        }),
      get: (providerThreadId) =>
        Ref.get(inventories).pipe(Effect.map((current) => current.get(providerThreadId) ?? null)),
    });
  }),
);
