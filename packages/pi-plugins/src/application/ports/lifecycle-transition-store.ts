import { z } from "zod";
import {
  GenerationSchema,
  type Generation,
} from "../../domain/state/config-state.js";
import {
  PendingTransitionRefSchema,
  type PendingTransitionRef,
} from "../../domain/state/references.js";
import {
  ScopeReferenceSchema,
  type ScopeReference,
} from "../../domain/state/scope.js";
import { PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import {
  LifecycleOperationSchema,
  LifecycleOriginSchema,
  LifecyclePluginStateSchema,
  LifecycleRetainedDataSchema,
  deriveLifecyclePendingTransitionRef,
  type LifecycleOperation,
  type LifecycleOrigin,
  type LifecyclePluginState,
  type LifecycleRetainedData,
} from "../plugin-lifecycle-contract.js";
import { EpochMillisecondsSchema, type EpochMilliseconds } from "./lifecycle-clock.js";
import {
  ProjectionExpectationSchema,
  type ProjectionExpectation,
} from "./runtime-projection.js";

export const LifecycleTransitionRecordSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  reference: PendingTransitionRefSchema,
  operationId: z.string().uuid(),
  operation: LifecycleOperationSchema,
  origin: LifecycleOriginSchema,
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  startingGeneration: GenerationSchema,
  previous: LifecyclePluginStateSchema.nullable(),
  candidate: LifecyclePluginStateSchema,
  final: LifecyclePluginStateSchema.nullable(),
  previousProjection: ProjectionExpectationSchema,
  candidateProjection: ProjectionExpectationSchema,
  retainedData: LifecycleRetainedDataSchema,
}).strict().readonly().superRefine((record, context) => {
  if (record.previous !== null && record.previous.plugin !== record.plugin) context.addIssue({ code: "custom", path: ["previous", "plugin"], message: "previous state belongs to another plugin" });
  if (record.candidate.plugin !== record.plugin) context.addIssue({ code: "custom", path: ["candidate", "plugin"], message: "candidate state belongs to another plugin" });
  if (record.final !== null && record.final.plugin !== record.plugin) context.addIssue({ code: "custom", path: ["final", "plugin"], message: "final state belongs to another plugin" });
  for (const [name, projection] of [["previousProjection", record.previousProjection], ["candidateProjection", record.candidateProjection]] as const) {
    const valid = projection.kind === "active"
      ? projection.projection.plugin === record.plugin && JSON.stringify(projection.projection.scope) === JSON.stringify(record.scope)
      : projection.plugin === record.plugin && JSON.stringify(projection.scope) === JSON.stringify(record.scope);
    if (!valid) context.addIssue({ code: "custom", path: [name], message: "projection evidence does not belong to the transition target" });
  }
});
export type LifecycleTransitionRecord = z.infer<typeof LifecycleTransitionRecordSchemaV1>;

export const LifecycleTransitionStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepared") }).strict().readonly(),
  z.object({ kind: z.literal("recovery-required"), generation: GenerationSchema.optional() }).strict().readonly(),
  z.object({ kind: z.enum(["completed", "rolled-back", "abandoned"]), generation: GenerationSchema.optional() }).strict().readonly(),
  z.object({ kind: z.literal("quarantined"), code: z.literal("TRANSITION_JOURNAL_CORRUPT") }).strict().readonly(),
]);
export type LifecycleTransitionStatus = z.infer<typeof LifecycleTransitionStatusSchema>;

export const LifecycleTransitionJournalEntrySchemaV1 = z.object({
  schemaVersion: z.literal(1),
  record: LifecycleTransitionRecordSchemaV1,
  status: LifecycleTransitionStatusSchema,
  preparedAt: EpochMillisecondsSchema,
  statusAt: EpochMillisecondsSchema,
  collectionCompletedAt: EpochMillisecondsSchema.optional(),
}).strict().readonly();
export type LifecycleTransitionJournalEntryV1 = z.infer<typeof LifecycleTransitionJournalEntrySchemaV1>;

