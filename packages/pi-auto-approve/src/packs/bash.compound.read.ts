import { defineShippedPack } from "./define.ts";

const COMPOUND_SAFE_SCOPES = ["project", "writable-project", "temp"] as const;

const rawPack = {
  version: 1,
  id: "bash.compound.read",
  rules: [
    {
      id: "bash.compound.read:allow-project-for-loop-read",
      effect: "allow",
      match: {
        all: [
          { compoundForm: "for" },
          { bodyStagesAllReadOnly: true },
          { noBodySubstitution: true },
          { noBodyShellWrap: true },
          { noBodyRedirectTo: true },
          { iteratorScopesAllIn: { scopes: [...COMPOUND_SAFE_SCOPES] } },
          { bodyStagesAllScopeIn: { scopes: [...COMPOUND_SAFE_SCOPES] } },
        ],
      },
      reason:
        "project/temp scoped for-loop with read-only body and no hidden body execution or file redirects",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const bashCompoundReadPack = defineShippedPack(rawPack);
