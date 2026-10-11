import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { describe, expect, it } from "vite-plus/test";

import { ForwardCompatibleArray } from "./baseSchemas.ts";
import { UsageLimitSourceSnapshot, UsageLimitSourceSnapshots } from "./providerUsageLimits.ts";

const decodeSnapshots = Schema.decodeUnknownSync(UsageLimitSourceSnapshots);
const decodeOnPreviousSchema = Schema.decodeUnknownSync(
  ForwardCompatibleArray(UsageLimitSourceSnapshot.mapFields(Struct.omit(["autoSwitch"]))),
);

const previous = {
  id: "claude-swap",
  kind: "claudeSwap",
  label: "claude-swap",
  checkedAt: "2026-10-08T12:00:00.000Z",
  accounts: [],
};
const current = {
  ...previous,
  autoSwitch: {
    at: "2026-10-08T12:01:00.000Z",
    outcome: "switched",
    fromAccountId: "1",
    toAccountId: "2",
    usedPercent: 91,
    window: "session",
  },
};

// Remote environments run other versions, so the automatic switch status must
// cross in both directions without costing the claude-swap snapshot.
describe("UsageLimitSourceSnapshot automatic switch status", () => {
  it("reaches a client on the previous schema as a snapshot without it", () => {
    expect(decodeOnPreviousSchema([current])).toEqual([previous]);
  });

  it("reads a snapshot from a server on the previous schema", () => {
    expect(decodeSnapshots([previous])).toEqual([previous]);
    expect(decodeSnapshots([current])).toEqual([current]);
  });
});
