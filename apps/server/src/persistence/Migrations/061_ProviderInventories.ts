import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // What each provider thread's session reported loading (Claude's init
  // skills, plugins, MCP servers and agents), replaced when it changes. Side
  // data outside the event log, so projection rebuilds leave it alone.
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_provider_inventories (
      provider_thread_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      inventory_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
