import { describe, expect, it } from "vitest";

import { composerStashAction } from "./ComposerStashButton";

describe("composerStashAction", () => {
  it("stashes whenever the composer holds a draft, even with entries waiting", () => {
    expect(composerStashAction({ hasDraft: true, stashCount: 0 })).toBe("stash");
    expect(composerStashAction({ hasDraft: true, stashCount: 3 })).toBe("stash");
  });

  it("restores the only entry straight away from an empty composer", () => {
    expect(composerStashAction({ hasDraft: false, stashCount: 1 })).toBe("restore");
  });

  it("opens the stash to pick from several entries", () => {
    expect(composerStashAction({ hasDraft: false, stashCount: 2 })).toBe("open");
  });

  it("has nothing to do with an empty composer and an empty stash", () => {
    expect(composerStashAction({ hasDraft: false, stashCount: 0 })).toBeNull();
  });
});
