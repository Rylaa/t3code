import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
  ultracodeNote,
  withUltracodeOption,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "T3 Code interaction mode: Default");
    assert.include(injected, "T3 Code collaborative browser");
    assert.include(injected, "T3 Code orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "T3 Code interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "T3 Code interaction mode: Default");
    assert.notInclude(withoutMcp, "T3 Code collaborative browser");
    assert.notInclude(withoutMcp, "T3 Code orchestration");
  });
});

describe("T3 Ultracode", () => {
  const effort: ProviderOptionDescriptor = {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [{ id: "high", label: "High" }],
    currentValue: "high",
  };
  const provider = (
    driver: string,
    optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>,
  ): ServerProvider => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-10T00:00:00.000Z",
    models: [
      {
        slug: `${driver}-model`,
        name: "Model",
        isCustom: false,
        capabilities: optionDescriptors === undefined ? null : { optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  });
  const optionIds = (decorated: ServerProvider) =>
    decorated.models[0]?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id);

  it("offers the switch on every non-Claude, non-Cursor model, after its own options", () => {
    const [codex, pi] = withUltracodeOption([provider("codex", [effort]), provider("pi")]);
    assert.deepEqual(optionIds(codex!), ["reasoningEffort", "ultracode"]);
    assert.deepEqual(codex!.models[0]?.capabilities?.optionDescriptors?.[0], effort);
    assert.deepEqual(optionIds(pi!), ["ultracode"]);
    const ultracode = pi!.models[0]?.capabilities?.optionDescriptors?.[0];
    assert.equal(ultracode?.type, "boolean");
    assert.notProperty(ultracode, "currentValue");
  });

  it("leaves Claude and Cursor alone and never duplicates the switch", () => {
    const claude = provider("claudeAgent", [effort]);
    const cursor = provider("cursor", [effort]);
    const own = provider("muse", [{ id: "ultracode", label: "Own", type: "boolean" }]);
    const [decoratedClaude, decoratedCursor, decoratedOwn] = withUltracodeOption([
      claude,
      cursor,
      own,
    ]);
    assert.deepEqual(decoratedClaude, claude);
    assert.deepEqual(decoratedCursor, cursor);
    assert.deepEqual(decoratedOwn, own);
  });

  it("points Muse at its native workflow tool and other providers at T3's runner", () => {
    const muse = ultracodeNote("muse");
    assert.include(muse, "For this message");
    assert.include(muse, "native `workflow` tool");
    assert.notInclude(muse, "workflow_run");
    for (const driver of ["codex", "opencode", "pi", "grok"]) {
      const note = ultracodeNote(driver);
      assert.include(note, "For this message");
      assert.include(note, "`workflow_run`");
      assert.include(note, "`workflow_wait`");
      assert.include(note, "do not end your turn while a workflow is running");
      // An external OpenCode server gets no t3-code tools.
      assert.include(note, "is not available in this session, do the work directly");
    }
  });
});
