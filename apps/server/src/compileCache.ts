import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";

// Persisted after startup rather than at exit: a force-killed backend never
// reaches exit.
export const flushCompileCache = Effect.try(() => NodeModule.flushCompileCache()).pipe(
  Effect.ignore,
);
