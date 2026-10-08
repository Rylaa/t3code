import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";
import type { ClaudeModelCatalog } from "./provider/ClaudeModelCatalog.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-opus-4-6[1m]",
      effort: "max",
      settings: { fastMode: true },
    });
  });

  it("compiles fast mode only for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: true }]))
        .settings,
    ).toEqual({ fastMode: true });
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: false }]))
        .settings,
    ).toEqual({ fastMode: false });
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("compiles ultracode independently of effort for models that expose it", () => {
    const catalog: ClaudeModelCatalog = {
      models: [
        {
          model: {
            slug: "claude-synthetic-workflows",
            name: "Synthetic Workflows",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Reasoning",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High", isDefault: true },
                  ],
                },
                { id: "ultracode", label: "Ultracode", type: "boolean" },
              ],
            },
          },
          runtime: {},
          compatibility: {},
        },
      ],
    };
    expect(
      compileClaudeModelSelection(
        selection("claude-synthetic-workflows", [
          { id: "effort", value: "low" },
          { id: "ultracode", value: true },
        ]),
        catalog,
      ),
    ).toMatchObject({ effort: "low", settings: { ultracode: true } });
    expect(
      compileClaudeModelSelection(
        selection("claude-synthetic-workflows", [{ id: "ultracode", value: false }]),
        catalog,
      ).settings,
    ).toEqual({});
    expect(
      compileClaudeModelSelection(selection("claude-haiku-4-5", [{ id: "ultracode", value: true }]))
        .settings,
    ).toEqual({});
  });

  it("compiles the thinking toggle for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-haiku-4-5", [{ id: "thinking", value: false }]))
        .settings,
    ).toEqual({ alwaysThinkingEnabled: false });
  });
});
