import {
  PROPOSAL_BATCH_SCHEMA_VERSION,
  type ProposalEvidence,
  type StructuredProposalBatch,
  type StructuredRatchetProposal,
  validateStructuredProposal,
  validateStructuredProposalBatch,
} from "./proposal-schema.ts";

export interface StructuredProposalBatchInput {
  readonly generatedAt: string;
  readonly proposals: readonly unknown[];
  readonly source?: {
    readonly corpusSummary?: StructuredProposalBatch["source"]["corpusSummary"];
    readonly warnings?: readonly string[];
  };
  readonly warnings?: readonly string[];
}

interface ProposalWithFingerprint {
  readonly proposal: StructuredRatchetProposal;
  readonly fingerprint: string;
}

/**
 * Build a validated structured proposal batch without making markdown a data
 * source. Malformed proposal inputs are skipped with warnings so one bad adapter
 * output does not discard the whole batch.
 */
export function createStructuredProposalBatch(
  input: StructuredProposalBatchInput,
): StructuredProposalBatch {
  const warnings: string[] = [
    ...(input.source?.warnings ?? []),
    ...(input.warnings ?? []),
  ];
  const valid: StructuredRatchetProposal[] = [];

  input.proposals.forEach((proposal, index) => {
    const result = validateStructuredProposal(proposal);
    if (result.ok) {
      valid.push(result.proposal);
      return;
    }
    warnings.push(
      `Skipped malformed structured proposal at index ${index}: ${result.errors.join("; ")}`,
    );
  });

  const { proposals, warnings: dedupeWarnings } = dedupeStructuredProposals(
    sortStructuredProposals(valid),
  );
  warnings.push(...dedupeWarnings);

  const batch: StructuredProposalBatch = {
    version: PROPOSAL_BATCH_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    source: {
      ...(input.source?.corpusSummary === undefined
        ? {}
        : { corpusSummary: input.source.corpusSummary }),
      warnings: [...(input.source?.warnings ?? [])],
    },
    proposals,
    warnings,
  };

  const validation = validateStructuredProposalBatch(batch);
  if (!validation.ok) {
    throw new ProposalBatchError(validation.errors);
  }
  return validation.batch;
}

/** Merge already-valid batches, preserving source/batch warnings and deduping proposals. */
export function mergeStructuredProposalBatches(
  ...batches: readonly StructuredProposalBatch[]
): StructuredProposalBatch {
  const generatedAt = batches
    .map((batch) => batch.generatedAt)
    .sort()
    .at(-1);

  return createStructuredProposalBatch({
    generatedAt: generatedAt ?? new Date(0).toISOString(),
    proposals: batches.flatMap((batch) => batch.proposals),
    source: {
      warnings: batches.flatMap((batch) => batch.source.warnings),
      corpusSummary: firstCorpusSummary(batches),
    },
    warnings: batches.flatMap(batchWarningsWithoutSource),
  });
}

export function getStructuredProposal(
  batch: StructuredProposalBatch,
  id: string,
): StructuredRatchetProposal | undefined {
  return batch.proposals.find((proposal) => proposal.id === id);
}

/**
 * Deterministic ordering for proposal cards and downstream processing: evidence
 * impact first, then safer/non-writable posture, then kind/id.
 */
export function sortStructuredProposals(
  proposals: readonly StructuredRatchetProposal[],
): readonly StructuredRatchetProposal[] {
  return [...proposals].sort(compareStructuredProposals);
}

export class ProposalBatchError extends Error {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(`structured proposal batch failed validation:\n${errors.join("\n")}`);
    this.name = "ProposalBatchError";
    this.errors = errors;
  }
}

function batchWarningsWithoutSource(
  batch: StructuredProposalBatch,
): readonly string[] {
  const sourceCounts = new Map<string, number>();
  for (const warning of batch.source.warnings) {
    sourceCounts.set(warning, (sourceCounts.get(warning) ?? 0) + 1);
  }

  return batch.warnings.filter((warning) => {
    const remainingSourceCount = sourceCounts.get(warning) ?? 0;
    if (remainingSourceCount === 0) {
      return true;
    }
    if (remainingSourceCount === 1) {
      sourceCounts.delete(warning);
    } else {
      sourceCounts.set(warning, remainingSourceCount - 1);
    }
    return false;
  });
}

function dedupeStructuredProposals(
  proposals: readonly StructuredRatchetProposal[],
): {
  readonly proposals: readonly StructuredRatchetProposal[];
  readonly warnings: readonly string[];
} {
  const byId = new Map<string, ProposalWithFingerprint>();
  const byFingerprint = new Map<string, ProposalWithFingerprint>();
  const kept: ProposalWithFingerprint[] = [];
  const warnings: string[] = [];

  for (const proposal of proposals) {
    const candidate: ProposalWithFingerprint = {
      proposal,
      fingerprint: targetChangeFingerprint(proposal),
    };
    const collisions = uniqueProposalItems([
      byId.get(proposal.id),
      byFingerprint.get(candidate.fingerprint),
    ]);
    if (collisions.length === 0) {
      kept.push(candidate);
      indexProposal(candidate, byId, byFingerprint);
      continue;
    }

    const collisionSet = [...collisions, candidate];
    const winner = chooseDedupeWinner(collisionSet);
    const losers = collisionSet.filter((item) => item !== winner);
    warnings.push(collisionWarning(collisionSet, winner, losers));

    for (const loser of losers) {
      if (loser === candidate) {
        continue;
      }
      removeProposal(loser, byId, byFingerprint);
      removeFromKept(kept, loser);
    }

    if (winner === candidate) {
      kept.push(candidate);
    }
    // Re-index after every collision is removed. A single incoming proposal can
    // bridge an id collision and a target/change collision, so the winner must
    // become the sole owner of both indexes for the whole collision set.
    removeProposal(winner, byId, byFingerprint);
    indexProposal(winner, byId, byFingerprint);
  }

  return {
    proposals: kept.map((item) => item.proposal),
    warnings,
  };
}

