export function isExplicitRelativePath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
}

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || value === "/") {
    return value;
  }
  const trimmed = value.replace(/\/+$/g, "");
  return trimmed.length === 0 ? value : trimmed;
}

export function normalizeProjectPathForDispatch(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function normalizeProjectPathForComparison(value: string): string {
  return normalizeProjectPathForDispatch(value);
}

// Windows refuses these as file names, with or without an extension.
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function newProjectFolderName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  if (slug.length === 0) return "project";
  return WINDOWS_RESERVED_NAME.test(slug) ? `${slug}-project` : slug;
}

export function fileBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length === 0) return path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function workspaceRelativeFilePath(
  path: string,
  workspaceRoot: string | null | undefined,
): string | null {
  if (!workspaceRoot) return null;
  const normalizedRoot = workspaceRoot.replace(/\/+$/, "");
  if (path.replace(/\/+$/, "") === normalizedRoot) return ".";
  if (!path.startsWith(`${normalizedRoot}/`)) return null;
  return path.slice(normalizedRoot.length + 1);
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

export function resolveWorkspaceFilePath(path: string, workspaceRoot: string): string {
  if (isAbsolutePath(path) || path.startsWith("~/")) return path;
  return `${workspaceRoot.replace(/\/+$/, "")}/${path}`;
}
