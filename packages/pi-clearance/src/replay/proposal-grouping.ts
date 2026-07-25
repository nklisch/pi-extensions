import type {
  StructuredProposalBatch,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";

export interface ProposalGroup {
  readonly groupId: string;
  readonly key: string;
  readonly proposals: readonly StructuredRatchetProposal[];
  readonly impactScore: number;
}

/** Return the stable, coarse family address used by the batch presenter. */
export function proposalGroupKey(proposal: StructuredRatchetProposal): string {
  switch (proposal.kind) {
    case "data-pack-policy": {
      const change = proposal.change;
      if (change.kind !== "policy-pack") {
        return `policy:${proposal.target.kind}:unknown:${proposal.id}`;
      }
      const program = primaryProgramFromMatcher(change.match);
      const scope = pathScopeBucket(change.match);
      return `policy:${proposal.target.kind}:${change.effect}:${program ?? change.packId}${scope}`;
    }
    case "project-scope-config":
      return `scope:${proposal.target.kind}`;
    case "package-pack-enablement":
      return proposal.change.kind === "package-pack-enablement"
        ? `package:${proposal.change.packId}`
        : `package:${proposal.id}`;
    case "reviewer-config":
      return proposal.change.kind === "reviewer-config"
        ? `reviewer:${pointerRoot(proposal.change.pointer)}`
        : `reviewer:${proposal.id}`;
    case "pack-file-authoring":
      return proposal.change.kind === "pack-file-authoring"
        ? `authoring:${proposal.change.authoringKind}`
        : `authoring:${proposal.id}`;
  }
}

/** Group proposals without mutating the batch or depending on insertion order. */
export function groupProposals(
  batch: StructuredProposalBatch,
): readonly ProposalGroup[] {
  const grouped = new Map<string, StructuredRatchetProposal[]>();
  for (const proposal of batch.proposals) {
    const key = proposalGroupKey(proposal);
    const members = grouped.get(key) ?? [];
    members.push(proposal);
    grouped.set(key, members);
  }

  return [...grouped.entries()]
    .map(([key, proposals]) => ({
      groupId: key,
      key,
      proposals: [...proposals].sort(compareMembers),
      impactScore: proposals.reduce(
        (total, proposal) => total + proposalImpactScore(proposal),
        0,
      ),
    }))
    .sort(
      (left, right) =>
        right.impactScore - left.impactScore ||
        left.groupId.localeCompare(right.groupId),
    );
}

export function proposalImpactScore(
  proposal: StructuredRatchetProposal,
): number {
  const evidence = proposal.evidence;
  return (
    evidence.calls * 10 +
    evidence.uniqueCommands * 25 +
    evidence.reviewCalls * 10 +
    evidence.hardBlockCalls * 20 +
    evidence.modelReviewCalls * 5 +
    evidence.capturedDenialCalls * 20
  );
}

function compareMembers(
  left: StructuredRatchetProposal,
  right: StructuredRatchetProposal,
): number {
  return (
    proposalImpactScore(right) - proposalImpactScore(left) ||
    left.id.localeCompare(right.id)
  );
}

function primaryProgramFromMatcher(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = value.program;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  if (Array.isArray(value.programIn)) {
    const program = value.programIn.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.length > 0,
    );
    if (program !== undefined) {
      return program;
    }
  }
  for (const key of ["all", "any", "not"]) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const program = primaryProgramFromMatcher(item);
        if (program !== undefined) {
          return program;
        }
      }
    } else {
      const program = primaryProgramFromMatcher(nested);
      if (program !== undefined) {
        return program;
      }
    }
  }
  return undefined;
}

function pathScopeBucket(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const pathKeys = [
    "path",
    "pathIn",
    "pathPrefix",
    "pathPrefixes",
    "pathScope",
    "scope",
  ];
  if (pathKeys.some((key) => Object.hasOwn(value, key))) {
    return ":path-scope";
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) && nested.some((item) => pathScopeBucket(item))) {
      return ":path-scope";
    }
    if (pathScopeBucket(nested) !== "") {
      return ":path-scope";
    }
  }
  return "";
}

function pointerRoot(pointer: string): string {
  const parts = pointer.split("/").filter((part) => part.length > 0);
  return parts[0] ?? pointer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
