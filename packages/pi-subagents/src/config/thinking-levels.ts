/** Host-supported thinking levels advertised by every pi-subagents surface. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const THINKING_LEVELS_DESCRIPTION = THINKING_LEVELS.join(", ");
