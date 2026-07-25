import { z } from "zod";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { ScopeReferenceSchema, type ScopeReference } from "../domain/state/scope.js";
import {
  GenerationSchema,
  type Generation,
} from "../domain/state/config-state.js";
import {
  InstalledPluginRecordSchema,
  type InstalledPluginRecord,
} from "../domain/state/installed-state.js";
export { LifecycleTargetExpectationSchema } from "./native-lifecycle-operation-contract.js";
export type { LifecycleTargetExpectation } from "./native-lifecycle-operation-contract.js";
import {
  PendingTransitionRefSchema,
  derivePendingTransitionRef,
  type PendingTransitionRef,
} from "../domain/state/references.js";

/** The lifecycle operation registry is the source for operation variants. */
export const LifecycleOperationRegistry = {
  install: { changesActivation: true },
  enable: { changesActivation: true },
  disable: { changesActivation: true },
  update: { changesActivation: true },
  uninstall: { changesActivation: true },
} as const;

export type LifecycleOperation = keyof typeof LifecycleOperationRegistry;
const lifecycleOperations = Object.keys(LifecycleOperationRegistry) as [
  LifecycleOperation,
  ...LifecycleOperation[],
];
export const LifecycleOperationSchema = z.enum(lifecycleOperations);

export const LifecycleOriginRegistry = {
  manual: { tag: "manual" },
  automaticUpdate: { tag: "automatic-update" },
  sync: { tag: "sync" },
  adoption: { tag: "adoption" },
} as const;
export type LifecycleOrigin = (typeof LifecycleOriginRegistry)[keyof typeof LifecycleOriginRegistry]["tag"];
const lifecycleOrigins = Object.values(LifecycleOriginRegistry).map((entry) => entry.tag) as [
  LifecycleOrigin,
  ...LifecycleOrigin[],
];
export const LifecycleOriginSchema = z.enum(lifecycleOrigins);

export const LifecycleRetainedDataRegistry = {
  keep: { tag: "keep" },
  deleteConfirmed: { tag: "delete-confirmed" },
} as const;
export type LifecycleRetainedData = (typeof LifecycleRetainedDataRegistry)[keyof typeof LifecycleRetainedDataRegistry]["tag"];
const retainedDataValues = Object.values(LifecycleRetainedDataRegistry).map((entry) => entry.tag) as [
  LifecycleRetainedData,
  ...LifecycleRetainedData[],
];
export const LifecycleRetainedDataSchema = z.enum(retainedDataValues);

/** Public, typed rejection reasons. Native adapter errors never cross this contract. */
export const LifecycleRejectionCodeRegistry = {
  invalidRequest: { tag: "INVALID_REQUEST" },
  notInstalled: { tag: "NOT_INSTALLED" },
  alreadyInstalled: { tag: "ALREADY_INSTALLED" },
  wrongActivation: { tag: "WRONG_ACTIVATION" },
  pendingTransition: { tag: "PENDING_TRANSITION" },
  incompatible: { tag: "INCOMPATIBLE" },
  untrusted: { tag: "UNTRUSTED" },
  unconfigured: { tag: "UNCONFIGURED" },
  malformed: { tag: "MALFORMED" },
  projectionFailed: { tag: "PROJECTION_FAILED" },
  promotionFailed: { tag: "PROMOTION_FAILED" },
  aborted: { tag: "ABORTED" },
  availableRevisionChanged: { tag: "AVAILABLE_REVISION_CHANGED" },
  configurationStale: { tag: "CONFIGURATION_STALE" },
} as const;
export type LifecycleRejectionCode = (typeof LifecycleRejectionCodeRegistry)[keyof typeof LifecycleRejectionCodeRegistry]["tag"];
const lifecycleRejectionCodes = Object.values(LifecycleRejectionCodeRegistry).map((entry) => entry.tag) as [
  LifecycleRejectionCode,
  ...LifecycleRejectionCode[],
];
export const LifecycleRejectionCodeSchema = z.enum(lifecycleRejectionCodes);

export const LifecycleOutcomeRegistry = {
  changed: { tag: "changed" },
  unchanged: { tag: "unchanged" },
  rejected: { tag: "rejected" },
  stale: { tag: "stale" },
  rolledBack: { tag: "rolled-back" },
  recoveryRequired: { tag: "recovery-required" },
} as const;
export type LifecycleOutcome = (typeof LifecycleOutcomeRegistry)[keyof typeof LifecycleOutcomeRegistry]["tag"];
const lifecycleOutcomeValues = Object.values(LifecycleOutcomeRegistry).map((entry) => entry.tag) as [
  LifecycleOutcome,
  ...LifecycleOutcome[],
];
export const LifecycleOutcomeSchema = z.enum(lifecycleOutcomeValues);

/** Installed state with the opaque in-flight marker removed. */
export const LifecyclePluginStateSchema = InstalledPluginRecordSchema.unwrap().omit({
  pendingTransition: true,
}).readonly();
export type LifecyclePluginState = z.infer<typeof LifecyclePluginStateSchema>;

export const LifecyclePluginReferenceSchema = z.object({
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
}).strict().readonly();
export type LifecyclePluginReference = z.infer<typeof LifecyclePluginReferenceSchema>;

export const PendingTransitionIdentitySchema = z.object({
  operationId: z.string().uuid(),
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  startingGeneration: GenerationSchema,
}).strict().readonly();
export type PendingTransitionIdentity = z.infer<typeof PendingTransitionIdentitySchema>;

/**
 * Derive the opaque marker from evidence that exists before the transition
 * record is written. Keeping this identity separate avoids a self-referential
 * transition-record hash.
 */
export function deriveLifecyclePendingTransitionRef(
  input: PendingTransitionIdentity,
  sha256: (bytes: Uint8Array) => Uint8Array,
): PendingTransitionRef {
  const value = PendingTransitionIdentitySchema.parse(input);
  return derivePendingTransitionRef(value, sha256);
}

/** A request shared by the facade's operation-specific request schemas. */
export const LifecyclePluginRequestSchema = z.object({
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  origin: LifecycleOriginSchema.default("manual"),
}).strict().readonly();
export type LifecyclePluginRequest = z.infer<typeof LifecyclePluginRequestSchema>;

/** Safe evidence used by callers that need to report an unresolved transition. */
export const LifecycleRecoveryEvidenceSchema = z.object({
  operation: LifecycleOperationSchema,
  transition: PendingTransitionRefSchema,
  committed: GenerationSchema.optional(),
}).strict().readonly();
export type LifecycleRecoveryEvidence = z.infer<typeof LifecycleRecoveryEvidenceSchema>;

export type {
  Generation,
  InstalledPluginRecord,
  PendingTransitionRef,
  PluginKey,
  ScopeReference,
};
