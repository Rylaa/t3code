import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { threadExtensionMetaLabel } from "./thread-extensions-presentation";

const now = Date.UTC(2026, 9, 11, 12, 0, 0);

describe("threadExtensionMetaLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts uses and says how long ago the last one was", () => {
    expect(
      threadExtensionMetaLabel({ count: 3, lastUsedAt: DateTime.makeUnsafe(now - 5 * 60_000) }),
    ).toBe("3 uses · 5m ago");
    expect(
      threadExtensionMetaLabel({ count: 1, lastUsedAt: DateTime.makeUnsafe(now - 20_000) }),
    ).toBe("1 use · just now");
    expect(threadExtensionMetaLabel({ count: 2, lastUsedAt: null })).toBe("2 uses");
  });

  it("says nothing for something never used", () => {
    expect(threadExtensionMetaLabel({ count: 0, lastUsedAt: null })).toBeNull();
  });
});
