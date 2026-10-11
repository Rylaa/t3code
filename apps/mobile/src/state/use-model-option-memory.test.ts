import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import { modelOptionMemoryAtom } from "./use-composer-drafts";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  rememberModelOptions,
  rememberedModelOptions,
  threadModelPickSelection,
  withRememberedModelOptions,
} from "./use-model-option-memory";

const XHIGH = [{ id: "thinking", value: "xhigh" }] as const;
const HIGH = [{ id: "thinking", value: "high" }] as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(modelOptionMemoryAtom, {});
});

describe("model option memory state", () => {
  it("records and looks up options per instance and model", () => {
    rememberModelOptions("codex", "gpt-5.3-codex", [...XHIGH]);
    rememberModelOptions("codex", "gpt-5.4", [...HIGH]);
    expect(rememberedModelOptions("codex", "gpt-5.3-codex")).toEqual(XHIGH);
    expect(rememberedModelOptions("codex", "gpt-5.4")).toEqual(HIGH);
    expect(rememberedModelOptions("pi", "gpt-5.3-codex")).toBeUndefined();
  });

  it("ignores empty option sets when recording", () => {
    rememberModelOptions("codex", "gpt-5.4", []);
    expect(rememberedModelOptions("codex", "gpt-5.4")).toBeUndefined();
  });

  it("never remembers Claude in Chrome for another thread", () => {
    rememberModelOptions("claudeAgent", "claude-opus-4-6", [
      ...HIGH,
      { id: "chrome", value: true },
    ]);
    expect(rememberedModelOptions("claudeAgent", "claude-opus-4-6")).toEqual(HIGH);
  });
});

describe("withRememberedModelOptions", () => {
  it("restores the remembered options over descriptor defaults", () => {
    rememberModelOptions("codex", "gpt-5.3-codex", [...XHIGH]);
    expect(
      withRememberedModelOptions({
        instanceId: "codex",
        model: "gpt-5.3-codex",
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.3-codex", options: XHIGH });
  });

  it("keeps incoming selections that already match memory", () => {
    rememberModelOptions("pi", "xai/grok-4.6", [...XHIGH]);
    const selection = { instanceId: "pi", model: "xai/grok-4.6", options: [...XHIGH] };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });

  it("keeps a pick's own Claude in Chrome when its other options match memory", () => {
    const options = [...HIGH, { id: "chrome", value: true }];
    rememberModelOptions("claudeAgent", "claude-opus-4-6", options);
    const selection = { instanceId: "claudeAgent", model: "claude-opus-4-6", options };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });

  it("keeps incoming selections when nothing is remembered", () => {
    const selection = { instanceId: "pi", model: "openai-codex/gpt-5.6-sol" };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });
});

describe("threadModelPickSelection", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const chrome = { id: "chrome", label: "Claude in Chrome", type: "boolean" } as const;
  const thread = {
    instanceId: claude,
    model: "claude-sonnet-4-6",
    options: [...XHIGH, { id: "chrome", value: true }],
  };
  const pick = (optionDescriptors: ReadonlyArray<typeof chrome>) =>
    threadModelPickSelection(
      {
        selection: { instanceId: claude, model: "claude-opus-4-6" },
        capabilities: { optionDescriptors },
      },
      thread,
    );

  it("restores the picked model's options and keeps the thread's Claude in Chrome", () => {
    rememberModelOptions(claude, "claude-opus-4-6", [...HIGH]);
    expect(pick([chrome])).toEqual({
      instanceId: claude,
      model: "claude-opus-4-6",
      options: [...HIGH, { id: "chrome", value: true }],
    });
  });

  it("drops it for a model without the switch", () => {
    expect(pick([])).toEqual({ instanceId: claude, model: "claude-opus-4-6" });
  });
});
