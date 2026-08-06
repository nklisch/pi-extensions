import type { AgentTypeRegistry } from "#src/config/agent-types";

export interface AgentTypeResolution {
  type: string;
  requestedType: string;
  fellBack: boolean;
}

export type AgentTypeResolutionResult = AgentTypeResolution | { error: string };

/**
 * Resolve caller-supplied agent identity once, before prompt/model/tool policy.
 * Unknown names follow the configured fallback; disabled or ambiguous names do
 * not silently acquire another agent's identity.
 */
export function resolveDispatchAgentType(
  requestedType: string,
  registry: AgentTypeRegistry,
  fallback: string | false | undefined,
): AgentTypeResolutionResult {
  const resolved = registry.resolveType(requestedType);
  if (resolved) {
    if (!registry.isValidType(resolved)) return { error: `Agent type "${resolved}" is disabled` };
    return { type: resolved, requestedType, fellBack: false };
  }

  if (registry.isCaseAmbiguous(requestedType)) {
    return { error: `Agent type "${requestedType}" is ambiguous. Use exact casing.` };
  }

  if (fallback === false) {
    return {
      error: `Unknown agent type "${requestedType}". Available types: ${registry.getAvailableTypes().join(", ")}`,
    };
  }

  const fallbackName = fallback ?? "general-purpose";
  const resolvedFallback = registry.resolveType(fallbackName);
  if (!resolvedFallback || !registry.isValidType(resolvedFallback)) {
    return { error: `Configured fallback agent "${fallbackName}" is unknown or disabled` };
  }
  return { type: resolvedFallback, requestedType, fellBack: true };
}
