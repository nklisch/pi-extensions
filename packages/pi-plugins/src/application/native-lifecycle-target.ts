import { canonicalJson } from "../domain/canonical-json.js";
import { hashContent } from "../domain/content-manifest.js";
import { InstalledPluginRecordSchema, type InstalledPluginRecord } from "../domain/state/installed-state.js";
import { toScopeReference, type ScopeContext, type ScopeReference } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import {
  LifecycleTargetExpectationSchema,
  NativeInstalledOperationTargetRequestSchema,
  NativeLifecycleTargetBindingSchema,
  type LifecycleTargetExpectation,
  type NativeInstalledOperationTargetRequest,
  type NativeLifecycleTargetBinding,
} from "./native-lifecycle-operation-contract.js";
import { decodeInspectionDetailId, deriveInspectionEvidenceSnapshotId } from "./native-inspection-identifiers.js";
import type { InspectionEvidenceSnapshot, NativeInspectionEvidencePort } from "./ports/native-inspection-evidence.js";

const encoder = new TextEncoder();

export function deriveLifecycleTargetDigest(
  scope: ScopeReference,
  recordInput: InstalledPluginRecord,
  sha256: Sha256,
) {
  const record = InstalledPluginRecordSchema.parse(recordInput);
  if (record.pendingTransition !== undefined) throw new Error("pending lifecycle targets cannot be bound");
  return hashContent(encoder.encode(`native-lifecycle-target-v1\0${canonicalJson({ scope, record })}`), sha256);
}

export type VerifiedNativeLifecycleTarget = Readonly<{
  binding: NativeLifecycleTargetBinding;
  expectation: LifecycleTargetExpectation;
  scope: ScopeContext;
  record: InstalledPluginRecord;
  snapshot: InspectionEvidenceSnapshot;
  capabilityDigest: string;
  projectEpoch?: string;
}>;

export type NativeLifecycleTargetResolution =
  | Readonly<{ kind: "ready"; target: VerifiedNativeLifecycleTarget }>
  | Readonly<{ kind: "current-state" | "stale" | "blocked" | "unavailable"; reason: "inspection" | "target" | "project" | "capability" | "pending-transition" | "recovery-required" }>;

export interface NativeLifecycleTargetService {
  resolve(request: NativeInstalledOperationTargetRequest, signal: AbortSignal): Promise<NativeLifecycleTargetResolution>;
  validate(target: VerifiedNativeLifecycleTarget, signal: AbortSignal): Promise<NativeLifecycleTargetResolution>;
}

function sameScope(left: ScopeReference, right: ScopeReference): boolean {
  return left.kind === right.kind && (left.kind === "user" || (right.kind === "project" && left.projectKey === right.projectKey));
}

function findRecord(snapshot: InspectionEvidenceSnapshot, scope: ScopeReference, plugin: string): Readonly<{ scope: ScopeContext; record: InstalledPluginRecord }> | undefined {
  const state = snapshot.states.find((candidate) => candidate.ok && sameScope(toScopeReference(candidate.snapshot.scope), scope));
  if (state === undefined || !state.ok) return undefined;
  const records = "installed" in state.snapshot ? state.snapshot.installed.plugins : state.snapshot.project.plugins;
  const record = records.find((candidate) => candidate.plugin === plugin);
  return record === undefined ? undefined : { scope: state.snapshot.scope, record };
}

function recoveryBlocked(snapshot: InspectionEvidenceSnapshot, _scope: ScopeReference, plugin: string): boolean {
  // Raw startup-recovery results describe the instant a successor began. An
  // exact reload handoff can settle that transition immediately afterward, so
  // only the host's published unresolved block set remains current authority.
  return snapshot.startup.blocked.some((entry) => entry.plugin === plugin);
}

