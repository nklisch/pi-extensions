import type { EffectCondition } from "../parse/native-effects.ts";

/** JSON-shaped matcher accepted by the policy DSL. */
export type RawMatcher = Record<string, unknown>;

/**
 * Translate registry read-only conditions into allow-rule guards.
 *
 * The registry classifies an individual stage; direct read packs classify the
 * same command shape with inspectable matchers. Keeping this translation pure
 * and data-only makes the registry condition the source of truth while still
 * leaving named review rules responsible for human-readable explanations.
 */
export function conditionGuardClauses(
  condition: EffectCondition | undefined,
): readonly RawMatcher[] {
  if (condition === undefined) {
    return [];
  }

  const clauses: RawMatcher[] = [];
  const forbidden: Record<string, unknown> = {};

  if (condition.forbidAnyFlag !== undefined) {
    forbidden.names = [...condition.forbidAnyFlag];
  }
  if (condition.forbidFlagNamePrefixes !== undefined) {
    forbidden.prefixes = [...condition.forbidFlagNamePrefixes];
  }
  if (condition.forbidShortFlagChars !== undefined) {
    forbidden.shortChars = [...condition.forbidShortFlagChars];
  }
  if (Object.keys(forbidden).length > 0) {
    clauses.push({ not: { flagMatches: forbidden } });
  }

  if (condition.forbidArgumentFlags !== undefined) {
    const escaped = condition.forbidArgumentFlags.map((literal) =>
      literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    clauses.push({
      not: { anyArgMatches: `^(?:${escaped.join("|")})$` },
    });
  }

  if (condition.requireAnyFlag !== undefined) {
    const required = condition.requireAnyFlag.map((name) => ({
      flagPresent: name,
    }));
    clauses.push(
      required.length === 1 ? (required[0] as RawMatcher) : { any: required },
    );
  }

  return clauses;
}