export const LifecycleUninstallCleanupStatusSchema = z.enum(["not-required", "pending-data-delete", "completed", "recovery-required"]);
export type LifecycleUninstallCleanupStatus = z.infer<typeof LifecycleUninstallCleanupStatusSchema>;

export const LifecycleTransitionJournalEntrySchemaV2 = z.object({
  schemaVersion: z.literal(2),
  record: LifecycleTransitionRecordSchemaV1,
  status: LifecycleTransitionStatusSchema,
  cleanup: LifecycleUninstallCleanupStatusSchema,
  preparedAt: EpochMillisecondsSchema,
  statusAt: EpochMillisecondsSchema,
  collectionCompletedAt: EpochMillisecondsSchema.optional(),
}).strict().readonly();
export type LifecycleTransitionJournalEntry = z.infer<typeof LifecycleTransitionJournalEntrySchemaV2>;

export function lifecycleCleanupStatus(record: LifecycleTransitionRecord, status: LifecycleTransitionStatus): LifecycleUninstallCleanupStatus {
  if (record.operation !== "uninstall" || record.retainedData !== "delete-confirmed" || status.kind === "rolled-back" || status.kind === "abandoned") return "not-required";
  return "pending-data-delete";
}

export function migrateLifecycleTransitionJournalEntryV1(input: unknown): LifecycleTransitionJournalEntry {
  const entry = LifecycleTransitionJournalEntrySchemaV1.parse(input);
  return LifecycleTransitionJournalEntrySchemaV2.parse({ ...entry, schemaVersion: 2, cleanup: lifecycleCleanupStatus(entry.record, entry.status) });
}

export const LifecycleTransitionPrepareResultSchema = z.enum(["stored", "already-present"]);
export type LifecycleTransitionPrepareResult = z.infer<typeof LifecycleTransitionPrepareResultSchema>;

export const LifecycleTransitionOutcomeSchema = z.enum(["completed", "rolled-back", "abandoned", "recovery-required"]);
export type LifecycleTransitionOutcome = z.infer<typeof LifecycleTransitionOutcomeSchema>;

export const LifecycleTransitionSettleRequestSchema = z.object({
  scope: ScopeReferenceSchema.optional(),
  reference: PendingTransitionRefSchema,
  outcome: LifecycleTransitionOutcomeSchema,
  generation: GenerationSchema.optional(),
  at: EpochMillisecondsSchema.optional(),
}).strict().readonly();
export type LifecycleTransitionSettleRequest = z.infer<typeof LifecycleTransitionSettleRequestSchema>;

export const TransitionJournalReadResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }).strict().readonly(),
  z.object({ kind: z.literal("found"), entry: LifecycleTransitionJournalEntrySchemaV2 }).strict().readonly(),
  z.object({
    kind: z.literal("corrupt"),
    code: z.literal("TRANSITION_JOURNAL_CORRUPT"),
  }).strict().readonly(),
]);
export type TransitionJournalReadResult = z.infer<typeof TransitionJournalReadResultSchema>;

export const LifecycleTransitionCollectionSchema = z.object({
  entries: z.array(LifecycleTransitionJournalEntrySchemaV2).readonly(),
  complete: z.boolean(),
  diagnostics: z.array(z.object({ code: z.literal("TRANSITION_JOURNAL_CORRUPT"), scope: ScopeReferenceSchema.optional() }).strict().readonly()).readonly(),
}).strict().readonly();
export type LifecycleTransitionCollection = z.infer<typeof LifecycleTransitionCollectionSchema>;

export type LifecycleTransitionPrepareRequest = Readonly<{
  record: LifecycleTransitionRecord;
  preparedAt: EpochMilliseconds;
}>;

export type LifecycleTransitionReferenceRequest = Readonly<{
  scope: ScopeReference;
  reference: PendingTransitionRef;
}>;

/**
 * The optional read/list methods let the first lifecycle implementation use a
 * small in-memory adapter while durable adapters expose the full recovery
 * surface. The mutation methods accept the legacy record-shaped call as well
 * so existing lifecycle integrations remain source compatible.
 */
