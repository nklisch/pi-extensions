import { defineShippedPack } from "./define.ts";

const MUTATE_SCOPES = ["writable-project", "project"] as const;

const SENSITIVE_BOUNDARIES = [
  "project-overlay",
  "policy-pack",
  "reviewer-config",
  "executable-hook",
  "package-script",
  "user-owned-config",
] as const;

const rawPack = {
  version: 1,
  id: "pi.file.mutate",
  rules: [
    {
      id: "pi.file.mutate:review-trust-boundary-target",
      effect: "review",
      match: {
        all: [
          { mutationTool: { tools: ["edit", "write"] } },
          { mutationShape: { shape: "well-formed" } },
          { mutationTrustBoundary: { in: [...SENSITIVE_BOUNDARIES] } },
        ],
      },
      reason:
        "file mutation targets a trust-boundary file (config/policy/hook/package-script); requires review with typed facts",
      provenance: { source: "shipped" },
    },
    {
      id: "pi.file.mutate:allow-project-scoped-mutation",
      effect: "allow",
      match: {
        all: [
          { mutationTool: { tools: ["edit", "write"] } },
          { mutationShape: { shape: "well-formed" } },
          {
            pathScopesAllIn: {
              scopes: [...MUTATE_SCOPES],
              requireFacts: "one-or-more",
            },
          },
          { mutationTrustBoundary: { in: ["none"] } },
        ],
      },
      reason:
        "typed edit/write stays inside project scope with bounded mutation facts",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const piFileMutatePack = defineShippedPack(rawPack);