function buildTarget(
  request: NativeInstalledOperationTargetRequest,
  snapshot: InspectionEvidenceSnapshot,
  scope: ScopeContext,
  record: InstalledPluginRecord,
  sha256: Sha256,
): VerifiedNativeLifecycleTarget {
  const scopeReference = toScopeReference(scope);
  const targetDigest = deriveLifecycleTargetDigest(scopeReference, record, sha256);
  const scopeBinding = snapshot.binding.scopes.find((candidate) => sameScope(candidate.scope, scopeReference));
  if (scopeBinding?.generation === undefined || snapshot.binding.capability.status !== "ready" || snapshot.binding.capability.digest === undefined) {
    throw new Error("target authority is unavailable");
  }
  const projectEpoch = scopeReference.kind === "project" ? snapshot.binding.currentProject.epoch : undefined;
  const binding = NativeLifecycleTargetBindingSchema.parse({
    scope: scopeReference,
    plugin: record.plugin,
    stateGeneration: scopeBinding.generation,
    selectedRevision: record.selectedRevision,
    activation: record.activation,
    targetDigest,
    inspectionSnapshotId: request.inspectionSnapshotId,
    detailId: request.detailId,
    ...(projectEpoch === undefined ? {} : { projectEpoch }),
    transition: "none",
  });
  const expectation = LifecycleTargetExpectationSchema.parse({
    generation: scopeBinding.generation,
    plugin: record.plugin,
    selectedRevision: record.selectedRevision,
    activation: record.activation,
    targetDigest,
    pendingTransition: "none",
  });
  return Object.freeze({ binding, expectation, scope, record, snapshot, capabilityDigest: snapshot.binding.capability.digest, ...(projectEpoch === undefined ? {} : { projectEpoch }) });
}

export function createNativeLifecycleTargetService(input: Readonly<{
  evidence: NativeInspectionEvidencePort;
  sha256: Sha256;
}>): NativeLifecycleTargetService {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") throw new TypeError("native lifecycle target dependencies are required");

  async function resolve(requestInput: NativeInstalledOperationTargetRequest, signal: AbortSignal): Promise<NativeLifecycleTargetResolution> {
    signal.throwIfAborted();
    const request = NativeInstalledOperationTargetRequestSchema.parse(requestInput);
    const subject = decodeInspectionDetailId(request.detailId, input.sha256);
    if (subject === undefined || subject.subject !== "installed") return { kind: "stale", reason: "inspection" };
    const snapshot = await input.evidence.capture(signal);
    if (deriveInspectionEvidenceSnapshotId(snapshot.binding, input.sha256) !== request.inspectionSnapshotId) return { kind: "stale", reason: "inspection" };
    if (snapshot.binding.capability.status !== "ready" || snapshot.binding.capability.digest === undefined) return { kind: "unavailable", reason: "capability" };
    if (subject.scope.kind === "project" && (snapshot.binding.currentProject.projectKey !== subject.scope.projectKey || snapshot.binding.currentProject.trust.kind !== "trusted")) {
      return { kind: "stale", reason: "project" };
    }
    const authority = findRecord(snapshot, subject.scope, subject.plugin);
    if (authority === undefined || authority.record.selectedRevision !== subject.selectedRevision) return { kind: "stale", reason: "target" };
    if (authority.record.pendingTransition !== undefined) return { kind: "blocked", reason: "pending-transition" };
    if (recoveryBlocked(snapshot, subject.scope, subject.plugin)) return { kind: "blocked", reason: "recovery-required" };
    try { return { kind: "ready", target: buildTarget(request, snapshot, authority.scope, authority.record, input.sha256) }; }
    catch { return { kind: "unavailable", reason: "capability" }; }
  }

  async function validate(target: VerifiedNativeLifecycleTarget, signal: AbortSignal): Promise<NativeLifecycleTargetResolution> {
    signal.throwIfAborted();
    const snapshot = await input.evidence.capture(signal);
    if (snapshot.binding.capability.status !== "ready" || snapshot.binding.capability.digest !== target.capabilityDigest) return { kind: "stale", reason: "capability" };
    if (target.binding.scope.kind === "project") {
      if (snapshot.binding.currentProject.projectKey !== target.binding.scope.projectKey || snapshot.binding.currentProject.trust.kind !== "trusted" || snapshot.binding.currentProject.epoch !== target.projectEpoch) {
        return { kind: "stale", reason: "project" };
      }
    }
    const authority = findRecord(snapshot, target.binding.scope, target.binding.plugin);
    if (authority === undefined) return { kind: "stale", reason: "target" };
    if (authority.record.pendingTransition !== undefined) return { kind: "blocked", reason: "pending-transition" };
    if (recoveryBlocked(snapshot, target.binding.scope, target.binding.plugin)) return { kind: "blocked", reason: "recovery-required" };
    const digest = deriveLifecycleTargetDigest(target.binding.scope, authority.record, input.sha256);
    if (digest !== target.binding.targetDigest || authority.record.selectedRevision !== target.binding.selectedRevision || authority.record.activation !== target.binding.activation) {
      return { kind: "stale", reason: "target" };
    }
    // Unrelated generation changes rebase only after exact target/project/capability equality.
    return { kind: "ready", target: buildTarget({ inspectionSnapshotId: target.binding.inspectionSnapshotId, detailId: target.binding.detailId }, snapshot, authority.scope, authority.record, input.sha256) };
  }

  return Object.freeze({ resolve, validate });
}
