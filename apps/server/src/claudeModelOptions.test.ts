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

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("compiles Ultracode independently of effort on models that offer it", () => {
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
    const compile = (model: string, options: NonNullable<ModelSelection["options"]>) =>
      compileClaudeModelSelection(selection(model, options), catalog);

    expect(
      compile("claude-synthetic-workflows", [
        { id: "effort", value: "low" },
        { id: "ultracode", value: true },
      ]),
    ).toMatchObject({ effort: "low", settings: { ultracode: true } });
    expect(
      compile("claude-synthetic-workflows", [{ id: "ultracode", value: false }]).settings,
    ).toEqual({});
    expect(
      compile("claude-without-workflows", [{ id: "ultracode", value: true }]).settings,
    ).toEqual({});
  });

  it("keeps explicit effort for models missing from the local catalog", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-pool-model-not-in-catalog", [{ id: "effort", value: "max" }]),
      ).effort,
    ).toBe("max");
    expect(
      compileClaudeModelSelection(selection("claude-pool-model-not-in-catalog", [])).effort,
    ).toBeUndefined();
  });
});
