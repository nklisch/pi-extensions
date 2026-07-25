import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readAgentSkill, readCodexSkillPresentation } from "../../../src/formats/agent-skills/skill-reader.js";
import { type Provenance } from "../../../src/domain/provenance.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";

const context = {
  plugin: PluginKeySchema.parse("agile-workflow@nklisch-skills"),
  root: "skills/autopilot",
  documentPath: "skills/autopilot/SKILL.md",
  provenance: {
    location: {
      host: "codex" as const,
      documentKind: "skill" as const,
      path: "skills/autopilot/SKILL.md",
      pointer: "",
    },
  },
};

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

const markdown = readFileSync(
  new URL("../../fixtures/plugins/real-nklisch-skills/skills/autopilot/SKILL.md", import.meta.url),
).toString("utf8");
const presentation = readFileSync(
  new URL("../../fixtures/plugins/real-nklisch-skills/skills/autopilot/agents/openai.yaml", import.meta.url),
).toString("utf8");

const presentationProvenance: Provenance = {
  location: {
    host: "codex",
    documentKind: "convention",
    path: "skills/autopilot/agents/openai.yaml",
    pointer: "",
  },
};

describe("Agent Skills reader", () => {
  it("normalizes real folded frontmatter and optional Codex presentation", () => {
    const parsedPresentation = readCodexSkillPresentation(presentation, presentationProvenance);
    expect(parsedPresentation.ok).toBe(true);
    if (!parsedPresentation.ok) return;
    const result = readAgentSkill(markdown, {
      ...context,
      presentation: parsedPresentation.value,
    }, sha256);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      kind: "skill",
      id: expect.stringMatching(/^component-v1:skill:[0-9a-f]{64}$/),
      name: { value: "autopilot" },
      root: { value: "skills/autopilot" },
    });
    expect(result.value.metadata.map((item) => item.key)).toEqual([
      "agent-skills.description",
      "codex.agents.interface",
      "codex.agents.policy",
    ]);
    expect(result.value).not.toHaveProperty("configured");
    expect(result.value).not.toHaveProperty("compatibility");
  });

  it("requires the indexed SKILL.md path beneath the declared root", () => {
    const result = readAgentSkill("---\nname: demo\ndescription: demo\n---\n", {
      ...context,
      root: "./skills/demo/",
      documentPath: "skills/demo/other.md",
    }, sha256);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
  });

  it("retains known policy metadata without interpreting it", () => {
    const result = readAgentSkill(
      "---\nname: demo\ndescription: demo\nlicense: MIT\ncompatibility: shell\nmetadata:\n  owner: test\nallowed-tools: Bash Read\ndisable-model-invocation: true\nfuture-field: retained\n---\n",
      { ...context, root: "skills/demo", documentPath: "skills/demo/SKILL.md" },
      sha256,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata.map((item) => item.key)).toEqual([
      "agent-skills.allowed-tools",
      "agent-skills.compatibility",
      "agent-skills.description",
      "agent-skills.disable-model-invocation",
      "agent-skills.future-field",
      "agent-skills.license",
      "agent-skills.metadata",
    ]);
  });

  it("rejects malformed required fields and adversarial frontmatter", () => {
    for (const markdownValue of [
      "---\nname: demo\ndescription: 4\n---\n",
      "---\nname: demo\ndescription: demo\nmetadata:\n  count: 4\n---\n",
      readFileSync(new URL("../../fixtures/plugins/adversarial-skills/anchors.md", import.meta.url)).toString("utf8"),
    ]) {
      const result = readAgentSkill(markdownValue, context, sha256);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("value");
    }
  });
});
