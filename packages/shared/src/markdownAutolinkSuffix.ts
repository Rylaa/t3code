interface MarkdownNode {
  type: string;
  url?: string;
  value?: string;
  children?: MarkdownNode[];
}

// A word suffix joined to a URL with an apostrophe, as in Turkish "https://x.com'a".
const APOSTROPHE_SUFFIX = /['’]\p{L}+$/u;

/**
 * GFM autolink literals swallow a trailing `'a` suffix into the URL. Move it back
 * out of literal autolinks as plain text. GFM gives those links their own text as
 * the URL, adding `http://` for `www.` and `mailto:` for bare emails.
 */
export function splitAutolinkApostropheSuffixes(tree: MarkdownNode): void {
  const children = tree.children;
  if (!children) return;
  for (let index = 0; index < children.length; index++) {
    const node = children[index]!;
    const text = node.children?.length === 1 ? node.children[0] : undefined;
    const suffix = node.type === "link" ? APOSTROPHE_SUFFIX.exec(node.url ?? "")?.[0] : undefined;
    if (
      suffix &&
      text?.type === "text" &&
      ["", "http://", "mailto:"].some((prefix) => prefix + text.value === node.url)
    ) {
      node.url = node.url!.slice(0, -suffix.length);
      text.value = text.value!.slice(0, -suffix.length);
      children.splice(index + 1, 0, { type: "text", value: suffix });
      index++;
      continue;
    }
    splitAutolinkApostropheSuffixes(node);
  }
}

export function remarkSplitAutolinkApostropheSuffixes() {
  return splitAutolinkApostropheSuffixes;
}
