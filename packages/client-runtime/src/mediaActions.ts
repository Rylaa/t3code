// Hosts are macOS-only in this fork, so a path is copied in the style it was written.
export function formatFilePathForClipboard(path: string, _hostPath?: string): string {
  return path;
}

export type MediaActionId =
  | "copy-full-path"
  | "copy-relative-path"
  | "copy-url"
  | "open-file"
  | "save"
  | "copy-image";
