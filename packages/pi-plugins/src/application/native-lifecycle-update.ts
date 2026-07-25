import { z } from "zod";
import { SourceHashSchema } from "../domain/source.js";
import { StableSourceIdentitySchema, UpdateCandidateKeySchema, deriveMarketplaceSourceIdentity, derivePluginSourceIdentity, deriveUpdateCandidateKey } from "../domain/update-policy.js";
import { NativeInstalledOperationTargetRequestSchema, NativeLifecycleTargetBindingSchema } from "./native-lifecycle-operation-contract.js";
import { PreparedLifecycleCandidateBindingSchema } from "./trusted-install-contract.js";
import { decodeInspectionDetailId } from "./native-inspection-identifiers.js";
import type { PreparedLifecycleCandidate, PreparedLifecycleCandidateService } from "./prepared-lifecycle-candidate.js";
import type { VerifiedNativeLifecycleTarget, NativeLifecycleTargetService } from "./native-lifecycle-target.js";
import type { CandidateContentCleanupRecovery } from "./ports/candidate-content-lease.js";
import type { Sha256 } from "../domain/source.js";

export const PreparedUpdateBindingSchema = z.object({
  target: NativeLifecycleTargetBindingSchema,
  candidate: PreparedLifecycleCandidateBindingSchema,
  updateCandidate: UpdateCandidateKeySchema,
  installedSourceIdentity: StableSourceIdentitySchema,
  candidateMarketplaceSourceIdentity: SourceHashSchema,
  candidatePluginSourceIdentity: SourceHashSchema,
}).strict().readonly();
export type PreparedUpdateBinding = z.infer<typeof PreparedUpdateBindingSchema>;

export type PreparedNativeLifecycleUpdate = Readonly<{
  target: VerifiedNativeLifecycleTarget;
  candidate: PreparedLifecycleCandidate;
  binding: PreparedUpdateBinding;
}>;

export type NativeLifecycleUpdatePreparationResult =
  | Readonly<{ kind: "ready"; update: PreparedNativeLifecycleUpdate }>
  | Readonly<{ kind: "current-state"; reason: "revision-current"; target: VerifiedNativeLifecycleTarget }>
  | Readonly<{ kind: "stale"; reason: "inspection" | "target" | "candidate" | "project" | "capability" }>
  | Readonly<{ kind: "blocked"; reason: "pending-transition" | "recovery-required" }>
  | Readonly<{ kind: "cleanup-failed"; cleanup: CandidateContentCleanupRecovery }>
  | Readonly<{ kind: "unavailable" | "rejected"; reason: "candidate" | "target" }>;

export interface NativeLifecycleUpdateService {
  acquire(request: Readonly<{
    target: z.infer<typeof NativeInstalledOperationTargetRequestSchema>;
    candidate: z.infer<typeof NativeInstalledOperationTargetRequestSchema>;
  }>, signal: AbortSignal): Promise<NativeLifecycleUpdatePreparationResult>;
  validate(update: PreparedNativeLifecycleUpdate, signal: AbortSignal): Promise<NativeLifecycleUpdatePreparationResult>;
}

function mapTarget(result: Exclude<Awaited<ReturnType<NativeLifecycleTargetService["resolve"]>>, { kind: "ready" }>): NativeLifecycleUpdatePreparationResult {
  if (result.kind === "stale") return { kind: "stale", reason: result.reason === "inspection" ? "inspection" : result.reason === "project" ? "project" : result.reason === "capability" ? "capability" : "target" };
  if (result.kind === "blocked") return { kind: "blocked", reason: result.reason === "pending-transition" ? "pending-transition" : "recovery-required" };
  return { kind: "unavailable", reason: "target" };
}

