import { ProviderThreadId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ProviderInventoryStore from "./ProviderInventoryStore.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = it.layer(
  Layer.merge(database, ProviderInventoryStore.layer.pipe(Layer.provide(database))),
);

const threadId = ThreadId.make("thread-inventory");
const providerThreadId = ProviderThreadId.make("provider-thread-inventory");
const inventory = {
  skills: ["review", "caveman:caveman-review"],
  plugins: [{ name: "caveman", version: "1.2.0" }],
  mcpServers: [{ name: "context7", status: "connected", source: "user" }],
  agents: ["Explore"],
};

layer("ProviderInventoryStore", (it) => {
  it.effect("writes an inventory only when it changes", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProviderInventoryStore.ProviderInventoryStore;
      const updatedAt = () =>
        sql<{ readonly updated_at: string }>`
          SELECT updated_at FROM orchestration_v2_provider_inventories
          WHERE provider_thread_id = ${providerThreadId}
        `.pipe(Effect.map((rows) => rows[0]?.updated_at));

      assert.isNull(yield* store.get(providerThreadId));
      assert.isTrue(yield* store.record({ providerThreadId, threadId, inventory }));
      assert.deepStrictEqual(yield* store.get(providerThreadId), inventory);

      // Pin the row's timestamp so an unchanged record that wrote would show.
      yield* sql`UPDATE orchestration_v2_provider_inventories SET updated_at = 'pinned'`;
      assert.isFalse(yield* store.record({ providerThreadId, threadId, inventory }));
      assert.strictEqual(yield* updatedAt(), "pinned");

      const next = { ...inventory, skills: ["review"] };
      assert.isTrue(yield* store.record({ providerThreadId, threadId, inventory: next }));
      assert.deepStrictEqual(yield* store.get(providerThreadId), next);
      assert.notStrictEqual(yield* updatedAt(), "pinned");
    }),
  );
});