export interface LifecycleTransitionStore {
  prepare(request: LifecycleTransitionRecord | LifecycleTransitionPrepareRequest, signal: AbortSignal): Promise<LifecycleTransitionPrepareResult>;
  settle(request: LifecycleTransitionSettleRequest, signal: AbortSignal): Promise<void>;
  read?(request: Readonly<{ scope: ScopeReference; reference: PendingTransitionRef }>, signal: AbortSignal): Promise<TransitionJournalReadResult>;
  list?(scope: ScopeReference, signal: AbortSignal): Promise<LifecycleTransitionCollection>;
  markRecoveryRequired?(request: Readonly<{ scope: ScopeReference; reference: PendingTransitionRef; generation?: Generation; at: EpochMilliseconds }>, signal: AbortSignal): Promise<"stored" | "already-present" | "terminal">;
  markCollectionComplete?(request: Readonly<{ scope: ScopeReference; reference: PendingTransitionRef; at: EpochMilliseconds }>, signal: AbortSignal): Promise<void>;
  markCleanup?(request: Readonly<{ scope: ScopeReference; reference: PendingTransitionRef; status: "completed" | "recovery-required"; at: EpochMilliseconds }>, signal: AbortSignal): Promise<"stored" | "already-present" | "terminal">;
  pruneTerminal?(request: Readonly<{ before: EpochMilliseconds }>, signal: AbortSignal): Promise<number>;
  ownerStatus?(scope: ScopeReference, reference: PendingTransitionRef, signal: AbortSignal): Promise<"live" | "dead" | "unknown" | "released">;
}

function legacyProjection(input: Readonly<{ projection?: ProjectionExpectation; previousProjection?: ProjectionExpectation; candidateProjection?: ProjectionExpectation }>): Readonly<{ previousProjection: ProjectionExpectation; candidateProjection: ProjectionExpectation }> {
  const previousProjection = input.previousProjection ?? input.projection;
  const candidateProjection = input.candidateProjection ?? input.projection;
  if (previousProjection === undefined || candidateProjection === undefined) throw new TypeError("transition projections are required");
  return { previousProjection, candidateProjection };
}

/** Construct a transition record and prove its precomputed opaque reference. */
export function createLifecycleTransitionRecord(
  input: Readonly<{
    operationId: string;
    operation: LifecycleOperation;
    origin: LifecycleOrigin;
    scope: ScopeReference;
    plugin: string;
    startingGeneration: Generation;
    previous: LifecyclePluginState | null;
    candidate: LifecyclePluginState;
    final: LifecyclePluginState | null;
    projection?: ProjectionExpectation;
    previousProjection?: ProjectionExpectation;
    candidateProjection?: ProjectionExpectation;
    retainedData: LifecycleRetainedData;
    reference?: PendingTransitionRef;
    sha256: (bytes: Uint8Array) => Uint8Array;
  }>,
): LifecycleTransitionRecord {
  const projections = legacyProjection(input);
  const value = LifecycleTransitionRecordSchemaV1.parse({
    schemaVersion: 1,
    reference: input.reference ?? "pending-transition-v1:sha256:" + "0".repeat(64),
    operationId: input.operationId,
    operation: input.operation,
    origin: input.origin,
    scope: input.scope,
    plugin: input.plugin,
    startingGeneration: input.startingGeneration,
    previous: input.previous,
    candidate: input.candidate,
    final: input.final,
    ...projections,
    retainedData: input.retainedData,
  });
  const expected = deriveLifecyclePendingTransitionRef({
    operationId: value.operationId,
    scope: value.scope,
    plugin: value.plugin,
    startingGeneration: value.startingGeneration,
  }, input.sha256);
  if (input.reference !== undefined && input.reference !== expected) throw new Error("lifecycle transition reference does not match its identity");
  return LifecycleTransitionRecordSchemaV1.parse({ ...value, reference: expected });
}

export type {
  EpochMilliseconds,
  Generation,
  LifecycleOperation,
  LifecycleOrigin,
  LifecyclePluginState,
  LifecycleRetainedData,
  PluginKey,
  PendingTransitionRef,
  ProjectionExpectation,
  ScopeReference,
};
