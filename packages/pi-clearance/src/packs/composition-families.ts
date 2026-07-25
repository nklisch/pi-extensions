import { EFFECT_REGISTRY } from "../parse/native-effects.ts";
import { BASH_DEV_VERIFY_STAGE_FAMILY_MATCHERS } from "./bash.dev.verify.ts";
import { BASH_INSPECT_STAGE_FAMILY_MATCHERS } from "./bash.inspect.core.ts";
import { BASH_NETWORK_READ_STAGE_FAMILY_MATCHERS } from "./bash.network.read.ts";
import { BASH_PACKAGES_PNPM_READ_INFO_FAMILY } from "./bash.packages.common.ts";
import { BASH_SEARCH_STAGE_FAMILY_MATCHERS } from "./bash.search.read.ts";
import { BASH_SHELL_BUILTINS_STAGE_FAMILY_MATCHERS } from "./bash.shell.builtins.ts";
import { BASH_SYSTEM_READ_STAGE_FAMILY_MATCHERS } from "./bash.system.read.ts";
import { BASH_VCS_STAGE_FAMILY_MATCHERS } from "./bash.vcs.read.ts";
import { conditionGuardClauses, type RawMatcher } from "./condition-guards.ts";

// Keep these no-op/read clauses here rather than importing structure.safe: the
// structure pack consumes this module to build its derived rule, so importing
// it back would create a cycle. They remain shared data, not a second matcher
// implementation.
const sedPrintFamily: RawMatcher = {
  all: [
    { program: "sed" },
    { flagPresent: "n" },
    { noSubstitution: true },
    { noStdoutRedirect: true },
    ...conditionGuardClauses(
      EFFECT_REGISTRY.find((entry) => entry.program === "sed")?.condition,
    ),
  ],
};

const trueNoopFamily: RawMatcher = {
  all: [
    { program: "true" },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const colonNoopFamily: RawMatcher = {
  all: [{ program: ":" }, { noSubstitution: true }, { noStdoutRedirect: true }],
};

/** Structure-owned families retained as shared data for standalone rules. */
export const BASH_STRUCTURE_SED_PRINT_FAMILY = sedPrintFamily;
export const BASH_STRUCTURE_TRUE_NOOP_FAMILY = trueNoopFamily;
export const BASH_STRUCTURE_COLON_NOOP_FAMILY = colonNoopFamily;

/**
 * The complete v1 stage-family table. Importing the owning pack modules here
 * keeps family membership equivalent to their standalone allow surface and
 * makes additions explicit during refactors.
 */
export const BASH_STAGE_COMPOSITION_FAMILIES: readonly RawMatcher[] = [
  ...BASH_INSPECT_STAGE_FAMILY_MATCHERS,
  ...BASH_SHELL_BUILTINS_STAGE_FAMILY_MATCHERS,
  ...BASH_SYSTEM_READ_STAGE_FAMILY_MATCHERS,
  ...BASH_SEARCH_STAGE_FAMILY_MATCHERS,
  ...BASH_VCS_STAGE_FAMILY_MATCHERS,
  ...BASH_DEV_VERIFY_STAGE_FAMILY_MATCHERS,
  ...BASH_NETWORK_READ_STAGE_FAMILY_MATCHERS,
  BASH_PACKAGES_PNPM_READ_INFO_FAMILY,
  BASH_STRUCTURE_SED_PRINT_FAMILY,
  BASH_STRUCTURE_TRUE_NOOP_FAMILY,
  BASH_STRUCTURE_COLON_NOOP_FAMILY,
];

/**
 * Redirect-tolerant families are structurally the standalone allow table with
 * only each family's `noStdoutRedirect` clause removed. Network families are
 * intentionally excluded: a shell output redirect is equivalent to curl/wget
 * output-to-file behavior and remains review-gated in v1.
 */
export const BASH_STAGE_REDIRECT_TOLERANT_FAMILIES: readonly RawMatcher[] =
  BASH_STAGE_COMPOSITION_FAMILIES.filter(
    (family) => !BASH_NETWORK_READ_STAGE_FAMILY_MATCHERS.includes(family),
  ).map(stripNoStdoutRedirect);

function stripNoStdoutRedirect(matcher: RawMatcher): RawMatcher {
  if (Array.isArray(matcher.all)) {
    const children = matcher.all.filter(
      (child) => !isNoStdoutRedirectMatcher(child),
    );
    return children.length === matcher.all.length
      ? matcher
      : { ...matcher, all: children };
  }
  if (Array.isArray(matcher.any)) {
    return {
      ...matcher,
      any: matcher.any.map((child) => stripNoStdoutRedirect(child)),
    };
  }
  return matcher;
}

function isNoStdoutRedirectMatcher(value: unknown): value is RawMatcher {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 1 && candidate.noStdoutRedirect === true
  );
}
