import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  latestProviderThreadTokenUsage,
} from "./contextWindow";

describe("V2 context window presentation", () => {
  it("uses retained compaction token data when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      {
        item: {
          id: "compaction-1" as never,
          threadId: "thread-1" as never,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
          type: "compaction",
          driver: null,
          beforeTokenCount: 10_000,
          afterTokenCount: 2_000,
        },
      },
    ]);
    expect(snapshot?.usedTokens).toBe(2_000);
    expect(snapshot?.totalProcessedTokens).toBe(10_000);
  });

  it("prefers current provider usage and preserves ACP cost", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], undefined, {
      id: "provider-thread" as never,
      contextUsage: {
        usedTokens: 2_500,
        maxTokens: 10_000,
        cost: { amount: 0.42, currency: "USD" },
      },
      updatedAt: DateTime.makeUnsafe("2026-08-23T00:00:00.000Z"),
    });

    expect(snapshot).toMatchObject({
      usedTokens: 2_500,
      maxTokens: 10_000,
      remainingTokens: 7_500,
      usedPercentage: 25,
      cost: { amount: 0.42, currency: "USD" },
    });
  });

  it("formats compact token values", () => {
    expect(formatContextWindowTokens(1_500)).toBe("1.5k");
  });
});

describe("live provider-turn usage (#8144)", () => {
  it("prefers the provider's live report over compaction items", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      maxTokens: 200_000,
      inputTokens: 40_000,
      outputTokens: 2_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(42_000);
    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.remainingTokens).toBe(158_000);
    expect(snapshot?.usedPercentage).toBe(21);
  });

  it("handles a report without a known context window", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.usedPercentage).toBeNull();
  });
});

describe("latestProviderThreadTokenUsage", () => {
  const usage = (usedTokens: number) => ({ usedTokens, updatedAt: "2026-10-09T10:00:00.000Z" });
  it("reads only the active provider thread, so a handoff's fresh session starts clear", () => {
    const turns = [
      { providerThreadId: "fresh", tokenUsage: undefined },
      { providerThreadId: "old", tokenUsage: usage(90_000) },
    ] as never;
    expect(latestProviderThreadTokenUsage(turns, "fresh" as never)).toBeNull();
    expect(latestProviderThreadTokenUsage(turns, "old" as never)?.usedTokens).toBe(90_000);
  });

  it("ignores an earlier session's compaction until the fresh session reports", () => {
    const compaction = {
      item: {
        providerThreadId: "old",
        type: "compaction",
        afterTokenCount: 120_000,
        updatedAt: DateTime.makeUnsafe("2026-10-09T10:00:00.000Z"),
      },
    } as never;
    const row = (id: string) =>
      ({
        id,
        contextUsage: null,
        updatedAt: DateTime.makeUnsafe("2026-10-09T10:00:00.000Z"),
      }) as never;
    expect(deriveLatestContextWindowSnapshot([compaction], null, row("fresh"))).toBeNull();
    expect(deriveLatestContextWindowSnapshot([compaction], null, row("old"))?.usedTokens).toBe(
      120_000,
    );
  });
});
