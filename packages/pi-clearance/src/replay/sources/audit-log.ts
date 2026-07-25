import { existsSync, readFileSync } from "node:fs";

import type {
  AuditEntry,
  AuditEntryType,
  ReviewerMode,
} from "../../audit/entry.ts";
import type { DecisionEffect } from "../../policy/core.ts";
import type { AuditLogSource, SourceReadResult } from "../history.ts";

const DEFAULT_MAX_SEGMENTS = 64;
const AUDIT_ENTRY_TYPES: readonly AuditEntryType[] = [
  "policy.decision",
  "reviewer.decision",
  "trust.event",
  "config.event",
  "replay.input",
  "ratchet.proposal-decision",
];
const REVIEWER_MODES: readonly ReviewerMode[] = [
  "model",
  "human",
  "block-and-log",
  "mode-off",
];
const DECISION_EFFECTS: readonly DecisionEffect[] = ["allow", "deny", "review"];
const RATCHET_PROPOSAL_DECISIONS = [
  "accept",
  "reject",
  "revise",
  "aborted",
] as const;
const RATCHET_POST_WRITE_REPLAY_STATUSES = [
  "not-applicable",
  "passed",
  "regression",
  "not-run",
  "failed",
] as const;

export interface AuditFileSourceOptions {
  /** Active audit log path, e.g. <userConfigRoot>/audit.log. */
  readonly path: string;
  /** Number of rotated .N segments to scan. Defaults to 64. */
  readonly maxSegments?: number;
}

interface ParseAuditLogOptions {
  readonly sourceLabel?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function isAuditEntryType(value: unknown): value is AuditEntryType {
  return (
    typeof value === "string" &&
    AUDIT_ENTRY_TYPES.includes(value as AuditEntryType)
  );
}

function isDecisionEffect(value: unknown): value is DecisionEffect {
  return (
    typeof value === "string" &&
    DECISION_EFFECTS.includes(value as DecisionEffect)
  );
}

function isDecisionRecord(value: unknown): boolean {
  return isRecord(value) && isDecisionEffect(value.effect);
}

function isReviewerMode(value: unknown): value is ReviewerMode {
  return (
    typeof value === "string" && REVIEWER_MODES.includes(value as ReviewerMode)
  );
}

function hasAuditBaseFields(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  readonly version: 1;
  readonly timestamp: string;
  readonly entryType: AuditEntryType;
} {
  return (
    value.version === 1 &&
    typeof value.timestamp === "string" &&
    isAuditEntryType(value.entryType) &&
    isOptionalString(value.projectPath) &&
    isOptionalString(value.sessionId) &&
    isOptionalString(value.toolCallId)
  );
}

function isConfigMode(value: unknown): boolean {
  return (
    value === undefined ||
    value === "off" ||
    value === "ask" ||
    value === "auto"
  );
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function isRatchetProposalDecision(value: unknown): boolean {
  return (
    typeof value === "string" &&
    RATCHET_PROPOSAL_DECISIONS.includes(
      value as (typeof RATCHET_PROPOSAL_DECISIONS)[number],
    )
  );
}

function isPostWriteReplayStatus(value: unknown): boolean {
  return (
    typeof value === "string" &&
    RATCHET_POST_WRITE_REPLAY_STATUSES.includes(
      value as (typeof RATCHET_POST_WRITE_REPLAY_STATUSES)[number],
    )
  );
}

function isRatchetWriteDetails(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.attempted === "boolean" &&
    isOptionalBoolean(value.ok) &&
    isOptionalBoolean(value.changed) &&
    isOptionalString(value.planId) &&
    isOptionalString(value.backupPath) &&
    isOptionalString(value.reason)
  );
}

function isRatchetPostWriteReplayDetails(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      isPostWriteReplayStatus(value.status) &&
      isOptionalNumber(value.changedCalls) &&
      isOptionalNumber(value.regressionCount))
  );
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!isRecord(value) || !hasAuditBaseFields(value)) {
    return false;
  }

  switch (value.entryType) {
    case "policy.decision":
      return (
        typeof value.toolName === "string" &&
        "toolInput" in value &&
        isDecisionRecord(value.decision)
      );
    case "reviewer.decision":
      return (
        typeof value.toolName === "string" &&
        "toolInput" in value &&
        isReviewerMode(value.reviewerMode) &&
        isDecisionRecord(value.originalDecision) &&
        isDecisionRecord(value.finalDecision)
      );
    case "trust.event":
      return (
        (value.event === "project-trusted" ||
          value.event === "project-untrusted") &&
        typeof value.reason === "string"
      );
    case "config.event":
      return (
        (value.event === "mode-selected" ||
          value.event === "config-loaded" ||
          value.event === "config-load-failed") &&
        isConfigMode(value.mode) &&
        isStringArray(value.errors)
      );
    case "replay.input":
      return (
        typeof value.commandCount === "number" &&
        Number.isFinite(value.commandCount) &&
        isOptionalString(value.corpusId)
      );
    case "ratchet.proposal-decision":
      return (
        isOptionalString(value.batchId) &&
        typeof value.proposalId === "string" &&
        typeof value.proposalKind === "string" &&
        (value.applicationMode === "writable-after-approval" ||
          value.applicationMode === "design-input-only") &&
        isRatchetProposalDecision(value.decision) &&
        typeof value.targetKind === "string" &&
        isOptionalString(value.targetPath) &&
        isRatchetWriteDetails(value.write) &&
        isRatchetPostWriteReplayDetails(value.postWriteReplay)
      );
  }
}

