import { describe, expect, it } from "vitest";
import { planModeCommandChange } from "../../src/config/config-command-plans.ts";
import type { ResolvedConfig } from "../../src/config/loader.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
} from "../fixtures/resolved-config.ts";

function config(): ResolvedConfig {
  const reviewer = {
    promptPosture: "reviewer.default",
    promptAppends: [],
    projectPromptAppends: [],
    promptOverride: null,
    model: null,
    tokenBudget: { window: "24h", limit: null },
    contextMode: "recentContext" as const,
    recentContext: {
      decisionLimit: 25,
      decisionWindow: "2h",
      conversationTurns: 3,
      conversationCharLimit: 6000,
    },
    escalation: { enabled: true, denialLimit: 3, window: "10m" },
  };
  return {
    version: 1,
    cwd: "/tmp/project",
    mode: "ask",
    unknownToolPosture: "review",
    projectScope: defaultResolvedProjectScope(),
    packEnablement: defaultResolvedPackEnablement(),
    globalPacks: [],
    projectPacks: [],
    repoPacks: [],
    trustedProject: {
      trusted: false,
    },
    reviewer,
    display: defaultResolvedDisplay(),
    errors: [],
    warnings: [],
    sourceSnapshots: {
      paths: {
        userConfigRoot: "/tmp/config",
        globalConfigFile: "/tmp/config/global.json",
        projectDir: "/tmp/config/project",
        projectOverlayFile: "/tmp/config/project/overlay.json",
        repoPolicyFile: "/tmp/project/.pi-auto-approve/policy.json",
        projectKey: "project-key",
      },
      global: {
        version: 1,
        mode: "ask",
        packs: [],
        packEnablement: {},
        reviewer: {},
        display: {},
      } as never,
      project: {
        version: 1,
        packs: [],
        packEnablement: {},
        projectScope: {},
        promptAppends: [],
      } as never,
      repository: {
        version: 1,
        packs: [],
        promptAppends: [],
      } as never,
    },
  };
}

describe("mode config command plan", () => {
  it("writes only global mode", () => {
    const result = planModeCommandChange({
      mode: "auto",
      resolvedConfig: config(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.target.kind).toBe("global");
      expect(result.plan.patch).toEqual(
        expect.arrayContaining([
          { op: "replace", path: "/mode", before: "ask", value: "auto" },
        ]),
      );
    }
  });
});
