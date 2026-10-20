// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// The macOS temp dir is already per user.
try {
  NodeModule.enableCompileCache(NodePath.join(NodeOS.tmpdir(), "t3code", "compile-cache"));
} catch {}
