import { SUPPORTED_PI_BUILTIN_TOOL_SPECS } from "../parse/tool-specs.ts";
import { defineShippedPack } from "./define.ts";

const READ_SCOPES = [
  "writable-project",
  "project",
  "temp",
  "home",
  "agent-support",
] as const;

const supportedToolMatchers = SUPPORTED_PI_BUILTIN_TOOL_SPECS.map((spec) => ({
  tool: spec.toolName,
}));

const rawPack = {
  version: 1,
  id: "pi.inspect.read",
  rules: [
    {
      id: "pi.inspect.read:allow-scoped-read-tools",
      effect: "allow",
      match: {
        all: [
          { any: supportedToolMatchers },
          {
            pathScopesAllIn: {
              scopes: [...READ_SCOPES],
              requireFacts: "one-or-more",
            },
          },
        ],
      },
      reason:
        "read-only Pi tool input stays inside project/temp, non-secret home, or proven Pi agent-support scope",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const piInspectReadPack = defineShippedPack(rawPack);
