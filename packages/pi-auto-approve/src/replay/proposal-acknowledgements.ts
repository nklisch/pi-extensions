import type {
  ProposalTrustNote,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";

export interface ProposalTrustNoteAcknowledgement {
  readonly index: number;
  readonly kind: string;
  readonly severity: "warning" | "danger";
  readonly code: string;
  readonly message: string;
}

export function trustNoteAcknowledgementCode(
  kind: string,
  index: number,
): string {
  const slug = kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return `ratchet-trust-note-${slug.length === 0 ? "note" : slug}-${index}`;
}

export function trustNoteRequiredAcknowledgements(
  notes: readonly ProposalTrustNote[],
): readonly ProposalTrustNoteAcknowledgement[] {
  return notes.flatMap(
    (note, index): readonly ProposalTrustNoteAcknowledgement[] => {
      const severity = note.severity ?? "info";
      if (severity !== "warning" && severity !== "danger") {
        return [];
      }
      return [
        {
          index,
          kind: note.kind,
          severity,
          code: trustNoteAcknowledgementCode(note.kind, index),
          message: note.message,
        },
      ];
    },
  );
}

export function proposalRequiredAcknowledgementCodes(
  proposal: StructuredRatchetProposal,
): readonly string[] {
  if (proposal.change.kind === "package-pack-enablement") {
    return [...proposal.change.plan.requiredAcknowledgementCodes];
  }
  return trustNoteRequiredAcknowledgements(proposal.trustNotes).map(
    (acknowledgement) => acknowledgement.code,
  );
}
