import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

const effort: ProviderOptionDescriptor = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ],
  currentValue: "low",
};

const ultracode = (currentValue: boolean): ProviderOptionDescriptor => ({
  id: "ultracode",
  label: "Ultracode",
  type: "boolean",
  currentValue,
});

const display = (descriptors: ReadonlyArray<ProviderOptionDescriptor>) =>
  buildTraitsTriggerDisplay({
    provider: ProviderDriverKind.make("claudeAgent"),
    descriptors,
    primarySelectDescriptorId: "effort",
    ultrathinkPromptControlled: false,
  });

describe("buildTraitsTriggerDisplay", () => {
  it("names Ultracode beside any effort only while it is on", () => {
    expect(display([effort, ultracode(true)])).toEqual({ label: "Low · Ultracode" });
    expect(display([effort, ultracode(false)])).toEqual({ label: "Low" });
  });
});
