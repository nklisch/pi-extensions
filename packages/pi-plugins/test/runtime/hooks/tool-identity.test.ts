import { describe, expect, it } from "vitest";
import { createHookToolIdentityResolver } from "../../../src/runtime/hooks/tool-event-input.js";

describe("hook tool identities", () => {
  it("resolves canonical aliases without case folding", () => {
    const resolver = createHookToolIdentityResolver({ additional: [{ preferred: "Agent", piNames: ["agent_tool"], aliases: ["Agent", "agent_tool"], rank: 100 }] });
    expect(resolver.resolve("bash")).toEqual({ piName: "bash", foreignName: "Bash", aliases: ["Bash", "bash"] });
    expect(resolver.resolve("write")).toEqual({ piName: "write", foreignName: "Write", aliases: ["Write", "write", "apply_patch"] });
    expect(resolver.resolve("agent_tool")).toEqual({ piName: "agent_tool", foreignName: "Agent", aliases: ["Agent", "agent_tool"] });
    expect(resolver.resolve("Apply_Patch")).toEqual({ piName: "Apply_Patch", foreignName: "Apply_Patch", aliases: ["Apply_Patch"] });
  });

  it("keeps apply_patch as a mutation alias, not a new Pi built-in", () => {
    const resolver = createHookToolIdentityResolver({ additional: [] });
    expect(resolver.resolve("apply_patch").foreignName).toBe("apply_patch");
    expect(resolver.resolve("edit").aliases).toContain("apply_patch");
  });
});
