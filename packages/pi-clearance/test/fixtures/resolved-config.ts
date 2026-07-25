import type {
  ResolvedConfig,
  ResolvedPackEnablement,
  ResolvedProjectScope,
  ResolvedReviewerConfig,
} from "../../src/config/loader.ts";

export function defaultResolvedProjectScope(): ResolvedProjectScope {
  return {
    roots: [],
    writableDirectories: [],
    tempDirectories: [],
    deniedDirectories: [],
    safeHomeDirectories: [],
    unknownPathBehavior: "review",
  sensitivePathBehavior: "review",
  homePathBehavior: "allow",
  };
}

export function defaultResolvedDisplay(): ResolvedConfig["display"] {
  return {
    reviewNote: { mode: "reason+accent", showModelLabel: false, accent: true },
  };
}

export function defaultResolvedReviewer(): ResolvedReviewerConfig {
  return {
    promptPosture: "reviewer.default",
    promptAppends: [],
    projectPromptAppends: [],
    promptOverride: null,
    model: null,
    tokenBudget: { window: "24h", limit: null },
    contextMode: "recentContext",
    recentContext: {
      decisionLimit: 25,
      decisionWindow: "2h",
      conversationTurns: 3,
      conversationCharLimit: 6000,
    },
    escalation: { enabled: true, denialLimit: 3, window: "10m" },
  };
}

export function defaultResolvedPackEnablement(): ResolvedPackEnablement {
  return {
    global: emptyPackEnablementScope(),
    project: emptyPackEnablementScope(),
    effectivePackagePackIds: [],
    disabledConfigPackIds: [],
  };
}

function emptyPackEnablementScope() {
  return {
    enabledPackagePacks: [],
    disabledPackagePacks: [],
    disabledConfigPacks: [],
  };
}
