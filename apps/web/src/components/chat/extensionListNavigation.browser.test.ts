import { describe, expect, it } from "vite-plus/test";

import { extensionListKeyTarget } from "./extensionListNavigation";

function mountList() {
  const list = document.createElement("div");
  list.innerHTML = `
    <button data-nav-item id="header">Used in this thread</button>
    <button data-nav-item id="first">seo-audit</button>
    <div><button id="copy">Copy /seo-audit</button></div>
    <button data-nav-item id="second">schema</button>`;
  document.body.append(list);
  return {
    list,
    byId: (id: string) => list.querySelector<HTMLElement>(`#${id}`),
    [Symbol.dispose]: () => list.remove(),
  };
}

describe("extensionListKeyTarget", () => {
  it("steps through headers and rows in document order and stops at the last", () => {
    using fixture = mountList();
    const { list, byId } = fixture;
    expect(extensionListKeyTarget(list, byId("header"), "ArrowDown")).toBe(byId("first"));
    expect(extensionListKeyTarget(list, byId("first"), "ArrowDown")).toBe(byId("second"));
    expect(extensionListKeyTarget(list, byId("second"), "ArrowDown")).toBeNull();
    expect(extensionListKeyTarget(list, byId("second"), "ArrowUp")).toBe(byId("first"));
  });

  it("moves on from a control inside an expanded row", () => {
    using fixture = mountList();
    const { list, byId } = fixture;
    expect(extensionListKeyTarget(list, byId("copy"), "ArrowDown")).toBe(byId("second"));
    expect(extensionListKeyTarget(list, byId("copy"), "ArrowUp")).toBe(byId("first"));
  });

  it("returns to search from the first item", () => {
    using fixture = mountList();
    const { list, byId } = fixture;
    expect(extensionListKeyTarget(list, byId("header"), "ArrowUp")).toBe("search");
  });

  it("jumps with Home and End and leaves other keys alone", () => {
    using fixture = mountList();
    const { list, byId } = fixture;
    expect(extensionListKeyTarget(list, byId("second"), "Home")).toBe(byId("header"));
    expect(extensionListKeyTarget(list, byId("header"), "End")).toBe(byId("second"));
    expect(extensionListKeyTarget(list, byId("first"), "Enter")).toBeNull();
    expect(extensionListKeyTarget(list, byId("first"), "ArrowLeft")).toBeNull();
  });
});
