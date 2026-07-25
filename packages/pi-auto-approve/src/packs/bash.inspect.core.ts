import {
  EFFECT_REGISTRY,
  type EffectRegistryEntry,
} from "../parse/native-effects.ts";
import { conditionGuardClauses, type RawMatcher } from "./condition-guards.ts";
import { defineShippedPack } from "./define.ts";

const INSPECTION_PROGRAM_MEMBERSHIP = new Set<string>([
  "ls",
  "cat",
  "head",
  "wc",
  "file",
  "stat",
  "pwd",
  "uname",
  "whoami",
  "id",
  "tree",
  "du",
  "df",
  "nl",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "which",
  "whereis",
  "type",
  "locate",
  "sha1sum",
  "sha224sum",
  "sha256sum",
  "sha384sum",
  "sha512sum",
  "md5sum",
  "b2sum",
  "shasum",
  "diff",
  "ps",
  "pgrep",
  "uptime",
  "groups",
  "sleep",
  "date",
  "printf",
  "echo",
]);

function isInspectionPackSimpleRead(entry: EffectRegistryEntry): boolean {
  // Pack membership is intentionally narrower than "all read-only programs":
  // this pack owns filesystem/shell inspection commands, while the registry owns
  // the side-effect classification and any flag conditions for each member.
  return (
    entry.class === "read-only" &&
    INSPECTION_PROGRAM_MEMBERSHIP.has(entry.program)
  );
}

const readOnlyProgramEntries = EFFECT_REGISTRY.filter(
  isInspectionPackSimpleRead,
);

const readOnlyProgramMatchers: readonly RawMatcher[] =
  readOnlyProgramEntries.map((entry) => ({
    all: [
      { program: entry.program },
      { noSubstitution: true },
      { noStdoutRedirect: true },
      // File-input reads are scoped to project/temp/non-secret home:
      // sha256sum ~/.ssh/id_rsa or diff /etc/shadow must not exfiltrate
      // secrets to the transcript (GLM blocker, 2026-07-23). Programs with
      // no file arguments (bare `tree`, `ps aux`) pass with zero facts.
      ...(entry.fileInputs === undefined || entry.fileInputs.kind === "none"
        ? []
        : [
            {
              pathScopesAllIn: {
                scopes: [
                  "project",
                  "writable-project",
                  "temp",
                  "home",
                  "safe-home",
                ],
                usages: ["argument"],
                requireFacts: "zero-or-more",
              },
            },
          ]),
      ...conditionGuardClauses(entry.condition),
    ],
  }));

const tailReadMatcher: RawMatcher = {
  all: [
    { program: "tail" },
    { noSubstitution: true },
    { noStdoutRedirect: true },
    ...conditionGuardClauses(
      EFFECT_REGISTRY.find((entry) => entry.program === "tail")?.condition,
    ),
  ],
};

const hostnameReadMatcher: RawMatcher = {
  all: [
    { program: "hostname" },
    { argCount: { max: 0 } },
    // hostname -b/--boot/--file SET the hostname; only the bare zero-flag
    // form is a read (review blocker, 2026-07-23).
    { flagAllowlist: {} },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

/** Stage-shaped allow clauses reused by heterogeneous composition. */
export const BASH_INSPECT_STAGE_FAMILY_MATCHERS: readonly RawMatcher[] = [
  tailReadMatcher,
  hostnameReadMatcher,
  ...readOnlyProgramMatchers,
];

const readOnlyProgramRules = readOnlyProgramEntries.map((entry, index) => {
  const match = readOnlyProgramMatchers[index];
  if (match === undefined) {
    throw new Error(`missing inspection matcher for ${entry.program}`);
  }
  return {
    id: `bash.inspect.core:allow-${entry.program}`,
    effect: "allow",
    match,
    reason: `${entry.program} read-only inspection without substitution or stdout redirection`,
    provenance: { source: "shipped" },
  };
});

const rawPack = {
  version: 1,
  id: "bash.inspect.core",
  rules: [
    {
      id: "bash.inspect.core:review-date-set",
      effect: "review",
      match: {
        all: [
          { program: "date" },
          { flagMatches: { names: ["s", "set"], shortChars: ["s"] } },
        ],
      },
      reason: "date set-time flags mutate the system clock",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.inspect.core:review-tail-follow",
      effect: "review",
      match: {
        all: [
          { program: "tail" },
          {
            any: [
              { flagPresent: "f" },
              { flagPresent: "F" },
              { flagPresent: "follow" },
            ],
          },
        ],
      },
      reason:
        "tail follow mode is a long-running watcher and should be reviewed",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.inspect.core:allow-tail",
      effect: "allow",
      match: tailReadMatcher,
      reason:
        "tail read-only inspection without substitution or stdout redirection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.inspect.core:allow-hostname",
      effect: "allow",
      match: hostnameReadMatcher,
      reason: "hostname inspection without a mutating hostname operand",
      provenance: { source: "shipped" },
    },
    ...readOnlyProgramRules,
  ],
} as const;

export const bashInspectCorePack = defineShippedPack(rawPack);
