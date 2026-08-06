import { describe, expect, it } from "vitest";
import {
  GlobalConfigSchema,
  normalizeConfig,
  ProjectOverlaySchema,
  RepositoryPolicySchema,
  ReviewerConfigSchema,
} from "../../src/config/schema.ts";

describe("tri-state config schemas", () => {
  it("defaults the global mode to ask", () => {
    const result = normalizeConfig(GlobalConfigSchema, { version: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe("ask");
      expect(result.value.reviewer.promptPosture).toBe("reviewer.default");
      expect(result.value.reviewer.contextMode).toBe("recentContext");
      expect(result.value.gatedTools).toEqual([]);
      expect(result.value.reviewer.recentContext.userTurns).toBe(5);
    }
  });

  it("rejects wildcard and Bash gated-tool entries", () => {
    for (const gatedTools of [["*"], ["bash"], ["read tool"]]) {
      expect(
        normalizeConfig(GlobalConfigSchema, { version: 1, gatedTools }).ok,
      ).toBe(false);
    }
    expect(
      normalizeConfig(GlobalConfigSchema, {
        version: 1,
        gatedTools: ["edit", "custom_tool"],
      }).ok,
    ).toBe(true);
  });

  it("rejects removed behavioral keys instead of translating them", () => {
    for (const raw of [
      { version: 1, defaultPosture: "default" },
      { version: 1, maxPosture: "permissive" },
      { version: 1, reviewer: { enabled: false } },
      { version: 1, reviewer: { mode: "model" } },
    ]) {
      expect(normalizeConfig(GlobalConfigSchema, raw).ok).toBe(false);
    }
    expect(
      normalizeConfig(ProjectOverlaySchema, { version: 1, posture: "strict" })
        .ok,
    ).toBe(false);
    expect(
      normalizeConfig(RepositoryPolicySchema, { version: 1, posture: "strict" })
        .ok,
    ).toBe(false);
  });

  it("keeps unknown-tool posture and omits shipped-pack enablement", () => {
    const result = normalizeConfig(GlobalConfigSchema, {
      version: 1,
      mode: "off",
      unknownToolPosture: "review",
    });
    expect(result.ok).toBe(true);
    expect(
      normalizeConfig(GlobalConfigSchema, {
        version: 1,
        packEnablement: { enabledShippedPacks: ["bash.network.read"] },
      }).ok,
    ).toBe(false);
  });

  it("keeps reviewer advanced fields without enabled or reviewer mode", () => {
    const result = normalizeConfig(ReviewerConfigSchema, {
      model: "zai/glm-5.2",
    });
    expect(result.ok).toBe(true);
    expect(normalizeConfig(ReviewerConfigSchema, { enabled: true }).ok).toBe(
      false,
    );
    expect(normalizeConfig(ReviewerConfigSchema, { mode: "model" }).ok).toBe(
      false,
    );
  });
});
