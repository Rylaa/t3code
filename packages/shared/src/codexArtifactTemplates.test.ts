import { describe, expect, it } from "vite-plus/test";

import {
  appendCodexArtifactTemplateUsePrompt,
  resolveCodexArtifactTemplate,
  type CodexArtifactTemplate,
} from "./codexArtifactTemplates.ts";

const HELLO_WORLD_TEMPLATE: CodexArtifactTemplate = {
  artifactKind: "document",
  displayName: "Hello World",
  skillDirectory: "/Users/test/.codex/skills/artifact-template-hello-world",
  skillName: "artifact-template-hello-world",
};

describe("resolveCodexArtifactTemplate", () => {
  it("accepts the template metadata emitted by Codex", () => {
    expect(
      resolveCodexArtifactTemplate({
        artifact_kind: "document",
        display_name: "  Hello World  ",
        skill_directory: "/Users/test/.codex/skills/artifact-template-hello-world",
        skill_name: "artifact-template-hello-world",
      }),
    ).toEqual(HELLO_WORLD_TEMPLATE);
  });
});

describe("appendCodexArtifactTemplateUsePrompt", () => {
  const prompt = "Create a document using this $artifact-template-hello-world about…";

  it("preserves existing draft text", () => {
    expect(appendCodexArtifactTemplateUsePrompt("Write about otters", HELLO_WORLD_TEMPLATE)).toBe(
      `Write about otters ${prompt}`,
    );
  });

  it.each([prompt, `${prompt}\n`, `Notes\n\n${prompt}`])(
    "does not append the same final prompt twice: %s",
    (draft) => {
      expect(appendCodexArtifactTemplateUsePrompt(draft, HELLO_WORLD_TEMPLATE)).toBe(draft);
    },
  );

  it("does not mistake text containing the prompt for a final prompt", () => {
    const draft = `${prompt}\nAdditional instructions`;
    expect(appendCodexArtifactTemplateUsePrompt(draft, HELLO_WORLD_TEMPLATE)).toBe(
      `${draft} ${prompt}`,
    );
  });
});
