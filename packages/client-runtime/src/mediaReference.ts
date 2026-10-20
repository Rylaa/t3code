import { safeDecodeURIComponent } from "@t3tools/shared/markdownLinks";

export type MediaReference =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly relativePath?: string;
    }
  | { readonly kind: "url"; readonly url: string };

function absolutePathParts(path: string) {
  if (!path.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments;
}

export function mediaFileReference(
  path: string,
  workspaceRoot?: string | null,
): Extract<MediaReference, { kind: "file" }> {
  const target = absolutePathParts(path);
  const workspace = workspaceRoot ? absolutePathParts(workspaceRoot) : undefined;
  if (
    !target ||
    !workspace ||
    target.length <= workspace.length ||
    !workspace.every((segment, index) => segment === target[index])
  ) {
    return { kind: "file", path };
  }
  return {
    kind: "file",
    path,
    relativePath: target.slice(workspace.length).join("/"),
  };
}

/** Pass the authored source, not a generated URL used by the media player. */
export function mediaUrlReference(
  url: string,
): Extract<MediaReference, { kind: "url" }> | undefined {
  if (!/^(?:https?:\/\/|\/\/)/i.test(url)) return undefined;
  try {
    const parsed = new URL(url.startsWith("//") ? `https:${url}` : url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? { kind: "url", url }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Local paths are already decoded; URL filename escapes are decoded exactly once. */
export function mediaReferenceFileName(reference: MediaReference): string | undefined {
  if (reference.kind === "file") {
    return reference.path.split("/").at(-1) || undefined;
  }

  let basename: string | undefined;
  try {
    const url = reference.url;
    basename = new URL(url.startsWith("//") ? `https:${url}` : url).pathname.split("/").at(-1);
  } catch {
    return undefined;
  }
  return basename ? safeDecodeURIComponent(basename) : undefined;
}
