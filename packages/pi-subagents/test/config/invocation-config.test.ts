import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "#src/config/invocation-config";
import type { AgentConfig } from "#src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    systemPrompt: "Test agent",
    promptMode: "replace",
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers agent config over tool-call params", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({
      model: "provider/config-model",
      thinking: "high",
      maxTurns: 42,
      inheritContext: false,
      mode: "joined",
      timeoutSeconds: 9,
    }), {
      model: "provider/param-model",
      thinking: "minimal",
      max_turns: 1,
      inherit_context: true,
      mode: "detached",
      timeout_seconds: 2,
    });

    expect(resolved).toMatchObject({
      modelInput: "provider/config-model",
      modelFromParams: false,
      thinking: "high",
      maxTurns: 42,
      inheritContext: false,
      mode: "joined",
      timeoutSeconds: 9,
    });
  });

  it("uses tool-call params and defaults detached mode", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model",
      thinking: "minimal",
      max_turns: 3,
      inherit_context: true,
      timeout_seconds: 4,
    });
    expect(resolved).toMatchObject({
      modelInput: "provider/param-model",
      modelFromParams: true,
      thinking: "minimal",
      maxTurns: 3,
      inheritContext: true,
      mode: "detached",
      timeoutSeconds: 4,
    });
  });

  it("lets the parent choose unset fields", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig(), {
      inherit_context: true,
      mode: "joined",
    });
    expect(resolved.inheritContext).toBe(true);
    expect(resolved.mode).toBe("joined");
  });

  it("uses explicit false and validates no legacy delivery field", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ inheritContext: false, mode: "detached" }), {});
    expect(resolved.inheritContext).toBe(false);
    expect(resolved.mode).toBe("detached");
  });
});
