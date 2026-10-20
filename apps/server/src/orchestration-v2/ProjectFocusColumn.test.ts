import { assert, it } from "@effect/vitest";
import { type ApplicationProjectEvent, EventId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ensureProjectFocusColumn } from "./ProjectFocusColumn.ts";
import * as ProjectStore from "./ProjectStore.ts";

const projectId = ProjectId.make("project-focus");
const focus = { until: "2026-10-24T15:00:00.000Z", note: "Finish checkout" };

const metaUpdated = (
  sequence: number,
  payload: Omit<
    Extract<ApplicationProjectEvent, { type: "project.meta-updated" }>["payload"],
    "projectId" | "updatedAt"
  >,
): ApplicationProjectEvent => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "project",
  aggregateId: projectId,
  occurredAt: "2026-10-20T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.meta-updated",
  payload: { projectId, updatedAt: "2026-10-20T00:00:00.000Z", ...payload },
});

const focusColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  return columns.filter((column) => column.name === "focus_json").length;
});

it.layer(SqlitePersistence.layerMemory)("ProjectFocusColumn", (it) => {
  it.effect("adds the column to an existing database once, outside the migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The numbered migrations stay upstream's: they must not create it.
      assert.strictEqual(yield* focusColumns, 0);
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${projectId}, 'Legacy', '/tmp/legacy', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;

      yield* ensureProjectFocusColumn;
      yield* ensureProjectFocusColumn;
      assert.strictEqual(yield* focusColumns, 1);

      const projects = yield* ProjectStore.make;
      const legacy = Option.getOrThrow(yield* projects.getShell(projectId));
      assert.isNull(legacy.focus);

      yield* projects.apply(metaUpdated(1, { focus }));
      assert.deepStrictEqual(Option.getOrThrow(yield* projects.get(projectId)).focus, focus);
      assert.deepStrictEqual(Option.getOrThrow(yield* projects.getShell(projectId)).focus, focus);

      yield* projects.apply(metaUpdated(2, { title: "Renamed" }));
      const renamed = Option.getOrThrow(yield* projects.getShell(projectId));
      assert.strictEqual(renamed.title, "Renamed");
      assert.deepStrictEqual(renamed.focus, focus);

      yield* projects.apply(metaUpdated(3, { focus: null }));
      assert.isNull(Option.getOrThrow(yield* projects.getShell(projectId)).focus);
    }),
  );
});
