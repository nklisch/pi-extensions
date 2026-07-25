import { SUPPORTED_PI_BUILTIN_TOOL_SPECS } from "../parse/tool-specs.ts";
import { defineShippedPack } from "./define.ts";

const SAFE_HOME_SCOPE = ["safe-home"] as const;

const HOME_REVIEW_BOUNDARIES = [
  "sensitive-home",
  "project-overlay",
  "policy-pack",
  "reviewer-config",
  "executable-hook",
  "package-script",
  "user-owned-config",
  "unknown",
] as const;

const supportedReadToolMatchers = SUPPORTED_PI_BUILTIN_TOOL_SPECS.map(
  (spec) => ({ tool: spec.toolName }),
);

const rawPack = {
  version: 1,
  id: "pi.home.safe",
  rules: [
    {
      id: "pi.home.safe:review-trust-boundary-home-mutation",
      effect: "review",
      match: {
        all: [
          { mutationTool: { tools: ["edit", "write"] } },
          { mutationTrustBoundary: { in: [...HOME_REVIEW_BOUNDARIES] } },
        ],
      },
      reason:
        "typed edit/write targets a sensitive-home or trust-boundary file; requires review with typed facts",
      provenance: { source: "shipped" },
    },
    {
      id: "pi.home.safe:allow-safe-home-mutation",
      effect: "allow",
      match: {
        all: [
          { mutationTool: { tools: ["edit", "write"] } },
          { mutationShape: { shape: "well-formed" } },
          {
            pathScopesAllIn: {
              scopes: [...SAFE_HOME_SCOPE],
              requireFacts: "one-or-more",
            },
          },
          { mutationTrustBoundary: { in: ["none"] } },
        ],
      },
      reason:
        "typed edit/write stays inside configured safe-home scope with bounded mutation facts",
      provenance: { source: "shipped" },
    },
    {
      id: "pi.home.safe:allow-safe-home-read-tools",
      effect: "allow",
      match: {
        all: [
          { any: supportedReadToolMatchers },
          {
            pathScopesAllIn: {
              scopes: [...SAFE_HOME_SCOPE],
              requireFacts: "one-or-more",
            },
          },
        ],
      },
      reason: "read-only Pi tool input stays inside configured safe-home scope",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const piHomeSafePack = defineShippedPack(rawPack);
