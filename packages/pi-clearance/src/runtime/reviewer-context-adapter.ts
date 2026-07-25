import { existsSync, readFileSync } from "node:fs";

import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { AuditEntry } from "../audit/entry.ts";
import { DEFAULT_SECRETS, redactString, redactValue } from "../audit/redact.ts";
import type { Decision, DecisionEffect } from "../policy/core.ts";
import { parseAuditLogLines } from "../replay/sources/audit-log.ts";
import type {
  ConversationTurnSource,
  RawConversationTurn,
  RecentDecisionEntry,
  RecentDecisionProvenance,
  RecentDecisionSource,
  SourceReadResult,
} from "./reviewer-context.ts";
import { defaultAuditLogPath } from "./sink.ts";

const DEFAULT_MAX_SEGMENTS = 2;

export interface AuditLogRecentDecisionSourceOptions {
  /** Defaults to defaultAuditLogPath(). */
  readonly path?: string;
  /** Rotated segments to scan (bounds I/O). Defaults to 2 (active + .1). */
  readonly maxSegments?: number;
}

export function createAuditLogRecentDecisionSource(
  options: AuditLogRecentDecisionSourceOptions = {},
): RecentDecisionSource {
  const path = options.path ?? defaultAuditLogPath();
  const maxSegments = segmentCount(options.maxSegments);

  return {
    readRecent(): SourceReadResult<RecentDecisionEntry> {
      const items: RecentDecisionEntry[] = [];
      const warnings: string[] = [];
      let foundAnySegment = false;

      for (const segmentPath of recentSegmentPaths(path, maxSegments)) {
        let exists = false;
        try {
          exists = existsSync(segmentPath);
        } catch (error) {
          warnings.push(
            `could not stat audit log segment ${segmentPath}: ${warningMessage(error)}`,
          );
          continue;
        }

        if (!exists) continue;
        foundAnySegment = true;

        try {
          const parsed = parseAuditLogLines(readFileSync(segmentPath, "utf8"));
          items.push(
            ...parsed.items
              .slice()
              .reverse()
              .map(projectRecentDecision)
              .filter(isDefined),
          );
          warnings.push(...parsed.warnings);
        } catch (error) {
          warnings.push(
            `could not read audit log segment ${segmentPath}: ${warningMessage(error)}`,
          );
        }
      }

      if (!foundAnySegment) {
        warnings.push(`audit log ${path} was absent; no recent decisions read`);
      }

      return { items, warnings };
    },
  };
}

export function createSessionConversationTurnSource(options: {
  readonly sessionManager: ExtensionContext["sessionManager"];
}): ConversationTurnSource {
  return {
    readRecent(): SourceReadResult<RawConversationTurn> {
      try {
        return {
          items: projectConversationTurns(
            options.sessionManager.getBranch().slice().reverse(),
          ),
          warnings: [],
        };
      } catch (error) {
        return {
          items: [],
          warnings: [
            `could not read session conversation turns: ${warningMessage(error)}`,
          ],
        };
      }
    },
  };
}

function recentSegmentPaths(
  activePath: string,
  maxSegments: number,
): readonly string[] {
  const paths: string[] = [];
  for (let index = 0; index < maxSegments; index += 1) {
    paths.push(index === 0 ? activePath : `${activePath}.${index}`);
  }
  return paths;
}

function segmentCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_SEGMENTS;
  }
  return Math.floor(value);
}

