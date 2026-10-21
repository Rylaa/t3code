import { describe, expect, it } from "vite-plus/test";

import { fileBreadcrumbChildren, fileBreadcrumbs, retainedBreadcrumbTrail } from "./filePath";

describe("fileBreadcrumbs", () => {
  it("starts host paths outside the workspace at the filesystem root", () => {
    expect(fileBreadcrumbs("t3code", "/tmp/t3-cleanup/report.md")).toEqual([
      { label: "tmp", path: "/tmp", kind: "directory" },
      { label: "t3-cleanup", path: "/tmp/t3-cleanup", kind: "directory" },
      { label: "report.md", path: "/tmp/t3-cleanup/report.md", kind: "file" },
    ]);
  });
});

describe("fileBreadcrumbChildren", () => {
  const entries = [
    { path: "README.md", kind: "file" as const },
    { path: "src", kind: "directory" as const },
    { path: "src-old", kind: "directory" as const },
    { path: "src/index.ts", kind: "file" as const },
    { path: "src/lib", kind: "directory" as const },
    { path: "src/lib/file10.ts", kind: "file" as const },
    { path: "src/lib/file2.ts", kind: "file" as const },
    { path: "src-old/index.ts", kind: "file" as const },
  ];

  it("honors segment boundaries and sorts folders before files", () => {
    expect(fileBreadcrumbChildren(entries, "src")).toEqual([
      { path: "src/lib", kind: "directory", label: "lib" },
      { path: "src/index.ts", kind: "file", label: "index.ts" },
    ]);
  });
});

describe("retainedBreadcrumbTrail", () => {
  it.each([
    // Walking up keeps the deeper path, all the way to the workspace root.
    ["apps/web/src", "apps/web", "apps/web/src"],
    ["apps/web/src", "", "apps/web/src"],
    // Walking back down inside the trail keeps it too.
    ["apps/web/src", "apps/web/src", "apps/web/src"],
    // Somewhere else starts over, including a sibling that shares a name prefix.
    ["apps/web/src", "apps/mobile", "apps/mobile"],
    ["src/lib", "src-old", "src-old"],
    ["apps/web", "apps/web/src/main.tsx", "apps/web/src/main.tsx"],
    // Workspace and host paths never share a trail.
    ["apps/web/src", "/tmp/report", "/tmp/report"],
    ["/tmp/report", "", ""],
    // Host folders outside the workspace keep their trail the same way.
    ["/Users/me/projects/scope", "/Users/me", "/Users/me/projects/scope"],
    ["/Users/me/projects/scope", "/Users/me/proj", "/Users/me/proj"],
    ["/Volumes/Work/a", "/Volumes/Work/a/", "/Volumes/Work/a"],
  ])("from trail %j to %j keeps %j", (trail, path, expected) => {
    expect(retainedBreadcrumbTrail(trail, path)).toBe(expected);
  });
});
