import type { ToolShape } from "../parse/shape.ts";
import type { Decision } from "../policy/core.ts";
import type { StructuredRatchetProposal } from "../replay/proposal-schema.ts";

export type AuditEntryType =
  | "policy.decision"
  | "reviewer.decision"
  | "trust.event"
  | "config.event"
  | "replay.input"
  | "ratchet.proposal-decision";

export interface AuditBaseEntry {
  readonly version: 1;
  readonly timestamp: string;
  readonly entryType: AuditEntryType;
  readonly projectPath?: string;
  readonly sessionId?: string;
  readonly toolCallId?: string;
}

export interface PolicyDecisionEntry extends AuditBaseEntry {
  readonly entryType: "policy.decision";
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly shape?: ToolShape;
  readonly decision: Decision;
}

export type ReviewerMode = "model" | "human" | "block-and-log" | "mode-off";
export type ReviewerContextMode = "minimal" | "recentContext";

export interface ReviewerDecisionEntry extends AuditBaseEntry {
  readonly entryType: "reviewer.decision";
  readonly reviewerMode: ReviewerMode;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly originalDecision: Decision;
  readonly finalDecision: Decision;
  // Additive optional labels populated by downstream reviewer-behavior features
  // (context-curation, temporary-escalation, model-adapter-and-token-budget).
  // Absent means the behavior did not fire or was not applicable. This feature
  // owns the entry shape so downstream features do not collide on audit/entry.ts.
  readonly escalated?: boolean;
  readonly contextMode?: ReviewerContextMode;
  readonly recentContextAttached?: boolean;
  readonly budgetExhausted?: boolean;
  /**
   * Origin of the final reviewer-decision effect.
   *
   * `reviewerMode` records the path shape (model/human/block-and-log), while
   * this label records why that path produced the final decision. In
   * particular, it distinguishes explicit `mode: "block"` from the unattended
   * fallback reached when no human UI can answer.
   */
  readonly decisionSource?:
    | "model"
    | "human"
    | "unattended-fallback"
    | "mode-off-passthrough";
  readonly reviewerModel?: { readonly provider: string; readonly id: string };
  readonly reviewerModelSource?: "configured" | "fallback";
  readonly reviewerModelNote?: string;
}

export type TrustEventKind = "project-trusted" | "project-untrusted";

export interface TrustEventEntry extends AuditBaseEntry {
  readonly entryType: "trust.event";
  readonly event: TrustEventKind;
  readonly projectPath?: string;
  readonly reason: string;
}

export type ConfigEventKind =
  | "mode-selected"
  | "config-loaded"
  | "config-load-failed";

export type ConfigMode = "off" | "ask" | "auto";

export interface ConfigEventEntry extends AuditBaseEntry {
  readonly entryType: "config.event";
  readonly event: ConfigEventKind;
  readonly mode?: ConfigMode;
  readonly errors?: readonly string[];
}

export interface ReplayInputEntry extends AuditBaseEntry {
  readonly entryType: "replay.input";
  readonly corpusId?: string;
  readonly commandCount: number;
}

export type RatchetProposalDecision =
  | "accept"
  | "accept-without-replay"
  | "reject"
  | "revise"
  | "skip"
  | "aborted";

export type RatchetProposalPostWriteReplayStatus =
  | "not-applicable"
  | "passed"
  | "regression"
  | "not-run"
  | "failed";

export interface RatchetProposalDecisionEntry extends AuditBaseEntry {
  readonly entryType: "ratchet.proposal-decision";
  readonly batchId?: string;
  readonly proposalId: string;
  readonly proposalKind: StructuredRatchetProposal["kind"];
  readonly applicationMode: StructuredRatchetProposal["applicationMode"];
  readonly decision: RatchetProposalDecision;
  readonly targetKind: StructuredRatchetProposal["target"]["kind"];
  readonly targetPath?: string;
  readonly write: {
    readonly attempted: boolean;
    readonly ok?: boolean;
    readonly changed?: boolean;
    readonly planId?: string;
    readonly backupPath?: string;
    readonly reason?: string;
  };
  readonly postWriteReplay?: {
    readonly status: RatchetProposalPostWriteReplayStatus;
    readonly changedCalls?: number;
    readonly regressionCount?: number;
  };
}

export type AuditEntry =
  | PolicyDecisionEntry
  | ReviewerDecisionEntry
  | TrustEventEntry
  | ConfigEventEntry
  | ReplayInputEntry
  | RatchetProposalDecisionEntry;

export interface EntryFactoryOptions {
  readonly clock?: () => Date;
}

type EntryFactoryInput<T extends AuditBaseEntry> = Omit<
  T,
  "version" | "timestamp"
>;

function timestamp(options: EntryFactoryOptions | undefined): string {
  return (options?.clock ?? (() => new Date()))().toISOString();
}

function stampEntry<T extends EntryFactoryInput<AuditBaseEntry>>(
  input: T,
  options: EntryFactoryOptions | undefined,
): T & Pick<AuditBaseEntry, "version" | "timestamp"> {
  return {
    ...input,
    version: 1,
    timestamp: timestamp(options),
  };
}

export function createPolicyDecisionEntry(
  input: EntryFactoryInput<PolicyDecisionEntry>,
  options?: EntryFactoryOptions,
): PolicyDecisionEntry {
  return stampEntry(input, options);
}

export function createReviewerDecisionEntry(
  input: EntryFactoryInput<ReviewerDecisionEntry>,
  options?: EntryFactoryOptions,
): ReviewerDecisionEntry {
  return stampEntry(input, options);
}

export function createTrustEventEntry(
  input: EntryFactoryInput<TrustEventEntry>,
  options?: EntryFactoryOptions,
): TrustEventEntry {
  return stampEntry(input, options);
}

export function createConfigEventEntry(
  input: EntryFactoryInput<ConfigEventEntry>,
  options?: EntryFactoryOptions,
): ConfigEventEntry {
  return stampEntry(input, options);
}

export function createReplayInputEntry(
  input: EntryFactoryInput<ReplayInputEntry>,
  options?: EntryFactoryOptions,
): ReplayInputEntry {
  return stampEntry(input, options);
}

export function createRatchetProposalDecisionEntry(
  input: EntryFactoryInput<RatchetProposalDecisionEntry>,
  options?: EntryFactoryOptions,
): RatchetProposalDecisionEntry {
  return stampEntry(input, options);
}
