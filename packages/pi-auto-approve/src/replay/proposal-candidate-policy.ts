/**
 * Shared structured-proposal candidate-policy construction.
 *
 * Proposal replay and adversarial validation both need to turn the same
 * data-pack proposal payload into the same runtime candidate policy. Keeping
 * that translation here prevents dry-run replay and adversarial checks from
 * disagreeing about raw proposal compilation, provenance, active-lane append
 * order, or sealed-floor preservation.
 *
 * Safety boundary: this module compiles JSON-compatible data-pack proposals or
 * appends an already trusted/loaded `PolicyPack` supplied by a caller. It never
 * reads files, writes config, executes shell commands, imports trusted
 * TypeScript modules by path, prompts, or calls a model.
 */

import { policyWithCandidatePack } from "../packs/validation.ts";
import type { EffectivePolicy, PolicyPack } from "../policy/core.ts";
import { compilePack } from "../policy/core.ts";
import type {
  PolicyPackProposalChange,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";

export interface DataPackCandidatePolicyInput {
  readonly proposal: StructuredRatchetProposal;
  readonly baselinePolicy: EffectivePolicy;
  /** Already compiled candidate pack; skips raw proposal compilation when present. */
  readonly candidatePack?: PolicyPack;
}

export type CandidatePolicyBuildResult =
  | {
      readonly ok: true;
      readonly candidatePack: PolicyPack;
      readonly candidatePolicy: EffectivePolicy;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/**
 * Build a candidate policy for a `data-pack-policy` proposal.
 *
 * When `candidatePack` is omitted, the raw pack is constructed from the
 * proposal's self-contained rule fields and compiled through the normal DSL
 * compiler. The resulting pack is appended to the baseline active lane via the
 * same helper used by pack-validation replay, preserving the baseline sealed
 * floor by reference and never mutating the baseline policy.
 */
export function buildDataPackCandidatePolicy(
  input: DataPackCandidatePolicyInput,
): CandidatePolicyBuildResult {
  const { proposal } = input;
  if (proposal.kind !== "data-pack-policy") {
    return {
      ok: false,
      reason: `data-pack-policy candidate expected proposal kind "data-pack-policy", got "${proposal.kind}"`,
    };
  }
  if (proposal.change.kind !== "policy-pack") {
    return {
      ok: false,
      reason: `data-pack-policy candidate expected change kind "policy-pack", got "${proposal.change.kind}"`,
    };
  }

  let candidatePack = input.candidatePack;
  if (candidatePack === undefined) {
    const rawPack = rawPackFromDataPackChange(proposal, proposal.change);
    const compiled = compilePack(rawPack);
    if (compiled.pack === null) {
      const errors = compiled.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; ");
      return {
        ok: false,
        reason: `data-pack-policy candidate pack failed to compile: ${errors}`,
      };
    }
    candidatePack = compiled.pack;
  }

  return {
    ok: true,
    candidatePack,
    candidatePolicy: buildCandidatePolicyWithPack(
      input.baselinePolicy,
      candidatePack,
    ),
  };
}

/** Append a supplied, already-trusted candidate pack to the baseline policy. */
export function buildCandidatePolicyWithPack(
  baselinePolicy: EffectivePolicy,
  candidatePack: PolicyPack,
): EffectivePolicy {
  return policyWithCandidatePack(baselinePolicy, candidatePack);
}

/**
 * Build the raw JSON pack for a data-pack candidate from proposal change fields.
 *
 * `rawPackPatch` describes the eventual config write and is deliberately not
 * interpreted here. The candidate pack is the single proposed rule described by
 * `packId`, `ruleId`, `effect`, `match`, `reason`, and the proposal's intended
 * landing provenance.
 */
export function rawPackFromDataPackChange(
  proposal: StructuredRatchetProposal,
  change: PolicyPackProposalChange,
): unknown {
  return {
    version: 1,
    id: change.packId,
    rules: [
      {
        id: change.ruleId,
        effect: change.effect,
        match: change.match,
        reason: change.reason,
        provenance: {
          source: proposal.intendedProvenance ?? "generated",
        },
      },
    ],
  };
}
