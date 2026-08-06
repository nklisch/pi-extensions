import { describe, expect, it } from "vitest";

import { serializeSparseConfig } from "../../src/config/persistence.ts";
import {
  GlobalConfigSchema,
  normalizeConfig,
  ProjectOverlaySchema,
} from "../../src/config/schema.ts";

function normalizedGlobal(raw: unknown) {
  const result = normalizeConfig(GlobalConfigSchema, raw);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.value;
}

function normalizedProject(raw: unknown) {
  const result = normalizeConfig(ProjectOverlaySchema, raw);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }
  return result.value;
}

describe("sparse config serialization", () => {
  it("recursively removes defaults while preserving nested choices, arrays, and policy packs", () => {
    const config = normalizedGlobal({
      version: 1,
      mode: "auto",
      gatedTools: ["pi.read"],
      packs: [
        {
          version: 1,
          id: "user.policy",
          rules: [
            {
              id: "allow-node",
              effect: "allow",
              match: { program: "node" },
              reason: "fixture policy",
            },
          ],
        },
      ],
      reviewer: {
        promptAppends: [],
        promptOverride: null,
        tokenBudget: { limit: 4096 },
        recentContext: { conversationTurns: 8 },
      },
      display: { reviewNote: { accent: false } },
    });

    expect(serializeSparseConfig("global", config)).toEqual({
      version: 1,
      display: { reviewNote: { accent: false } },
      gatedTools: ["pi.read"],
      mode: "auto",
      packs: [
        {
          version: 1,
          id: "user.policy",
          rules: [
            {
              id: "allow-node",
              effect: "allow",
              match: { program: "node" },
              reason: "fixture policy",
              provenance: { source: "user-global" },
            },
          ],
        },
      ],
      reviewer: {
        recentContext: { conversationTurns: 8 },
        tokenBudget: { limit: 4096 },
      },
    });
  });

  it("keeps non-default project descendants and omits empty default scaffolding", () => {
    const config = normalizedProject({
      version: 1,
      projectScope: {
        roots: ["packages"],
        safeHomeUseDefaults: false,
        agentSupportDirectories: [],
      },
      promptAppends: ["Prefer the project test command."],
    });

    expect(serializeSparseConfig("project", config)).toEqual({
      version: 1,
      projectScope: {
        roots: ["packages"],
        safeHomeUseDefaults: false,
      },
      promptAppends: ["Prefer the project test command."],
    });
  });

  it("serializes a fully default config as only its version", () => {
    expect(
      serializeSparseConfig("global", normalizedGlobal({ version: 1 })),
    ).toEqual({
      version: 1,
    });
    expect(
      serializeSparseConfig("project", normalizedProject({ version: 1 })),
    ).toEqual({
      version: 1,
    });
  });
});
