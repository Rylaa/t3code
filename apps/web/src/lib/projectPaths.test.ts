import { describe, expect, it } from "vite-plus/test";

import {
  appendBrowsePathSegment,
  canNavigateUp,
  getBrowseDirectoryPath,
  findProjectByPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  resolveProjectPathForDispatch,
} from "./projectPaths";

describe("projectPaths", () => {
  it("normalizes trailing separators for dispatch and comparison", () => {
    expect(normalizeProjectPathForDispatch(" /repo/app/ ")).toBe("/repo/app");
    expect(normalizeProjectPathForComparison("/repo/app/")).toBe("/repo/app");
  });

  it("finds existing projects even when the input formatting differs", () => {
    const existing = findProjectByPath(
      [
        { id: "project-1", cwd: "/repo/app" },
        { id: "project-2", cwd: "/work/repo" },
      ],
      "/work/repo/",
    );

    expect(existing?.id).toBe("project-2");
  });

  it("infers project titles from normalized paths", () => {
    expect(inferProjectTitleFromPath("/repo/app/")).toBe("app");
    expect(inferProjectTitleFromPath("/home/user\\project/")).toBe("user\\project");
  });

  it("detects browse queries", () => {
    expect(isFilesystemBrowseQuery(".")).toBe(false);
    expect(isFilesystemBrowseQuery("..")).toBe(false);
    expect(isFilesystemBrowseQuery("./")).toBe(true);
    expect(isFilesystemBrowseQuery("../")).toBe(true);
    expect(isFilesystemBrowseQuery("~/projects")).toBe(true);
    expect(isFilesystemBrowseQuery("notes")).toBe(false);
  });

  it("detects explicit relative project paths", () => {
    expect(isExplicitRelativeProjectPath(".")).toBe(true);
    expect(isExplicitRelativeProjectPath("..")).toBe(true);
    expect(isExplicitRelativeProjectPath("./docs")).toBe(true);
    expect(isExplicitRelativeProjectPath("/repo/docs")).toBe(false);
  });

  it("resolves explicit relative paths against the current project", () => {
    expect(resolveProjectPathForDispatch(".", "/repo/app")).toBe("/repo/app");
    expect(resolveProjectPathForDispatch("..", "/repo/app")).toBe("/repo");
    expect(resolveProjectPathForDispatch("./docs", "/repo/app")).toBe("/repo/app/docs");
    expect(resolveProjectPathForDispatch("../docs", "/repo/app")).toBe("/repo/docs");
    expect(resolveProjectPathForDispatch("./docs", "/home/user\\project")).toBe(
      "/home/user\\project/docs",
    );
  });

  it("navigates browse paths", () => {
    expect(appendBrowsePathSegment("/repo/", "src")).toBe("/repo/src/");
    expect(appendBrowsePathSegment("/home/user\\project/", "docs")).toBe(
      "/home/user\\project/docs/",
    );
    expect(getBrowseParentPath("/repo/src/")).toBe("/repo/");
    expect(getBrowseParentPath("/")).toBeNull();
    expect(getBrowseParentPath("/home/user\\project/docs/")).toBe("/home/user\\project/");
  });

  it("detects browse path boundaries", () => {
    expect(hasTrailingPathSeparator("/repo/src/")).toBe(true);
    expect(hasTrailingPathSeparator("/repo/src")).toBe(false);
    expect(getBrowseDirectoryPath("/repo/src")).toBe("/repo/");
    expect(getBrowseDirectoryPath("/repo/src/")).toBe("/repo/src/");
    expect(getBrowseLeafPathSegment("/repo/src")).toBe("src");
    expect(getBrowseDirectoryPath("/home/user\\project/docs")).toBe("/home/user\\project/");
    expect(getBrowseLeafPathSegment("/home/user\\project/docs")).toBe("docs");
  });

  it("only allows browse-up after entering a directory", () => {
    expect(canNavigateUp("~/repo")).toBe(false);
    expect(canNavigateUp("~/a")).toBe(false);
    expect(canNavigateUp("~/repo/")).toBe(true);
    expect(canNavigateUp("/")).toBe(false);
  });
});
