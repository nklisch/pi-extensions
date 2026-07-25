/**
 * Config-derived scope-behavior pack.
 *
 * Generated from the resolved `projectScope` at composition time so user-owned
 * scope config has real decision teeth:
 *
 * - Configured denied directories deny (they used to fall through to review).
 * - `unknownPathBehavior` is a ceiling: `"review"` still emits a review rule
 *   so a user/package allow can never auto-clear an unresolvable path;
 *   `"deny"` hard-blocks.
 * - `sensitivePathBehavior` is the same ceiling for engine-classified
 *   sensitive home paths (credentials, keys, auth files).
 * - `homePathBehavior: "review"` adds a review rule over home scopes that
 *   outranks baseline home read allows (rank: deny > review > allow), which
 *   is what makes the project-only preset actually project-only.
 *
 * The pack is derived, never stored: changing scope config and re-resolving
 * policy produces a different pack. Rules carry `generated` provenance
 * because they exist only as a projection of user-owned config.
 *
 * Known limitation: scope classification puts writable-project/project ahead
 * of sensitive-home, so a sensitive location explicitly made a project root
 * classifies as project and the sensitive ceiling does not fire there.
 */

import type { ResolvedProjectScope } from "../config/loader.ts";
import {
  type CompileError,
  compilePack,
  type PolicyPack,
} from "./core.ts";

export const SCOPE_BEHAVIOR_PACK_ID = "config.scope.behavior";

export type ScopeBehaviorPackResult =
  | { readonly ok: true; readonly pack: PolicyPack | null }
  | { readonly ok: false; readonly errors: readonly CompileError[] };

export function buildScopeBehaviorPack(
  scope: ResolvedProjectScope,
): ScopeBehaviorPackResult {
  const rules: Record<string, unknown>[] = [];

  if (scope.deniedDirectories.length > 0) {
    rules.push({
      id: `${SCOPE_BEHAVIOR_PACK_ID}:deny-configured-denied-paths`,
      effect: "deny",
      match: { pathScopesSomeIn: { scopes: ["denied"] } },
      reason:
        "path is inside a configured denied directory (projectScope.deniedDirectories)",
      provenance: { source: "generated" },
    });
  }

  // Unknown and sensitive-home behaviors are ceilings, not just deny knobs:
  // even the "review" value emits a rule so no allow can auto-clear them.
  rules.push({
    id: `${SCOPE_BEHAVIOR_PACK_ID}:${scope.unknownPathBehavior}-unknown-paths`,
    effect: scope.unknownPathBehavior,
    match: { pathScopesSomeIn: { scopes: ["unknown"] } },
    reason:
      scope.unknownPathBehavior === "deny"
        ? "path could not be resolved and projectScope.unknownPathBehavior is deny"
        : "path could not be resolved; unknown paths never auto-clear (projectScope.unknownPathBehavior)",
    provenance: { source: "generated" },
  });

  rules.push({
    id: `${SCOPE_BEHAVIOR_PACK_ID}:${scope.sensitivePathBehavior}-sensitive-home`,
    effect: scope.sensitivePathBehavior,
    match: { pathScopesSomeIn: { scopes: ["sensitive-home"] } },
    reason:
      scope.sensitivePathBehavior === "deny"
        ? "sensitive home path (credentials, keys, auth files) denied by projectScope.sensitivePathBehavior"
        : "sensitive home path (credentials, keys, auth files) never auto-clears (projectScope.sensitivePathBehavior)",
    provenance: { source: "generated" },
  });

  if (scope.homePathBehavior === "review") {
    rules.push({
      id: `${SCOPE_BEHAVIOR_PACK_ID}:review-home-paths`,
      effect: "review",
      match: {
        pathScopesSomeIn: { scopes: ["home", "safe-home", "agent-support"] },
      },
      reason:
        "project-only scope: paths outside the project require review (projectScope.homePathBehavior)",
      provenance: { source: "generated" },
    });
  }

  if (rules.length === 0) return { ok: true, pack: null };

  const compiled = compilePack({
    version: 1,
    id: SCOPE_BEHAVIOR_PACK_ID,
    rules,
  });
  if (compiled.pack === null) {
    // Return the failure: the composer folds it into the floor-only
    // fail-closed result rather than silently dropping the user's intent.
    return { ok: false, errors: compiled.errors };
  }
  return { ok: true, pack: compiled.pack };
}
