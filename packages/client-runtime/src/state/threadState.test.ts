import { describe, expect, it } from "vite-plus/test";

import { latchThreadLoadFailure } from "./threadState.ts";

describe("latchThreadLoadFailure", () => {
  it("keeps the failure through retries until another error replaces it", () => {
    const failed = latchThreadLoadFailure(null, "env:a", "Failed to load thread a");
    expect(failed).toEqual({ threadKey: "env:a", message: "Failed to load thread a" });
    // A retry in flight clears the runtime error; the failure stays up.
    expect(latchThreadLoadFailure(failed, "env:a", null)).toBe(failed);
    expect(latchThreadLoadFailure(failed, "env:a", "Failed to load thread a")).toBe(failed);
    expect(latchThreadLoadFailure(failed, "env:b", "Failed to load thread b")).toEqual({
      threadKey: "env:b",
      message: "Failed to load thread b",
    });
  });
});