function uniqueProposalItems(
  items: readonly (ProposalWithFingerprint | undefined)[],
): ProposalWithFingerprint[] {
  const unique: ProposalWithFingerprint[] = [];
  for (const item of items) {
    if (item !== undefined && !unique.includes(item)) {
      unique.push(item);
    }
  }
  return unique;
}

function chooseDedupeWinner(
  items: readonly ProposalWithFingerprint[],
): ProposalWithFingerprint {
  let winner = items[0];
  if (winner === undefined) {
    throw new ProposalBatchError(["cannot choose a winner from no proposals"]);
  }
  for (const item of items.slice(1)) {
    if (chooseSafer(winner.proposal, item.proposal) === item.proposal) {
      winner = item;
    }
  }
  return winner;
}

function collisionWarning(
  items: readonly ProposalWithFingerprint[],
  winner: ProposalWithFingerprint,
  losers: readonly ProposalWithFingerprint[],
): string {
  const ids = items.map((item) => item.proposal.id).join(", ");
  const droppedIds = losers.map((item) => item.proposal.id).join(", ");
  const identical = items.every(
    (item) => stableJson(item.proposal) === stableJson(winner.proposal),
  );
  if (identical) {
    return `Dropped duplicate structured proposals ${droppedIds}; identical proposal already present as ${winner.proposal.id}.`;
  }

  const droppedWarnings = losers
    .flatMap((item) => item.proposal.warnings)
    .filter((warning) => warning.length > 0)
    .join(" | ");
  return `Deduped conflicting structured proposals ${ids}; kept safer proposal ${winner.proposal.id} and dropped ${droppedIds}.${
    droppedWarnings.length === 0 ? "" : ` Dropped warnings: ${droppedWarnings}`
  }`;
}

function indexProposal(
  item: ProposalWithFingerprint,
  byId: Map<string, ProposalWithFingerprint>,
  byFingerprint: Map<string, ProposalWithFingerprint>,
): void {
  byId.set(item.proposal.id, item);
  byFingerprint.set(item.fingerprint, item);
}

function removeProposal(
  item: ProposalWithFingerprint,
  byId: Map<string, ProposalWithFingerprint>,
  byFingerprint: Map<string, ProposalWithFingerprint>,
): void {
  byId.delete(item.proposal.id);
  byFingerprint.delete(item.fingerprint);
}

function removeFromKept(
  kept: ProposalWithFingerprint[],
  item: ProposalWithFingerprint,
): void {
  const index = kept.indexOf(item);
  if (index >= 0) {
    kept.splice(index, 1);
  }
}

function chooseSafer(
  left: StructuredRatchetProposal,
  right: StructuredRatchetProposal,
): StructuredRatchetProposal {
  const riskDelta = riskScore(left) - riskScore(right);
  if (riskDelta < 0) {
    return left;
  }
  if (riskDelta > 0) {
    return right;
  }
  return compareStructuredProposals(left, right) <= 0 ? left : right;
}

function compareStructuredProposals(
  left: StructuredRatchetProposal,
  right: StructuredRatchetProposal,
): number {
  return (
    impactScore(right.evidence) - impactScore(left.evidence) ||
    riskScore(left) - riskScore(right) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

function impactScore(evidence: ProposalEvidence): number {
  return (
    evidence.calls * 10 +
    evidence.uniqueCommands * 25 +
    evidence.reviewCalls * 10 +
    evidence.hardBlockCalls * 20 +
    evidence.modelReviewCalls * 5 +
    evidence.capturedDenialCalls * 20
  );
}

function riskScore(proposal: StructuredRatchetProposal): number {
  const writableRisk =
    proposal.applicationMode === "writable-after-approval" ? 10 : 0;
  const dangerNotes = proposal.trustNotes.filter(
    (note) => note.severity === "danger",
  ).length;
  const warningNotes = proposal.trustNotes.filter(
    (note) => note.severity === "warning",
  ).length;
  const failedChecks = Object.values(proposal.validation).filter(
    (check) => check?.status === "fail",
  ).length;
  const pendingChecks = Object.values(proposal.validation).filter(
    (check) => check?.status === "pending",
  ).length;
  return (
    writableRisk +
    dangerNotes * 4 +
    warningNotes * 2 +
    failedChecks * 3 +
    pendingChecks
  );
}

function targetChangeFingerprint(proposal: StructuredRatchetProposal): string {
  return stableJson({ target: proposal.target, change: proposal.change });
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstCorpusSummary(
  batches: readonly StructuredProposalBatch[],
): StructuredProposalBatch["source"]["corpusSummary"] | undefined {
  return batches.find((batch) => batch.source.corpusSummary !== undefined)
    ?.source.corpusSummary;
}