function malformedLinesWarning(
  count: number,
  sourceLabel: string | undefined,
): string {
  const suffix = sourceLabel === undefined ? "" : ` in ${sourceLabel}`;
  return `skipped ${count} malformed audit lines${suffix}`;
}

function parseAuditLogLinesWithOptions(
  text: string,
  options?: ParseAuditLogOptions,
): SourceReadResult<AuditEntry> {
  const items: AuditEntry[] = [];
  let malformedLines = 0;

  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line);
      if (isAuditEntry(parsed)) {
        items.push(parsed);
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }

  return {
    items,
    warnings:
      malformedLines === 0
        ? []
        : [malformedLinesWarning(malformedLines, options?.sourceLabel)],
  };
}

function segmentLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_SEGMENTS;
  }

  return Math.floor(value);
}

function segmentPaths(
  activePath: string,
  maxSegments: number,
): readonly string[] {
  const paths: string[] = [];
  for (let segment = maxSegments; segment >= 1; segment -= 1) {
    paths.push(`${activePath}.${segment}`);
  }
  paths.push(activePath);
  return paths;
}

function warningMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

/** Parse audit JSONL text into AuditEntry rows, skipping malformed lines. */
export function parseAuditLogLines(text: string): SourceReadResult<AuditEntry> {
  return parseAuditLogLinesWithOptions(text);
}

export function createFileAuditLogSource(
  options: AuditFileSourceOptions,
): AuditLogSource {
  const path = options.path;
  const maxSegments = segmentLimit(options.maxSegments);

  return {
    path,
    read(): SourceReadResult<AuditEntry> {
      const items: AuditEntry[] = [];
      const warnings: string[] = [];
      let foundAnySegment = false;

      for (const segmentPath of segmentPaths(path, maxSegments)) {
        if (!existsSync(segmentPath)) {
          continue;
        }

        foundAnySegment = true;
        try {
          const result = parseAuditLogLinesWithOptions(
            readFileSync(segmentPath, "utf8"),
            { sourceLabel: segmentPath },
          );
          items.push(...result.items);
          warnings.push(...result.warnings);
        } catch (error) {
          warnings.push(
            `could not read audit log segment ${segmentPath}: ${warningMessage(error)}`,
          );
        }
      }

      if (!foundAnySegment) {
        warnings.push(`audit log ${path} was absent; no audit entries read`);
      }

      return { items, warnings };
    },
  };
}
