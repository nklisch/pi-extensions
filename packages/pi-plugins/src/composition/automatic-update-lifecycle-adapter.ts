import { deriveMarketplaceSourceIdentity, derivePluginSourceIdentity, type UpdateNotice } from "../domain/update-policy.js";
import { MarketplaceCandidateIdSchema, MarketplaceRegistrationIdSchema, MarketplaceSnapshotTokenSchema } from "../domain/marketplace-registration.js";
import { toScopeReference, type ScopeContext } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { MarketplaceCatalogService } from "../application/marketplace-catalog-service.js";
import { deriveInspectionDetailId, deriveInspectionEvidenceSnapshotId } from "../application/native-inspection-identifiers.js";
import { deriveLifecycleTargetDigest } from "../application/native-lifecycle-target.js";
import { LifecycleTargetExpectationSchema } from "../application/native-lifecycle-operation-contract.js";
import type { NativeInspectionService } from "../application/native-inspection-contract.js";
import type { NativeInspectionEvidencePort } from "../application/ports/native-inspection-evidence.js";
import type { LifecycleStateStore } from "../application/ports/lifecycle-state-store.js";
import type { ProjectRootAuthorityPort } from "../application/ports/project-root-authority.js";
import type { ProjectTrustPort } from "../application/ports/project-trust.js";
import type { PluginLifecycleService } from "../application/plugin-lifecycle-service.js";
import type { AutomaticUpdateLifecyclePort, AutomaticUpdateLifecycleResult } from "../application/ports/automatic-update-lifecycle.js";

