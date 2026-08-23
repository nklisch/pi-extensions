import { createExactTrustGrantService } from "../application/exact-trust-grant-service.js";
import { createNativeLifecycleOperationExecutor } from "../application/native-lifecycle-operation.js";
import { createNativeLifecycleOperationService } from "../application/native-lifecycle-operation-service.js";
import { createNativeLifecycleTargetService } from "../application/native-lifecycle-target.js";
import { createNativeLifecycleUpdateService } from "../application/native-lifecycle-update.js";
import { createProjectSyncService } from "../application/project-sync-service.js";
import {
  createPreparedLifecycleCandidateService,
  type PreparedLifecycleCandidate,
} from "../application/prepared-lifecycle-candidate.js";
import { createTrustedInstallConfigurationAuthority } from "../application/trusted-install-configuration.js";
import type { BoundPluginConfigurationService } from "../application/configuration-service.js";
import type { CandidateContentLeasePort } from "../application/ports/candidate-content-lease.js";
import type { ConfigurationPathPort } from "../application/ports/configuration-path.js";
import type { LifecycleClock } from "../application/ports/lifecycle-clock.js";
import type { LifecycleOperationIdPort } from "../application/ports/lifecycle-operation-id.js";
import type { LifecycleStateStore } from "../application/ports/lifecycle-state-store.js";
import type { NativeInspectionEvidencePort } from "../application/ports/native-inspection-evidence.js";
import type { PluginConfigurationStore } from "../application/ports/plugin-configuration-store.js";
import type { ProjectIntentFilePort } from "../application/ports/project-intent-file.js";
import type { ProjectIntentWriteIdPort } from "../application/ports/project-intent-write-id.js";
import type { ProjectRootAuthorityPort, TrustedProjectRoot } from "../application/ports/project-root-authority.js";
import type { ProjectTrustPort } from "../application/ports/project-trust.js";
import type { InspectionReadinessPort } from "../application/ports/inspection-readiness.js";
import type { PluginInspectionService } from "../application/inspection-service.js";
import type { MarketplaceCatalogService } from "../application/marketplace-catalog-service.js";
import type { PluginLifecycleComposition, PluginLifecycleResult } from "../application/plugin-lifecycle-service.js";
import type { MarketplaceRegistrationService } from "../application/marketplace-registration-service.js";
import type { ProjectSyncReadinessSnapshot } from "../application/project-sync-projection.js";
import type { ProjectGenerationSnapshot } from "../application/state-contract.js";
import type { HostCapabilityStatus } from "../application/host-observation-contract.js";
import type { ContentDigest } from "../domain/content-manifest.js";
import type { Sha256 } from "../domain/source.js";
import { marketplaceUpdateRecords } from "../application/marketplace-update-state.js";
import type { CandidateInspectionDetailSubject } from "../application/native-inspection-identifiers.js";

