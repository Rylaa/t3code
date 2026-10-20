import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork-only column, added on open instead of through a numbered migration so
 * upstream migration ids stay free and future upstream migrations still run.
 */
export const ensureProjectFocusColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  if (!columns.some((column) => column.name === "focus_json")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN focus_json TEXT`;
  }
}).pipe(Effect.orDie);