function projectRecentDecision(
  entry: AuditEntry,
): RecentDecisionEntry | undefined {
  if (entry.entryType === "policy.decision") {
    return {
      timestamp: entry.timestamp,
      entryType: entry.entryType,
      toolName: entry.toolName,
      effect: decisionEffect(entry.decision),
      reason: decisionReason(entry.decision),
      ...optionalProvenance("provenance", entry.decision),
      ...projectToolInput(entry.toolInput),
      ...(entry.shape === undefined ? {} : { shape: entry.shape }),
    };
  }

  if (entry.entryType === "reviewer.decision") {
    return {
      timestamp: entry.timestamp,
      entryType: entry.entryType,
      toolName: entry.toolName,
      effect: decisionEffect(entry.finalDecision),
      reason: decisionReason(entry.finalDecision),
      ...optionalProvenance("provenance", entry.finalDecision),
      ...projectToolInput(entry.toolInput),
      reviewerMode: entry.reviewerMode,
      ...(entry.decisionSource === undefined
        ? {}
        : { reviewerDecisionSource: entry.decisionSource }),
      ...(entry.reviewerModel === undefined
        ? {}
        : { reviewerModel: entry.reviewerModel }),
      ...(entry.reviewerModelSource === undefined
        ? {}
        : { reviewerModelSource: entry.reviewerModelSource }),
      ...(entry.reviewerModelNote === undefined
        ? {}
        : { reviewerModelNote: entry.reviewerModelNote }),
      originalEffect: decisionEffect(entry.originalDecision),
      originalReason: decisionReason(entry.originalDecision),
      ...optionalProvenance("originalProvenance", entry.originalDecision),
      finalEffect: decisionEffect(entry.finalDecision),
      finalReason: decisionReason(entry.finalDecision),
      ...optionalProvenance("finalProvenance", entry.finalDecision),
    };
  }

  return undefined;
}

function projectConversationTurns(
  entries: readonly SessionEntry[],
): readonly RawConversationTurn[] {
  const turns: RawConversationTurn[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (!isConversationMessage(message)) continue;

    const text = textContent(message.content);
    if (text.length === 0) continue;

    turns.push({ role: message.role, text, timestamp: entry.timestamp });
  }

  return turns;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!isRecord(block) || block.type !== "text") return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function isConversationMessage(value: unknown): value is {
  readonly role: "user" | "assistant";
  readonly content: unknown;
} {
  return (
    isRecord(value) &&
    (value.role === "user" || value.role === "assistant") &&
    "content" in value
  );
}

function projectToolInput(value: unknown): {
  readonly command?: string;
  readonly toolInput?: unknown;
} {
  const redacted = redactValue(value, { secretRules: DEFAULT_SECRETS });
  if (isRecord(redacted) && typeof redacted.command === "string") {
    return { command: redactString(redacted.command) };
  }

  return value === undefined ? {} : { toolInput: redacted };
}

function optionalProvenance<
  TKey extends "provenance" | "originalProvenance" | "finalProvenance",
>(
  key: TKey,
  decision: Decision,
): { readonly [K in TKey]?: RecentDecisionProvenance } {
  const provenance = projectProvenance(decision.provenance);
  return provenance === undefined
    ? {}
    : ({ [key]: provenance } as {
        readonly [K in TKey]?: RecentDecisionProvenance;
      });
}

function projectProvenance(
  value: unknown,
): RecentDecisionProvenance | undefined {
  if (!isRecord(value)) return undefined;
  const source = typeof value.source === "string" ? value.source : undefined;
  const packId = typeof value.packId === "string" ? value.packId : undefined;
  const ruleId = typeof value.ruleId === "string" ? value.ruleId : undefined;
  if (source === undefined && packId === undefined && ruleId === undefined) {
    return undefined;
  }

  return {
    ...(isDecisionSource(source) ? { source } : {}),
    ...(packId === undefined ? {} : { packId }),
    ...(ruleId === undefined ? {} : { ruleId }),
  };
}

function decisionEffect(decision: Decision): DecisionEffect {
  return decision.effect;
}

function decisionReason(decision: Decision): string {
  return typeof decision.reason === "string" ? decision.reason : "not recorded";
}

function isDecisionSource(
  value: string | undefined,
): value is NonNullable<RecentDecisionProvenance["source"]> {
  return (
    value === "shipped" ||
    value === "user-global" ||
    value === "user-project" ||
    value === "trusted-repo" ||
    value === "package" ||
    value === "generated" ||
    value === "default"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function warningMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
