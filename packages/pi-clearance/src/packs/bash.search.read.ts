import {
  EFFECT_REGISTRY,
  type EffectRegistryEntry,
} from "../parse/native-effects.ts";
import { conditionGuardClauses, type RawMatcher } from "./condition-guards.ts";
import { defineShippedPack } from "./define.ts";

const SEARCH_SIMPLE_PROGRAM_MEMBERSHIP = new Set<string>([
  "grep",
  "rg",
  "jq",
  "uniq",
  "cut",
  "tr",
]);

const DIRECT_PACK_COMPATIBLE_CONDITIONAL_READS = new Set<string>([
  "grep",
  "rg",
]);

function isSearchPackSimpleRead(entry: EffectRegistryEntry): boolean {
  // `grep`/`rg` are stricter in the compound classifier than in this direct pack:
  // v1 direct-pack behavior stays compatible, while future compound-body allows
  // consume the registry condition before treating those stages as read-only.
  return (
    entry.class === "read-only" &&
    SEARCH_SIMPLE_PROGRAM_MEMBERSHIP.has(entry.program) &&
    (entry.condition === undefined ||
      DIRECT_PACK_COMPATIBLE_CONDITIONAL_READS.has(entry.program))
  );
}

const simpleReadEntries = EFFECT_REGISTRY.filter(isSearchPackSimpleRead);

const simpleReadMatchers: readonly RawMatcher[] = simpleReadEntries.map(
  (entry) => ({
    all: [
      { program: entry.program },
      { noSubstitution: true },
      { noStdoutRedirect: true },
      ...conditionGuardClauses(entry.condition),
    ],
  }),
);

const sortReadMatcher: RawMatcher = {
  all: [
    { program: "sort" },
    { noSubstitution: true },
    { noStdoutRedirect: true },
    ...conditionGuardClauses(
      EFFECT_REGISTRY.find((entry) => entry.program === "sort")?.condition,
    ),
  ],
};

const findReadMatcher: RawMatcher = {
  all: [
    { program: "find" },
    { noSubstitution: true },
    { noStdoutRedirect: true },
    ...conditionGuardClauses(
      EFFECT_REGISTRY.find((entry) => entry.program === "find")?.condition,
    ),
  ],
};

const sedPrintMatcher: RawMatcher = {
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

/** Stage-shaped allow clauses reused by heterogeneous composition. */
export const BASH_SEARCH_STAGE_FAMILY_MATCHERS: readonly RawMatcher[] = [
  sortReadMatcher,
  findReadMatcher,
  sedPrintMatcher,
  ...simpleReadMatchers,
];

const simpleReadRules = simpleReadEntries.map((entry, index) => {
  const match = simpleReadMatchers[index];
  if (match === undefined) {
    throw new Error(`missing search matcher for ${entry.program}`);
  }
  return {
    id: `bash.search.read:allow-${entry.program}`,
    effect: "allow",
    match,
    reason: `${entry.program} read-only search/filter command without substitution or stdout redirection`,
    provenance: { source: "shipped" },
  };
});

const rawPack = {
  version: 1,
  id: "bash.search.read",
  rules: [
    {
      id: "bash.search.read:review-sort-output",
      effect: "review",
      match: {
        all: [
          { program: "sort" },
          {
            any: [
              { flagPresent: "o" },
              { flagPresent: "output" },
              {
                flagMatches: { names: ["compress-program"], shortChars: ["o"] },
              },
            ],
          },
        ],
      },
      reason: "sort output-file or compressor-program flags write or execute",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.search.read:review-find-mutating-action",
      effect: "review",
      match: {
        all: [
          { program: "find" },
          {
            any: [
              { flagPresent: "delete" },
              { flagPresent: "exec" },
              { flagPresent: "execdir" },
              { flagPresent: "ok" },
              { flagPresent: "okdir" },
              { flagMatches: { names: ["fprint", "fprintf", "fls"] } },
            ],
          },
        ],
      },
      reason: "find mutation or execution actions require review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.search.read:review-sed-in-place",
      effect: "review",
      match: {
        all: [
          { program: "sed" },
          { any: [{ flagPresent: "i" }, { flagPresent: "in-place" }] },
        ],
      },
      reason: "sed in-place editing writes to disk",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.search.read:review-rg-rewrite",
      effect: "review",
      match: {
        all: [
          { program: "rg" },
          {
            flagMatches: {
              names: ["replace", "pre", "pre-glob"],
              prefixes: ["replace", "pre"],
              shortChars: ["r"],
            },
          },
        ],
      },
      reason: "ripgrep replacement and preprocessor flags require review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.search.read:allow-sort",
      effect: "allow",
      match: sortReadMatcher,
      reason: "sort text streams read-only without output file flags",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.search.read:allow-find",
      effect: "allow",
      match: findReadMatcher,
      reason: "find read-only filesystem search without mutation actions",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.search.read:allow-sed-print",
      effect: "allow",
      match: sedPrintMatcher,
      reason: "sed print-only mode without substitution or stdout redirection",
      provenance: { source: "shipped" },
    },
    ...simpleReadRules,
  ],
} as const;

// Known v1 limitation: the DSL cannot inspect sed script bodies, so script-level
// write commands such as `sed -n 'w file'` are NOT caught by any rule today and
// pass with the read allow. Accepted gap pending script-body analysis.
export const bashSearchReadPack = defineShippedPack(rawPack);
