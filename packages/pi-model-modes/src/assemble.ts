import type { ModePlan } from "./resolver.js";

/**
 * Splice the effective system prompt in the SPEC's fixed order:
 *
 *   [identity line]
 *   [writing style]                                         // optional
 *   [base overlay] [agency] [quality] [scope] [modifiers]   // = plan.fragments, in order
 *   [pi's baseSystemPrompt]
 *
 * Pure: consumes `plan.fragments` exactly as `mode-resolver` materialized them
 * (no re-load, no re-order — so the assembled bytes match what `plan.signature`
 * was hashed from). Clean-base: the trailing base is sourced from the
 * `baseSystemPrompt` argument, never from any cached previous output. Ordered-
 * array only; no dynamic text. Parts are joined by a blank line; empty parts
 * (e.g. an empty identity when there is no model) are dropped so there are no
 * stray blank lines.
 *
 * Design: `.work/active/features/epic-mode-composition-deterministic-splice.md`.
 *
 * @param identity         the identity line ("" when there is no model)
 * @param plan             the materialized ModePlan (its fragments are pre-ordered)
 * @param baseSystemPrompt pi's assembled `e.systemPrompt` for the turn
 */
export function assembleSystemPrompt(
  identity: string,
  plan: ModePlan,
  baseSystemPrompt: string,
  styleFragment?: string,
): string {
  const parts: string[] = [];
  if (identity.length > 0) parts.push(identity);
  if (styleFragment !== undefined && styleFragment.length > 0) parts.push(styleFragment);
  for (const fragment of plan.fragments) {
    // Drop empty fragment content too (a whitespace-only fragment file trims to
    // "" in the loader) — consistent with identity/base, so no stray blank lines.
    if (fragment.content.length > 0) parts.push(fragment.content);
  }
  if (baseSystemPrompt.length > 0) parts.push(baseSystemPrompt);
  return parts.join("\n\n");
}
