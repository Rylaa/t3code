import { describe, expect, it } from "vite-plus/test";
import {
  workspaceRelativeFilePath,
  newProjectFolderName,
  normalizeProjectPathForDispatch,
  resolveWorkspaceFilePath,
} from "./path.ts";

describe("path helpers", () => {
  // regression: #17923 literal colons in names are kept, not parsed as positions
  it.each([
    ["report:123", "/workspace", "/workspace/report:123"],
    ["~/report:123", "/workspace", "~/report:123"],
  ])("resolves literal path %s within %s", (path, root, expected) => {
    expect(resolveWorkspaceFilePath(path, root)).toBe(expected);
  });

  it("trims trailing separators but keeps the root", () => {
    expect(normalizeProjectPathForDispatch(" /repo/app// ")).toBe("/repo/app");
    expect(normalizeProjectPathForDispatch("/")).toBe("/");
  });

  it("names a new project's folder from any typed name", () => {
    expect(newProjectFolderName("Pinball Stats")).toBe("pinball-stats");
    expect(newProjectFolderName("  Café & Crème!  ")).toBe("cafe-creme");
    expect(newProjectFolderName("../../etc")).toBe("etc");
    expect(newProjectFolderName("🎱🎱")).toBe("project");
    expect(newProjectFolderName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    expect(newProjectFolderName("Con")).toBe("con-project");
    expect(newProjectFolderName("LPT1")).toBe("lpt1-project");
    expect(newProjectFolderName("console")).toBe("console");
  });
});

describe("workspaceRelativeFilePath", () => {
  // regression: #9309 POSIX paths compare case-sensitively, Windows paths do not
  it.each([
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["/repo/project-two/a.ts", "/repo/project", null],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});
