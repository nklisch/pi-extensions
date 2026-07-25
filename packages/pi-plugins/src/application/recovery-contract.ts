import { z } from "zod";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { PendingTransitionRefSchema, type PendingTransitionRef } from "../domain/state/references.js";
import { ScopeReferenceSchema, type ScopeReference } from "../domain/state/scope.js";
import { GenerationSchema, type Generation } from "../domain/state/config-state.js";
import { InstalledPluginRecordSchema, type InstalledPluginRecord } from "../domain/state/installed-state.js";
import { ActivationObservationSchema, type ActivationObservation } from "./ports/lifecycle-reload.js";
import {
  LifecycleTransitionRecordSchemaV1,
  type LifecycleTransitionRecord,
  type LifecycleTransitionStatus,
} from "./ports/lifecycle-transition-store.js";
import { ProjectionExpectationSchema, type ProjectionExpectation } from "./ports/runtime-projection.js";

export const RecoveryDiagnosticCodeSchema = z.enum([
  "OWNER_LIVE",
  "OWNER_UNKNOWN",
  "BUDGET_EXHAUSTED",
  "STATE_STALE",
  "JOURNAL_MISSING",
  "JOURNAL_CORRUPT",
  "STATE_CORRUPT",
  "RECOVERY_CONFLICT",
  "PREVIOUS_UNAVAILABLE",
  "CLEANUP_FAILED",
]);
export type RecoveryDiagnosticCode = z.infer<typeof RecoveryDiagnosticCodeSchema>;

export const RecoveryPolicySchema = z.object({
  requiredBudgetMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxTransitions: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  abandonedGraceMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().readonly();
export type RecoveryPolicy = z.infer<typeof RecoveryPolicySchema>;

export const DefaultLifecycleRecoveryPolicy = Object.freeze({
  requiredBudgetMs: 2_000,
  maxTransitions: 128,
  abandonedGraceMs: 86_400_000,
} satisfies RecoveryPolicy);

export const TransitionRecoveryResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("finalized"), scope: ScopeReferenceSchema, plugin: PluginKeySchema, reference: PendingTransitionRefSchema, generation: GenerationSchema }).strict().readonly(),
  z.object({ kind: z.literal("rolled-back"), scope: ScopeReferenceSchema, plugin: PluginKeySchema, reference: PendingTransitionRefSchema, generation: GenerationSchema }).strict().readonly(),
  z.object({ kind: z.literal("abandoned"), scope: ScopeReferenceSchema, plugin: PluginKeySchema, reference: PendingTransitionRefSchema }).strict().readonly(),
  z.object({ kind: z.literal("cleanup-completed"), scope: ScopeReferenceSchema, plugin: PluginKeySchema, reference: PendingTransitionRefSchema }).strict().readonly(),
  z.object({
    kind: z.literal("deferred"),
    scope: ScopeReferenceSchema,
    plugin: PluginKeySchema.optional(),
    reference: PendingTransitionRefSchema.optional(),
    code: z.enum(["OWNER_LIVE", "OWNER_UNKNOWN", "BUDGET_EXHAUSTED", "STATE_STALE"]),
  }).strict().readonly(),
  z.object({
    kind: z.literal("blocked"),
    scope: ScopeReferenceSchema,
    plugin: PluginKeySchema.optional(),
    reference: PendingTransitionRefSchema.optional(),
    code: z.enum(["JOURNAL_MISSING", "JOURNAL_CORRUPT", "STATE_CORRUPT", "RECOVERY_CONFLICT", "PREVIOUS_UNAVAILABLE", "CLEANUP_FAILED"]),
  }).strict().readonly(),
]);
export type TransitionRecoveryResult = z.infer<typeof TransitionRecoveryResultSchema>;

export const LifecycleRecoveryResultSchema = z.object({
  results: z.array(TransitionRecoveryResultSchema).readonly(),
  deferred: z.boolean(),
  processed: z.number().int().nonnegative(),
}).strict().readonly();
export type LifecycleRecoveryResult = z.infer<typeof LifecycleRecoveryResultSchema>;

