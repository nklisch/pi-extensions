import { describe, expect, it } from "vitest";

import { buildSettingsReadModel } from "../../../../src/runtime/config-commands/settings/read-model.ts";
import type { AutoReviewerStatusView } from "../../../../src/runtime/auto-reviewer-read-models.ts";

describe("settings read model", () => {
  it("exposes exact gated-tool names and active add choices", () => {
    const status = {
      mode: "ask",
      gatedTools: ["edit"],
      customizations: ["gated tools (1)"],
      reviewer: {
        promptPosture: "reviewer.default",
        configuredModel: null,
        resolvedModel: null,
        resolvedModelSource: "none",
        modelHighCost: false,
        contextMode: "recentContext",
        path: "human",
        consequence: "Pi UI",
      },
      project: { trusted: true, cwd: "/repo" },
      packs: { total: 0, enabled: 0 },
      ratchet: { active: false, previousActiveTools: [], ratchetToolNames: [] },
      warnings: [],
    } as unknown as AutoReviewerStatusView;

    const model = buildSettingsReadModel({
      status,
      projectScope: {
        roots: [],
        writableDirectories: [],
        tempDirectories: [],
        deniedDirectories: [],
        safeHomeDirectories: [],
        unknownPathBehavior: "review",
        sensitivePathBehavior: "review",
        homePathBehavior: "allow",
      },
      gatedTools: {
        names: ["edit"],
        activeToolNames: ["edit", "read"],
        allToolNames: ["edit", "read", "future"],
        addableToolNames: ["read"],
      },
    });

    expect(model.gatedTools.names).toEqual(["edit"]);
    expect(model.gatedTools.addableToolNames).toEqual(["read"]);
    expect(model.status.customizations).toContain("gated tools (1)");
  });
});
