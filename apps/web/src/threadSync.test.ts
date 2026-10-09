import { describe, expect, it } from "vite-plus/test";

import { latchThreadLoadFailure, resolveThreadSyncPhase, threadSyncLabel } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
      }),
    ).toBe("loading");
  });

  it("syncs when cached detail is already visible", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
      }),
    ).toBe("syncing");
  });

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
      }),
    ).toBeNull();
  });
});

describe("threadSyncLabel", () => {
  it("uses the same loading and syncing language as mobile", () => {
    expect(threadSyncLabel("loading")).toBe("Loading messages...");
    expect(threadSyncLabel("syncing")).toBe("Syncing messages...");
  });
});

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
