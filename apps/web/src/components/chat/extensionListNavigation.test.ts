// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vite-plus/test";

import { extensionListKeyTarget } from "./extensionListNavigation";

let list: HTMLElement;
const byId = (id: string) => document.getElementById(id);

beforeEach(() => {
  document.body.innerHTML = `
    <div id="list">
      <button data-nav-item id="header">Used in this thread</button>
      <button data-nav-item id="first">seo-audit</button>
      <div><button id="copy">Copy /seo-audit</button></div>
      <button data-nav-item id="second">schema</button>
    </div>`;
  list = byId("list")!;
});

describe("extensionListKeyTarget", () => {
  it("steps through headers and rows in document order and stops at the last", () => {
    expect(extensionListKeyTarget(list, byId("header"), "ArrowDown")).toBe(byId("first"));
    expect(extensionListKeyTarget(list, byId("first"), "ArrowDown")).toBe(byId("second"));
    expect(extensionListKeyTarget(list, byId("second"), "ArrowDown")).toBeNull();
    expect(extensionListKeyTarget(list, byId("second"), "ArrowUp")).toBe(byId("first"));
  });

  it("moves on from a control inside an expanded row", () => {
    expect(extensionListKeyTarget(list, byId("copy"), "ArrowDown")).toBe(byId("second"));
    expect(extensionListKeyTarget(list, byId("copy"), "ArrowUp")).toBe(byId("first"));
  });

  it("returns to search from the first item", () => {
    expect(extensionListKeyTarget(list, byId("header"), "ArrowUp")).toBe("search");
  });

  it("jumps with Home and End and leaves other keys alone", () => {
    expect(extensionListKeyTarget(list, byId("second"), "Home")).toBe(byId("header"));
    expect(extensionListKeyTarget(list, byId("header"), "End")).toBe(byId("second"));
    expect(extensionListKeyTarget(list, byId("first"), "Enter")).toBeNull();
    expect(extensionListKeyTarget(list, byId("first"), "ArrowLeft")).toBeNull();
  });
});
