/** Group headers and row triggers in the Skills & plugins list that arrow keys move between. */
export const NAV_ITEM_SELECTOR = "[data-nav-item]";

/**
 * Where a key moves focus in the Skills & plugins list: ArrowDown and ArrowUp
 * step through `[data-nav-item]` elements in document order, also from a
 * control inside an expanded row; Home and End jump to the ends. "search" is
 * ArrowUp past the first item. Null leaves the key to the browser.
 */
export function extensionListKeyTarget(
  list: ParentNode,
  active: Element | null,
  key: string,
): HTMLElement | "search" | null {
  const items = [...list.querySelectorAll<HTMLElement>(NAV_ITEM_SELECTOR)];
  switch (key) {
    case "Home":
      return items[0] ?? null;
    case "End":
      return items.at(-1) ?? null;
    case "ArrowDown":
      return active === null ? null : (items.find((item) => follows(active, item)) ?? null);
    case "ArrowUp":
      return active === null ? null : (items.findLast((item) => follows(item, active)) ?? "search");
    default:
      return null;
  }
}

function follows(earlier: Node, later: Node): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}
