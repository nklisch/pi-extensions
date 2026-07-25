import type { ProposalValidation } from "./proposal-schema.ts";

/** Shared display order and labels for structured proposal validation checks. */
export const PROPOSAL_VALIDATION_CHECKS = [
  ["schema", "Schema"],
  ["matcherCompile", "Matcher compile"],
  ["floorOverlap", "Floor overlap"],
  ["configSchema", "Config schema"],
  ["promptOverride", "Prompt override"],
  ["packageAvailability", "Package availability"],
  ["trust", "Trust"],
  ["replay", "Replay"],
  ["adversarial", "Adversarial"],
] as const satisfies readonly (readonly [keyof ProposalValidation, string])[];

export type ProposalValidationCheckName =
  (typeof PROPOSAL_VALIDATION_CHECKS)[number][0];

export function proposalValidationCheckLabel(
  name: ProposalValidationCheckName,
): string {
  return PROPOSAL_VALIDATION_CHECKS.find(([key]) => key === name)?.[1] ?? name;
}
