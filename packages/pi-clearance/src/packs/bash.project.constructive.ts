import { defineShippedPack } from "./define.ts";

const CONSTRUCTIVE_PROGRAMS = ["mkdir", "touch", "mktemp"] as const;
const CONSTRUCTIVE_SCOPES = ["writable-project", "project", "temp"] as const;

const constructiveAllowRules = CONSTRUCTIVE_PROGRAMS.map((program) => ({
  id: `bash.project.constructive:allow-${program}`,
  effect: "allow",
  match: {
    all: [
      { program },
      { noSubstitution: true },
      { noStdoutRedirect: true },
      // TMPDIR=/etc mktemp would create the file outside temp scope; screen
      // the override on mktemp only (GLM review follow-up, 2026-07-23).
      ...(program === "mktemp"
        ? [{ not: { envAssignmentNameIn: { names: ["TMPDIR"] } } }]
        : []),
      {
        pathScopesAllIn: {
          scopes: [...CONSTRUCTIVE_SCOPES],
          programs: [program],
          requireFacts: "per-command-stage",
        },
      },
    ],
  },
  reason: `${program} within configured project/temp path scope`,
  provenance: { source: "shipped" },
}));

const rawPack = {
  version: 1,
  id: "bash.project.constructive",
  rules: [
    {
      id: "bash.project.constructive:review-mkdir-mode",
      effect: "review",
      match: {
        all: [
          { program: "mkdir" },
          { any: [{ flagPresent: "m" }, { flagPresent: "mode" }] },
        ],
      },
      reason: "mkdir mode changes permission semantics and requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.project.constructive:review-copy-move",
      effect: "review",
      match: { any: [{ program: "cp" }, { program: "mv" }] },
      reason:
        "copy/move targets need a separate source/target path contract before they can be allowed",
      provenance: { source: "shipped" },
    },
    ...constructiveAllowRules,
  ],
} as const;

export const bashProjectConstructivePack = defineShippedPack(rawPack);
