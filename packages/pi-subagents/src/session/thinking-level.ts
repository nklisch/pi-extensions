import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "#src/types";

/** Pi's default when no session setting is available. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * Resolve the level Pi will use for a model before its AgentSession exists.
 *
 * The session factory passes this resolved value to Pi, while the Subagent
 * record replaces it with AgentSession.thinkingLevel after construction. That
 * two-step flow keeps queued/launch status useful without allowing a local
 * approximation to outrank the SDK's authoritative value.
 */
export function resolveEffectiveThinkingLevel(
  model: unknown,
  requested?: ThinkingLevel,
  inherited?: ThinkingLevel,
): ThinkingLevel {
  const level = requested ?? inherited ?? DEFAULT_THINKING_LEVEL;
  // With no model yet, preserve the level Pi would receive rather than forcing
  // `off`: createAgentSession may still resolve a configured default model.
  // The created child session remains authoritative and supplies the clamp.
  if (model == null) return level;
  if (!isThinkingModel(model)) return "off";

  const supported = getSupportedThinkingLevels(model);
  return supported.includes(level)
    ? level
    : clampThinkingLevel(model, level);
}

function isThinkingModel(value: unknown): value is Model<any> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { provider?: unknown; id?: unknown; reasoning?: unknown };
  return typeof candidate.provider === "string"
    && candidate.provider.length > 0
    && typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.reasoning === "boolean";
}
