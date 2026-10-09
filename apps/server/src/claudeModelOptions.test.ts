import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";

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

  // Claude Code runs ultracode on exactly the models that support xhigh effort.
  it("offers ultracode on every bundled Claude model with xhigh effort", () => {
    const withUltracode = BUNDLED_CLAUDE_MODEL_CATALOG.models.map(({ model }) => {
      const descriptors = model.capabilities?.optionDescriptors ?? [];
      const effort = descriptors.find((descriptor) => descriptor.id === "effort");
      const xhigh =
        effort?.type === "select" && effort.options.some((option) => option.id === "xhigh");
      const settings = compileClaudeModelSelection(
        selection(model.slug, [{ id: "ultracode", value: true }]),
      ).settings;
      return [model.slug, xhigh, settings.ultracode === true] as const;
    });
    expect(withUltracode.filter(([, xhigh, ultracode]) => xhigh !== ultracode)).toEqual([]);
    expect(withUltracode.filter(([, , ultracode]) => ultracode).map(([slug]) => slug)).toEqual(
      expect.arrayContaining(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]),
    );
  });

  it("compiles the thinking toggle for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-haiku-4-5", [{ id: "thinking", value: false }]))
        .settings,
    ).toEqual({ alwaysThinkingEnabled: false });
  });
});
