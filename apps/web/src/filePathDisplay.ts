import { fileBasename } from "@t3tools/shared/path";
import { formatFilePathPosition, splitFilePathPosition } from "@t3tools/shared/fileLinks";

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

export function formatWorkspaceRelativePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const position = splitFilePathPosition(pathWithPosition);
  const path = position.path;

  let displayPath = path;
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/\/+$/, "");
    const workspaceLabel = fileBasename(root);

    if (path === root) {
      displayPath = workspaceLabel;
    } else if (path.startsWith(`${root}/`)) {
      displayPath = `${workspaceLabel}/${path.slice(root.length + 1)}`;
    } else if (!path.startsWith("/")) {
      displayPath = path.startsWith(`${workspaceLabel}/`)
        ? path
        : `${workspaceLabel}/${stripRelativePrefixes(path)}`;
    }
  }

  return formatFilePathPosition({ ...position, path: displayPath });
}