export function createAutomaticUpdateLifecycleAdapter(dependencies: Readonly<{
  state: LifecycleStateStore;
  catalog: Pick<MarketplaceCatalogService, "resolve">;
  inspection: NativeInspectionService;
  evidence: NativeInspectionEvidencePort;
  lifecycle: PluginLifecycleService;
  projectTrust: ProjectTrustPort;
  projectRoots: ProjectRootAuthorityPort;
  currentProject?: Extract<ScopeContext, { kind: "project" }>;
  userBaseDirectory: string;
  sha256: Sha256;
}>): AutomaticUpdateLifecyclePort {
  function context(notice: UpdateNotice): ScopeContext | undefined {
    return notice.scope.kind === "user" ? { kind: "user" } : dependencies.currentProject?.projectKey === notice.scope.projectKey ? dependencies.currentProject : undefined;
  }

  async function target(notice: UpdateNotice, signal: AbortSignal) {
    const scope = context(notice);
    if (scope === undefined) return undefined;
    if (!await projectAuthorized(scope, signal)) return { unauthorized: true as const, scope };
    const loaded = await dependencies.state.read(scope, signal);
    if (!loaded.ok) return undefined;
    const records = "installed" in loaded.snapshot ? loaded.snapshot.installed.plugins : loaded.snapshot.project.plugins;
    const record = records.find((candidate) => candidate.plugin === notice.plugin);
    return record === undefined ? undefined : { scope, snapshot: loaded.snapshot, record };
  }

  async function resolve(notice: UpdateNotice, signal: AbortSignal) {
    return dependencies.catalog.resolve({
      candidateId: MarketplaceCandidateIdSchema.parse(notice.candidateId),
      snapshot: MarketplaceSnapshotTokenSchema.parse(notice.snapshot),
    }, signal);
  }

  async function projectAuthorized(scope: ScopeContext, signal: AbortSignal): Promise<boolean> {
    if (scope.kind === "user") return true;
    try {
      if ((await dependencies.projectTrust.assess(scope.projectKey, signal)).kind !== "trusted") return false;
      const root = await dependencies.projectRoots.acquire(signal);
      const current = dependencies.projectRoots.revalidate === undefined
        ? dependencies.projectRoots.verify(root, scope)
        : await dependencies.projectRoots.revalidate(root, scope, signal);
      return current.kind === "project" && current.projectKey === scope.projectKey;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return false;
    }
  }

  const port: AutomaticUpdateLifecyclePort = {
    async inspect(notice, signal) {
      const [resolved, current] = await Promise.all([resolve(notice, signal), target(notice, signal)]);
      if (resolved.kind !== "resolved") return { candidate: "stale", source: "stable", target: "current", project: "trusted", recovery: "clear", configuration: "valid", secrets: "available", capability: "available" };
      const candidate = resolved.candidate;
      if (current !== undefined && "unauthorized" in current) {
        return { candidate: "current", source: "stable", target: "current", project: "untrusted", recovery: "clear", configuration: "valid", secrets: "available", capability: "available" };
      }
      const selected = current?.record.revisions.find((revision) => revision.revision === current.record.selectedRevision);
      const source = deriveMarketplaceSourceIdentity(candidate.marketplace.source.declared, dependencies.sha256) === notice.available.marketplaceSourceIdentity &&
        derivePluginSourceIdentity(candidate.entry.source.value, dependencies.sha256) === notice.available.pluginSourceIdentity &&
        selected?.evidence.source.marketplaceSourceIdentity === notice.available.marketplaceSourceIdentity &&
        selected.evidence.source.pluginSourceIdentity === notice.available.pluginSourceIdentity ? "stable" as const : "changed" as const;
      if (current === undefined || selected === undefined) return { candidate: "current", source, target: "stale", project: "trusted", recovery: "clear", configuration: "valid", secrets: "available", capability: "available" };
      const project = await projectAuthorized(current.scope, signal) ? "trusted" as const : "untrusted" as const;
      const recovery = current.record.pendingTransition === undefined ? "clear" as const : "required" as const;
      const detailId = deriveInspectionDetailId({
        version: 1,
        subject: "marketplace-candidate",
        scope: notice.scope,
        plugin: notice.plugin,
        registrationId: MarketplaceRegistrationIdSchema.parse(notice.registrationId),
        candidateId: MarketplaceCandidateIdSchema.parse(notice.candidateId),
        catalogSnapshot: MarketplaceSnapshotTokenSchema.parse(notice.snapshot),
      }, dependencies.sha256);
      let detail: Awaited<ReturnType<NativeInspectionService["detail"]>> | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const evidence = await dependencies.evidence.capture(signal);
        const snapshotId = deriveInspectionEvidenceSnapshotId(evidence.binding, dependencies.sha256);
        detail = await dependencies.inspection.detail({ snapshotId, detailId }, signal);
        if (detail.kind !== "stale") break;
      }
      if (detail?.kind !== "found" || detail.detail.summary.revision.immutable !== notice.available.immutableRevision) {
        return { candidate: "stale", source, target: "current", project, recovery, configuration: "valid", secrets: "available", capability: "available" };
      }
      const configuration = detail.detail.configuration.some((field) => field.required && ["missing", "invalid"].includes(field.state)) ? "required" as const : "valid" as const;
      const secrets = detail.detail.configuration.some((field) => field.required && field.sensitive && field.state === "unavailable") ? "unavailable" as const : "available" as const;
      const capability = detail.detail.compatibility.status === "incompatible" || detail.detail.compatibility.requirements.some((requirement) => requirement.status === "unavailable") ? "unavailable" as const : "available" as const;
      return { candidate: "current", source, target: "current", project, recovery, configuration, secrets, capability };
    },
    async apply(notice, signal): Promise<AutomaticUpdateLifecycleResult> {
      const [resolved, current] = await Promise.all([resolve(notice, signal), target(notice, signal)]);
      if (resolved.kind !== "resolved" || current === undefined) return { kind: "stale" };
      if ("unauthorized" in current) return { kind: "rejected", code: "UNTRUSTED" };
      if (current.record.pendingTransition !== undefined) return { kind: "stale" };
      const selected = current.record.revisions.find((revision) => revision.revision === current.record.selectedRevision);
      if (selected === undefined) return { kind: "stale" };
      const candidate = resolved.candidate;
      if (deriveMarketplaceSourceIdentity(candidate.marketplace.source.declared, dependencies.sha256) !== notice.available.marketplaceSourceIdentity ||
          derivePluginSourceIdentity(candidate.entry.source.value, dependencies.sha256) !== notice.available.pluginSourceIdentity ||
          selected.evidence.source.marketplaceSourceIdentity !== notice.available.marketplaceSourceIdentity ||
          selected.evidence.source.pluginSourceIdentity !== notice.available.pluginSourceIdentity) {
        return { kind: "rejected", code: "UNTRUSTED" };
      }
      const expectedTarget = LifecycleTargetExpectationSchema.parse({
        generation: current.snapshot.generation,
        plugin: current.record.plugin,
        selectedRevision: current.record.selectedRevision,
        activation: current.record.activation,
        targetDigest: deriveLifecycleTargetDigest(toScopeReference(current.scope), current.record, dependencies.sha256),
        pendingTransition: "none",
      });
      const sourceContext = candidate.entry.source.value.kind === "marketplace-path" ? {
        kind: "marketplace" as const,
        root: candidate.marketplace.root,
        source: candidate.marketplace.source,
        contentRootDigest: candidate.marketplace.content.rootDigest,
        content: candidate.marketplace.content,
        binding: candidate.marketplace.binding,
      } : { kind: "external" as const };
      let configurationPathContext;
      if (current.scope.kind === "project") {
        if (!await projectAuthorized(current.scope, signal)) return { kind: "rejected", code: "UNTRUSTED" };
        try {
          configurationPathContext = { scope: current.scope, trustedProjectRoot: await dependencies.projectRoots.acquire(signal) };
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          return { kind: "rejected", code: "UNTRUSTED" };
        }
      } else {
        configurationPathContext = { scope: current.scope, trustedBaseDirectory: dependencies.userBaseDirectory };
      }
      if (current.scope.kind === "project") {
        const root = configurationPathContext.trustedProjectRoot;
        const revalidated = dependencies.projectRoots.revalidate === undefined
          ? dependencies.projectRoots.verify(root, current.scope)
          : await dependencies.projectRoots.revalidate(root, current.scope, signal);
        if (revalidated.kind !== "project" || revalidated.projectKey !== current.scope.projectKey || !await projectAuthorized(current.scope, signal)) {
          return { kind: "rejected", code: "UNTRUSTED" };
        }
      }
      const result = await dependencies.lifecycle.update({
        scope: current.scope,
        plugin: notice.plugin,
        origin: "automatic-update",
        entry: candidate.entry,
        marketplaceSource: candidate.marketplace.source,
        sourceContext,
        expectedRevision: notice.available.immutableRevision,
        expectedTarget,
        configurationPathContext,
      }, signal);
      switch (result.kind) {
        case "changed":
        case "unchanged":
        case "stale":
        case "rolled-back":
        case "recovery-required":
          return { kind: result.kind };
        case "rejected": {
          const code = result.code === "INCOMPATIBLE" || result.code === "UNTRUSTED" || result.code === "UNCONFIGURED" || result.code === "AVAILABLE_REVISION_CHANGED" || result.code === "CONFIGURATION_STALE" || result.code === "PROJECTION_FAILED" || result.code === "PROMOTION_FAILED" || result.code === "ABORTED"
            ? result.code : "UNTRUSTED";
          return { kind: "rejected", code };
        }
      }
    },
  };
  return Object.freeze(port);
}
