import type { RawMatcher } from "./condition-guards.ts";

/**
 * Shape-level proof shared by the redirect review gate and the narrow redirect
 * tolerance allow. Path facts are limited to redirect targets so command input
 * paths are still handled by their owning family and stdin remains review-gated.
 */
export const BENIGN_REDIRECT_STRUCTURE: RawMatcher = {
  all: [
    {
      pathScopesAllIn: {
        scopes: ["temp", "project", "writable-project"],
        usages: ["redirect-target"],
        forbidPathSegments: [".git"],
        allowExactPaths: ["/dev/null"],
        requireFacts: "one-or-more",
      },
    },
    { not: { stageSome: { redirect: { stream: "fd" } } } },
    { not: { envAssignmentNameIn: { names: ["TMPDIR"] } } },
  ],
};
