import {
  isExplicitRelativePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@t3tools/shared/path";

export { normalizeProjectPathForComparison };

export function hasTrailingPathSeparator(value: string): boolean {
  return value.endsWith("/");
}

export { isExplicitRelativePath as isExplicitRelativeProjectPath };

function splitAbsolutePath(value: string): string[] | null {
  return value.startsWith("/") ? value.split("/").filter(Boolean) : null;
}

export function isFilesystemBrowseQuery(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.startsWith("~/")
  );
}

export function resolveProjectPathForDispatch(value: string, cwd?: string | null): string {
  const trimmedValue = value.trim();
  if (!isExplicitRelativePath(trimmedValue) || !cwd) {
    return normalizeProjectPathForDispatch(trimmedValue);
  }

  const absoluteBase = splitAbsolutePath(normalizeProjectPathForDispatch(cwd));
  if (!absoluteBase) {
    return normalizeProjectPathForDispatch(trimmedValue);
  }

  const nextSegments = [...absoluteBase];
  for (const segment of trimmedValue.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      nextSegments.pop();
      continue;
    }
    nextSegments.push(segment);
  }

  return normalizeProjectPathForDispatch(`/${nextSegments.join("/")}`);
}

export function findProjectByPath<T extends { workspaceRoot?: string; cwd?: string }>(
  projects: ReadonlyArray<T>,
  candidatePath: string,
): T | undefined {
  const normalizedCandidate = normalizeProjectPathForComparison(candidatePath);
  if (normalizedCandidate.length === 0) {
    return undefined;
  }
  return projects.find((project) => {
    const cwd = project.workspaceRoot ?? project.cwd;
    return cwd ? normalizeProjectPathForComparison(cwd) === normalizedCandidate : false;
  });
}

export function isScratchProject(
  project: { readonly workspaceRoot: string },
  scratchWorkspaceRoot: string | null | undefined,
): boolean {
  return (
    scratchWorkspaceRoot != null && findProjectByPath([project], scratchWorkspaceRoot) !== undefined
  );
}

export function inferProjectTitleFromPath(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  return normalized.split("/").findLast(Boolean) ?? normalized;
}

export function appendBrowsePathSegment(currentPath: string, segment: string): string {
  return `${getBrowseDirectoryPath(currentPath)}${segment}/`;
}

export function getBrowseLeafPathSegment(currentPath: string): string {
  return currentPath.slice(currentPath.lastIndexOf("/") + 1);
}

export function getBrowseDirectoryPath(currentPath: string): string {
  if (hasTrailingPathSeparator(currentPath)) {
    return currentPath;
  }
  const lastSeparatorIndex = currentPath.lastIndexOf("/");
  return lastSeparatorIndex < 0 ? currentPath : currentPath.slice(0, lastSeparatorIndex + 1);
}

export function ensureBrowseDirectoryPath(currentPath: string): string {
  const trimmed = currentPath.trim();
  if (trimmed.length === 0 || hasTrailingPathSeparator(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/`;
}

export function getBrowseParentPath(currentPath: string): string | null {
  const trimmed = normalizeProjectPathForDispatch(currentPath);
  const absolutePath = splitAbsolutePath(trimmed);
  if (absolutePath) {
    if (absolutePath.length === 0) return null;
    if (absolutePath.length === 1) return "/";
    return `/${absolutePath.slice(0, -1).join("/")}/`;
  }

  const lastSeparatorIndex = trimmed.lastIndexOf("/");
  return lastSeparatorIndex < 0 ? null : trimmed.slice(0, lastSeparatorIndex + 1);
}

export function canNavigateUp(currentPath: string): boolean {
  return hasTrailingPathSeparator(currentPath) && getBrowseParentPath(currentPath) !== null;
}

export * from "./projectCommands.ts";
export * from "./projectEntities.ts";
export * from "./projectRemoval.ts";