function sourceBinding(target: VerifiedNativeLifecycleTarget, candidate: PreparedLifecycleCandidate, sha256: Sha256): PreparedUpdateBinding | undefined {
  const selected = target.record.revisions.find((revision) => revision.revision === target.record.selectedRevision);
  if (selected === undefined) return undefined;
  const installedSourceIdentity = selected.evidence.source.pluginSourceIdentity;
  if (installedSourceIdentity === undefined) return undefined;
  const candidateMarketplaceSourceIdentity = deriveMarketplaceSourceIdentity(candidate.resolved.marketplace.source.declared, sha256);
  const candidatePluginSourceIdentity = derivePluginSourceIdentity(candidate.resolved.entry.source.value, sha256);
  // A manual update is never a source-identity migration under old consent.
  if (selected.evidence.source.marketplaceSourceIdentity !== candidateMarketplaceSourceIdentity || installedSourceIdentity !== candidatePluginSourceIdentity) return undefined;
  const updateCandidate = deriveUpdateCandidateKey({
    scope: candidate.binding.scope,
    plugin: candidate.binding.plugin,
    marketplaceSourceIdentity: candidateMarketplaceSourceIdentity,
    pluginSourceIdentity: candidatePluginSourceIdentity,
    immutableRevision: candidate.binding.immutableRevision,
  }, sha256);
  return PreparedUpdateBindingSchema.parse({
    target: target.binding,
    candidate: candidate.binding,
    updateCandidate,
    installedSourceIdentity,
    candidateMarketplaceSourceIdentity,
    candidatePluginSourceIdentity,
  });
}

export function createNativeLifecycleUpdateService(input: Readonly<{
  targets: NativeLifecycleTargetService;
  candidates: PreparedLifecycleCandidateService;
  sha256: Sha256;
}>): NativeLifecycleUpdateService {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") throw new TypeError("native lifecycle update dependencies are required");

  async function acquire(requestInput: Parameters<NativeLifecycleUpdateService["acquire"]>[0], signal: AbortSignal): Promise<NativeLifecycleUpdatePreparationResult> {
    signal.throwIfAborted();
    const request = {
      target: NativeInstalledOperationTargetRequestSchema.parse(requestInput.target),
      candidate: NativeInstalledOperationTargetRequestSchema.parse(requestInput.candidate),
    };
    if (request.target.inspectionSnapshotId !== request.candidate.inspectionSnapshotId) return { kind: "stale", reason: "inspection" };
    const targetResult = await input.targets.resolve(request.target, signal);
    if (targetResult.kind !== "ready") return mapTarget(targetResult);
    const subject = decodeInspectionDetailId(request.candidate.detailId, input.sha256);
    if (subject === undefined || subject.subject !== "marketplace-candidate" || subject.plugin !== targetResult.target.binding.plugin ||
        JSON.stringify(subject.scope) !== JSON.stringify(targetResult.target.binding.scope)) return { kind: "stale", reason: "candidate" };
    const candidateResult = await input.candidates.acquire({ subject, snapshot: targetResult.target.snapshot }, signal);
    if (candidateResult.kind === "cleanup-failed") return { kind: "cleanup-failed", cleanup: candidateResult.cleanup };
    if (candidateResult.kind !== "ready") {
      return candidateResult.kind === "stale"
        ? { kind: "stale", reason: "candidate" }
        : { kind: candidateResult.kind, reason: "candidate" };
    }
    const candidate = candidateResult.candidate;
    if (candidate.binding.immutableRevision === targetResult.target.binding.selectedRevision) {
      await candidate.lease.release();
      return { kind: "current-state", reason: "revision-current", target: targetResult.target };
    }
    const binding = sourceBinding(targetResult.target, candidate, input.sha256);
    if (binding === undefined) {
      await candidate.lease.release();
      return { kind: "stale", reason: "candidate" };
    }
    return { kind: "ready", update: Object.freeze({ target: targetResult.target, candidate, binding }) };
  }

  async function validate(update: PreparedNativeLifecycleUpdate, signal: AbortSignal): Promise<NativeLifecycleUpdatePreparationResult> {
    const target = await input.targets.validate(update.target, signal);
    if (target.kind !== "ready") return mapTarget(target);
    if (await input.candidates.validate(update.candidate, signal) !== "current") return { kind: "stale", reason: "candidate" };
    if (update.candidate.binding.immutableRevision === target.target.binding.selectedRevision) return { kind: "current-state", reason: "revision-current", target: target.target };
    const binding = sourceBinding(target.target, update.candidate, input.sha256);
    if (binding === undefined || JSON.stringify({ ...binding, target: update.binding.target }) !== JSON.stringify(update.binding)) return { kind: "stale", reason: "candidate" };
    return { kind: "ready", update: Object.freeze({ target: target.target, candidate: update.candidate, binding: update.binding }) };
  }

  return Object.freeze({ acquire, validate });
}
