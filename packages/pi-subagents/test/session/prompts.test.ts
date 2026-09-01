import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { EnvInfo } from "#src/session/env";
import { buildAgentPrompt } from "#src/session/prompts";
import type { AgentConfig } from "#src/types";

const registry = new AgentTypeRegistry(() => new Map());
const env: EnvInfo = { isGitRepo: true, branch: "main", platform: "linux" };
const noGit: EnvInfo = { isGitRepo: false, branch: "", platform: "linux" };
const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({ name: "custom", description: "Custom", systemPrompt: "Custom instructions", promptMode: "replace", ...overrides });

describe("buildAgentPrompt", () => {
  it("includes environment context", () => {
    const prompt = buildAgentPrompt(registry.resolveAgentConfig("general-purpose"), "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("linux");
  });

  it("handles a non-git repository", () => {
    expect(buildAgentPrompt(registry.resolveAgentConfig("Explore"), "/workspace", noGit)).toContain("Not a git repository");
  });

  it("uses append mode to retain parent context and bridge instructions", () => {
    const prompt = buildAgentPrompt(registry.resolveAgentConfig("general-purpose"), "/workspace", env, "Parent prompt");
    expect(prompt).toContain("Parent prompt");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).not.toContain("<inherited_system_prompt>");
  });

  it("uses replace mode for custom instructions without the legacy wrapper", () => {
    const prompt = buildAgentPrompt(config(), "/workspace", env, "Parent identity");
    expect(prompt).toContain("Custom instructions");
    expect(prompt).toContain("Parent identity");
    expect(prompt).not.toContain("<sub_agent_context>");
    expect(prompt).not.toContain("You are a pi coding agent sub-agent");
  });

  it("injects the active agent identity in both modes", () => {
    expect(buildAgentPrompt(config({ name: "replace-agent" }), "/workspace", env)).toContain('<active_agent name="replace-agent"/>');
    expect(buildAgentPrompt(config({ name: "append-agent", promptMode: "append", systemPrompt: "" }), "/workspace", env, "Parent")).toContain('<active_agent name="append-agent"/>');
  });

  it("removes a contradictory inherited cwd footer", () => {
    const prompt = buildAgentPrompt(registry.resolveAgentConfig("general-purpose"), "/workspace/worktree", env, "Current working directory: /workspace/main", "/workspace/main");
    expect(prompt).not.toContain("Current working directory: /workspace/main");
    expect(prompt).toContain("Working directory: /workspace/worktree");
  });

  it("preserves ordering of identity, active agent, environment, and instructions", () => {
    const prompt = buildAgentPrompt(config({ name: "ordered" }), "/workspace", env, "IDENTITY");
    expect(prompt.indexOf("IDENTITY")).toBeLessThan(prompt.indexOf('<active_agent name="ordered"/>'));
    expect(prompt.indexOf('<active_agent name="ordered"/>')).toBeLessThan(prompt.indexOf("# Environment"));
    expect(prompt.indexOf("# Environment")).toBeLessThan(prompt.indexOf("Custom instructions"));
  });
});