export const RecoveryEvidenceKindSchema = z.enum(["candidate-pending", "previous-pending", "final", "conflict", "missing"]);
export type RecoveryEvidenceKind = z.infer<typeof RecoveryEvidenceKindSchema>;
export const RecoveryEvidenceSchema = z.object({
  kind: RecoveryEvidenceKindSchema,
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  reference: PendingTransitionRefSchema,
  current: InstalledPluginRecordSchema.nullable(),
  observation: ActivationObservationSchema.optional(),
}).strict().readonly();
export type RecoveryEvidence = z.infer<typeof RecoveryEvidenceSchema>;

export const RecoveryClassificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("finalize"), projection: ProjectionExpectationSchema }).strict().readonly(),
  z.object({ kind: z.literal("compensate"), projection: ProjectionExpectationSchema }).strict().readonly(),
  z.object({ kind: z.literal("conflict"), code: z.literal("RECOVERY_CONFLICT") }).strict().readonly(),
  z.object({ kind: z.literal("blocked"), code: z.literal("PREVIOUS_UNAVAILABLE") }).strict().readonly(),
]);
export type RecoveryClassification = z.infer<typeof RecoveryClassificationSchema>;

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length && keys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]));
}

export function stateWithoutPending(record: InstalledPluginRecord): InstalledPluginRecord {
  const { pendingTransition: _pending, ...value } = record;
  return InstalledPluginRecordSchema.parse(value);
}

export function projectionMatchesObservation(observation: ActivationObservation, expectation: ProjectionExpectation, plugin: PluginKey): boolean {
  if (expectation.kind === "inactive") {
    return observation.kind === "inactive" &&
      sameJson(observation.scope, expectation.scope) &&
      observation.plugin === plugin &&
      observation.projectionDigest === expectation.digest;
  }
  return observation.kind === "active" &&
    sameJson(observation.scope, expectation.projection.scope) &&
    observation.plugin === plugin &&
    observation.revision === expectation.projection.revision &&
    observation.projectionDigest === expectation.projection.digest;
}

/** Classify only exact evidence; a reload return value is intentionally absent. */
export function classifyInterruptedTransition(input: Readonly<{
  record: LifecycleTransitionRecord;
  current: InstalledPluginRecord | null;
  observation?: ActivationObservation;
}>): RecoveryClassification {
  const record = LifecycleTransitionRecordSchemaV1.parse(input.record);
  const current = input.current === null ? null : InstalledPluginRecordSchema.parse(input.current);
  if (current !== null && current.plugin !== record.plugin) return { kind: "conflict", code: "RECOVERY_CONFLICT" };
  const pending = current?.pendingTransition;
  const currentWithoutPending = current === null ? null : stateWithoutPending(current);
  const isCandidate = currentWithoutPending !== null && sameJson(currentWithoutPending, record.candidate);
  const isPrevious = record.previous !== null && currentWithoutPending !== null && sameJson(currentWithoutPending, record.previous);
  if (pending === record.reference && isCandidate) {
    if (input.observation !== undefined && projectionMatchesObservation(input.observation, record.candidateProjection, record.plugin)) return { kind: "finalize", projection: record.candidateProjection };
    return record.previous === null ? { kind: "blocked", code: "PREVIOUS_UNAVAILABLE" } : { kind: "compensate", projection: record.previousProjection };
  }
  if (pending === record.reference && isPrevious) return { kind: "compensate", projection: record.previousProjection };
  const finalMatches = record.final === null ? current === null : currentWithoutPending !== null && sameJson(currentWithoutPending, record.final);
  if (pending === undefined && finalMatches) return { kind: "finalize", projection: record.candidateProjection };
  return { kind: "conflict", code: "RECOVERY_CONFLICT" };
}

export function safeRecoveryResult(input: TransitionRecoveryResult): TransitionRecoveryResult {
  return TransitionRecoveryResultSchema.parse(input);
}

export type {
  ActivationObservation,
  Generation,
  InstalledPluginRecord,
  LifecycleTransitionRecord,
  LifecycleTransitionStatus,
  PluginKey,
  PendingTransitionRef,
  ProjectionExpectation,
  ScopeReference,
};