/** Private packaged wiring over the existing lifecycle/state authorities. */
export function createComposedNativeLifecycleOperationService(input: Readonly<{
  catalog: Pick<MarketplaceCatalogService, "resolve" | "search">;
  candidateContent: CandidateContentLeasePort;
  inspector: PluginInspectionService;
  readiness: InspectionReadinessPort;
  syncReadiness(snapshot: ProjectGenerationSnapshot, signal: AbortSignal): Promise<ProjectSyncReadinessSnapshot>;
  evidence: NativeInspectionEvidencePort;
  configuration: BoundPluginConfigurationService;
  configurations: PluginConfigurationStore;
  configurationPaths: ConfigurationPathPort;
  secretCustody: HostCapabilityStatus;
  userBaseDirectory: string;
  state: LifecycleStateStore;
  mutations: LifecycleStateStore;
  projectTrust: ProjectTrustPort;
  projectRoots: ProjectRootAuthorityPort;
  projectFiles: ProjectIntentFilePort;
  projectWriteIds: ProjectIntentWriteIdPort;
  registrations: Pick<MarketplaceRegistrationService, "remove">;
  lifecycle: PluginLifecycleComposition;
  clock: LifecycleClock;
  sessionIds: LifecycleOperationIdPort;
  hostEpoch: ContentDigest;
  sha256: Sha256;
}>) {
  const candidate = createPreparedLifecycleCandidateService({ catalog: input.catalog, content: input.candidateContent, inspector: input.inspector, readiness: input.readiness, sha256: input.sha256 });
  const configurationAuthority = createTrustedInstallConfigurationAuthority({ configurations: input.configurations, sha256: input.sha256 });
  const trust = createExactTrustGrantService({ state: input.state, mutations: input.mutations, projectTrust: input.projectTrust, projectRoots: input.projectRoots, sha256: input.sha256 });
  const targets = createNativeLifecycleTargetService({ evidence: input.evidence, sha256: input.sha256 });
  const updates = createNativeLifecycleUpdateService({ targets, candidates: candidate, sha256: input.sha256 });
  const configurationInput = (candidateValue: PreparedLifecycleCandidate, projectRoot: TrustedProjectRoot | undefined) => {
    const scope = candidateValue.resolved.scope;
    const pathContext = scope.kind === "project"
      ? { scope, trustedProjectRoot: projectRoot! }
      : { scope, trustedBaseDirectory: input.userBaseDirectory };
    return { pathContext, paths: input.configurationPaths, secretCustody: input.secretCustody };
  };
  const repair = async (target: import("../application/native-lifecycle-target.js").VerifiedNativeLifecycleTarget, signal: AbortSignal) => {
    const notices = target.snapshot.states
      .flatMap((state) => state.ok && JSON.stringify(state.snapshot.scope) === JSON.stringify(target.scope)
        ? marketplaceUpdateRecords(state.snapshot).flatMap((record) => record.notices)
        : [])
      .filter((notice) => notice.plugin === target.binding.plugin && notice.available.immutableRevision === target.binding.selectedRevision)
      .sort((left, right) => right.discoveredAt - left.discoveredAt);
    let subject: CandidateInspectionDetailSubject;
    const notice = notices[0];
    if (notice !== undefined) {
      subject = {
        version: 1 as const,
        subject: "marketplace-candidate" as const,
        scope: target.binding.scope,
        plugin: notice.plugin,
        registrationId: notice.registrationId as never,
        candidateId: notice.candidateId as never,
        catalogSnapshot: notice.snapshot as never,
      };
    } else {
      // Repair is valid even after the update notice has been resolved. Search
      // the selected local catalog again instead of treating the absence of a
      // notification as source drift; the installed record remains the
      // authority for the revision being repaired.
      const page = await input.catalog.search({
        scope: target.binding.scope.kind === "user" ? "user" : "project",
        query: target.binding.plugin,
        limit: 100,
      }, signal);
      const candidate = page.candidates.find((entry) => entry.plugin === target.binding.plugin);
      if (candidate === undefined) return { kind: "rejected", operation: "repair", code: "AVAILABLE_REVISION_CHANGED" } as PluginLifecycleResult;
      subject = {
        version: 1 as const,
        subject: "marketplace-candidate" as const,
        scope: target.binding.scope,
        plugin: candidate.plugin as never,
        registrationId: candidate.registrationId as never,
        candidateId: candidate.id as never,
        catalogSnapshot: candidate.snapshot as never,
      };
    }
    // Repair validates the selected source again in the lifecycle service;
    // resolving the catalog candidate here is enough to recover its materializer
    // context. Candidate acquisition is intentionally skipped because it also
    // requires a current inspection snapshot and can reject a valid repair
    // merely because the update notice was already resolved.
    const resolved = await input.catalog.resolve({ candidateId: subject.candidateId, snapshot: subject.catalogSnapshot }, signal);
    if (resolved.kind !== "resolved") return { kind: "rejected", operation: "repair", code: resolved.kind === "candidate-stale" ? "AVAILABLE_REVISION_CHANGED" : "MALFORMED" } as PluginLifecycleResult;
    const value = resolved.candidate;
    const root = target.scope.kind === "project" ? await input.projectRoots.acquire(signal) : undefined;
    const configurationPathContext = target.scope.kind === "project"
      ? { scope: target.scope, trustedProjectRoot: root! }
      : { scope: target.scope, trustedBaseDirectory: input.userBaseDirectory };
    const sourceContext = value.entry.source.value.kind === "marketplace-path"
      ? { kind: "marketplace" as const, root: value.marketplace.root, source: value.marketplace.source, contentRootDigest: value.marketplace.content.rootDigest, content: value.marketplace.content, binding: value.marketplace.binding }
      : { kind: "external" as const };
    return input.lifecycle.application.repair({
      scope: target.scope,
      plugin: target.binding.plugin,
      entry: value.entry,
      marketplaceSource: value.marketplace.source,
      sourceContext,
      configurationPathContext,
    }, signal);
  };

  const executor = createNativeLifecycleOperationExecutor({
    targets,
    updates,
    lifecycle: input.lifecycle,
    configuration: input.configuration,
    configurationAuthority,
    configurationInput,
    configurationPathContext(target, projectRoot) {
      return target.scope.kind === "project"
        ? { scope: target.scope, trustedProjectRoot: projectRoot! }
        : { scope: target.scope, trustedBaseDirectory: input.userBaseDirectory };
    },
    trust,
    evidence: input.evidence,
    projectRoots: input.projectRoots,
    sha256: input.sha256,
    repair,
  });
  const sync = createProjectSyncService({
    state: input.state,
    mutations: input.mutations,
    projectRoots: input.projectRoots,
    projectTrust: input.projectTrust,
    files: input.projectFiles,
    writeIds: input.projectWriteIds,
    lifecycle: input.lifecycle.application,
    registrations: input.registrations,
    configurationPathContext(root, snapshot) { return { scope: snapshot.scope, trustedProjectRoot: root }; },
    readiness: input.syncReadiness,
    sha256: input.sha256,
  });
  const service = createNativeLifecycleOperationService({ targets, updates, lifecycle: executor, configurationAuthority, sync, clock: input.clock, sessionIds: input.sessionIds, hostEpoch: input.hostEpoch, sha256: input.sha256 });
  return Object.freeze({ ...service, candidate });
}
