/**
 * User-visible defaults shared by schema normalization and status/read models.
 * Keeping these values in one module prevents a new schema default from being
 * mistaken for a customization by diagnostics.
 */
export const DEFAULT_REVIEWER_PROMPT_POSTURE = "reviewer.default" as const;
export const DEFAULT_REVIEWER_CONTEXT_MODE = "recentContext" as const;

export const DEFAULT_REVIEWER_TOKEN_BUDGET = {
  window: "24h",
  limit: null,
} as const;

export const DEFAULT_REVIEWER_RECENT_CONTEXT = {
  decisionLimit: 25,
  decisionWindow: "2h",
  conversationTurns: 3,
  userTurns: 5,
  conversationCharLimit: 6000,
} as const;

export const DEFAULT_REVIEWER_ESCALATION = {
  enabled: true,
  denialLimit: 3,
  window: "10m",
} as const;

export const DEFAULT_UNKNOWN_TOOL_POSTURE = "allow" as const;

export const DEFAULT_PROJECT_SCOPE_BEHAVIOR = {
  safeHomeUseDefaults: true,
  agentSupportUseDefaults: true,
  unknownPathBehavior: "review",
  sensitivePathBehavior: "review",
  homePathBehavior: "allow",
} as const;

export const DEFAULT_REVIEW_NOTE_DISPLAY = {
  mode: "reason+accent",
  showModelLabel: false,
  accent: true,
} as const;
