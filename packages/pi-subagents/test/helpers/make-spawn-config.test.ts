import { describe, expect, it } from "vitest";
import { createResolvedSpawnConfig } from "#test/helpers/make-spawn-config";

describe("createResolvedSpawnConfig", () => {
  it("produces a detached-shaped config by default", () => {
    const config = createResolvedSpawnConfig();
    expect(config.execution.mode).toBe("detached");
    expect(config.execution.agentInvocation.mode).toBe("detached");
    expect(config.presentation.detailBase.tags).toEqual(["mode: detached"]);
  });

  it("applies scalar identity and execution overrides", () => {
    const config = createResolvedSpawnConfig({ subagentType: "Explore", displayName: "Explore", prompt: "inspect", description: "search", model: "anthropic/haiku", mode: "joined" });
    expect(config.identity).toMatchObject({ subagentType: "Explore", displayName: "Explore" });
    expect(config.execution).toMatchObject({ prompt: "inspect", description: "search", mode: "joined" });
    expect(config.presentation.modelName).toBe("anthropic/haiku");
  });

  it("keeps raw type and fallback metadata independent", () => {
    const config = createResolvedSpawnConfig({ fellBack: true, rawType: "unknown" });
    expect(config.identity).toMatchObject({ fellBack: true, rawType: "unknown", subagentType: "general-purpose" });
  });
});
