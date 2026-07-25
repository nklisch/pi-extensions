import { createMarketplaceRegistrationService } from "../application/marketplace-registration-service.js";
import { createMarketplaceCatalogService } from "../application/marketplace-catalog-service.js";
import { createNodeMarketplaceUpdateServices } from "./create-marketplace-update-services.js";
import { createNodeAdoptionService } from "./create-adoption-service.js";
import { createNodeMarketplaceLocalSourcePort } from "../infrastructure/filesystem/marketplace-local-source.js";
import {
  MarketplaceRefreshRequestSchema,
  MarketplaceRefreshResultSchema,
  type MarketplaceRefreshRequest,
  type MarketplaceRefreshResult,
} from "../application/update-contract.js";
import { MarketplaceUpdatePreferenceResultSchema } from "../application/marketplace-update-policy-service.js";
import type { GenerationMutationCoordinator } from "../application/generation-mutation-coordinator.js";
import type { MarketplaceInspectionService } from "../application/marketplace-inspection-contract.js";
import type { ContentStorePort } from "../application/ports/content-store.js";
import type { LifecycleClock } from "../application/ports/lifecycle-clock.js";
import type { LifecycleStateInventoryPort } from "../application/ports/lifecycle-state-inventory.js";
import type { LifecycleStateStore } from "../application/ports/lifecycle-state-store.js";
import type { CurrentProjectRuntimeContext, ProjectTrustPort } from "../application/ports/project-trust.js";
import type { RefreshClaimIdPort } from "../application/ports/refresh-claim-id.js";
import type { RefreshClaimOwnerPort } from "../application/ports/refresh-claim-owner.js";
import type { MarketplaceMaterializer, PluginMaterializer } from "../application/source-materialization.js";
import type { ScopeContext } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { MarketplacePluginProbePort } from "../application/marketplace-refresh-service.js";
import type { PluginLifecycleService } from "../application/plugin-lifecycle-service.js";
import type { UpdateSchedulerLeaseIdPort } from "../application/ports/update-scheduler-lease-id.js";
import { createStateUpdateSchedulerLeasePort } from "../application/update-scheduler-lease-state.js";

type RegistrationService = ReturnType<typeof createMarketplaceRegistrationService>;
type UpdateServices = ReturnType<typeof createNodeMarketplaceUpdateServices>;
type CatalogService = ReturnType<typeof createMarketplaceCatalogService>;
type AdoptionService = ReturnType<typeof createNodeAdoptionService>;
type UpdatePolicyRequest = Parameters<UpdateServices["policy"]["setApplicationPreference"]>[0];

export type BoundMarketplaceUpdatePolicyRequest = Readonly<
  Omit<UpdatePolicyRequest, "scope"> & { scope: "user" | "project" }
>;

export type MarketplaceDiscoveryServices = Readonly<{
  registration: Pick<RegistrationService, "add" | "remove" | "list">;
  refresh: UpdateServices["refresh"];
  policy: Readonly<{
    setApplicationPreference(
      request: BoundMarketplaceUpdatePolicyRequest,
      signal: AbortSignal,
    ): ReturnType<UpdateServices["policy"]["setApplicationPreference"]>;
  }>;
  catalog: Pick<CatalogService, "search" | "detail">;
  adoption: Pick<AdoptionService, "preview" | "import">;
}>;

export type NativeInspectionMarketplaceServices = Readonly<{
  catalog: CatalogService;
  adoption: Pick<AdoptionService, "preview">;
}>;

export type NodeMarketplaceDiscoveryComposition = Readonly<{
  application: MarketplaceDiscoveryServices;
  inspection: NativeInspectionMarketplaceServices;
  /** Internal coordinator authority; never exposed on the packaged application. */
  updates: UpdateServices;
}>;

export type NodeMarketplaceDiscoveryServicesOptions = Readonly<{
  state: LifecycleStateStore;
  inventory: LifecycleStateInventoryPort;
  mutations: GenerationMutationCoordinator;
  clock: LifecycleClock;
  claimIds: RefreshClaimIdPort;
  claimOwners?: RefreshClaimOwnerPort;
  updateSchedulerLeaseIds?: UpdateSchedulerLeaseIdPort;
  materializers: Readonly<{ marketplaces: MarketplaceMaterializer; plugins?: PluginMaterializer }>;
  inspection: MarketplaceInspectionService;
  content: ContentStorePort;
  currentProject?: Extract<ScopeContext, { kind: "project" }>;
  projectTrust?: ProjectTrustPort;
  /** Packaged hosts re-resolve the bound project before every public operation. */
  revalidateCurrentProject?: (signal: AbortSignal) => Promise<CurrentProjectRuntimeContext>;
  sha256: Sha256;
  probe?: MarketplacePluginProbePort;
  lifecycle?: PluginLifecycleService;
  userHome?: string;
  claudeRoot?: string;
  codexHome?: string;
  maxDocumentBytes?: number;
}>;

/**
 * Compose one marketplace capability over the existing state, content, source,
 * and trust graph. Construction performs no I/O; every read/acquisition remains
 * behind an explicit application method.
 */
export function createNodeMarketplaceDiscoveryComposition(
  options: NodeMarketplaceDiscoveryServicesOptions,
): NodeMarketplaceDiscoveryComposition {
  const registration = createMarketplaceRegistrationService({
    state: options.state,
    mutations: options.mutations,
    materializer: options.materializers.marketplaces,
    inspection: options.inspection,
    content: options.content,
    clock: options.clock,
    ...(options.currentProject === undefined ? {} : { currentProject: options.currentProject }),
    ...(options.projectTrust === undefined ? {} : { projectTrust: options.projectTrust }),
    localSources: createNodeMarketplaceLocalSourcePort(),
    sha256: options.sha256,
  });
  const schedulerLeases = options.updateSchedulerLeaseIds === undefined ? undefined : createStateUpdateSchedulerLeasePort({
    state: options.state,
    inventory: options.inventory,
    mutations: options.mutations,
    clock: options.clock,
    sha256: options.sha256,
    ...(options.currentProject === undefined ? {} : { currentProject: options.currentProject }),
    ...(options.projectTrust === undefined ? {} : { projectTrust: options.projectTrust }),
    ...(options.revalidateCurrentProject === undefined ? {} : { revalidateCurrentProject: options.revalidateCurrentProject }),
  });
  const updates = createNodeMarketplaceUpdateServices({
    refresh: {
      inventory: options.inventory,
      state: options.state,
      mutations: options.mutations,
      clock: options.clock,
      claimIds: options.claimIds,
      ...(options.claimOwners === undefined ? {} : { claimOwners: options.claimOwners }),
      materializers: options.materializers,
      inspection: options.inspection,
      content: options.content,
      ...(options.currentProject === undefined ? {} : { currentProject: options.currentProject }),
      ...(options.projectTrust === undefined ? {} : { projectTrust: options.projectTrust }),
      ...(options.revalidateCurrentProject === undefined ? {} : { revalidateCurrentProject: options.revalidateCurrentProject }),
      sha256: options.sha256,
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
      ...(schedulerLeases === undefined ? {} : { schedulerLeases }),
    },
    ...(schedulerLeases === undefined ? {} : { schedulerLeases }),
    ...(options.updateSchedulerLeaseIds === undefined ? {} : { leaseIds: options.updateSchedulerLeaseIds }),
  });
  const internalCatalog = createMarketplaceCatalogService({
    state: options.state,
    content: options.content,
    inspection: options.inspection,
    clock: options.clock,
    ...(options.currentProject === undefined ? {} : { currentProject: options.currentProject }),
    sha256: options.sha256,
  });
  const internalAdoption = createNodeAdoptionService({
    registrations: registration,
    registry: registration,
    ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
    ...(options.claudeRoot === undefined ? {} : { claudeRoot: options.claudeRoot }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.maxDocumentBytes === undefined ? {} : { maxDocumentBytes: options.maxDocumentBytes }),
  });

  async function revalidate(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (options.currentProject !== undefined) await options.revalidateCurrentProject?.(signal);
    signal.throwIfAborted();
  }

  const publicRegistration: MarketplaceDiscoveryServices["registration"] = Object.freeze({
    async add(request, signal) {
      await revalidate(signal);
      return registration.add(request, signal);
    },
    async remove(request, signal) {
      await revalidate(signal);
      return registration.remove(request, signal);
    },
    async list(request, signal) {
      await revalidate(signal);
      return registration.list(request, signal);
    },
  });
  const refresh: MarketplaceDiscoveryServices["refresh"] = Object.freeze({
    async refresh(request: MarketplaceRefreshRequest, signal: AbortSignal): Promise<MarketplaceRefreshResult> {
      await revalidate(signal);
      let bound = MarketplaceRefreshRequestSchema.parse(request);
      if (bound.scope === "project" || bound.scope === "all-current") {
        const trusted = options.currentProject !== undefined && options.projectTrust !== undefined &&
          (await options.projectTrust.assess(options.currentProject.projectKey, signal)).kind === "trusted";
        if (!trusted) {
          if (bound.scope === "project") {
            return MarketplaceRefreshResultSchema.parse({ outcomes: [], notifications: [] });
          }
          bound = MarketplaceRefreshRequestSchema.parse({ ...bound, scope: "user" });
        }
      }
      return updates.refresh.refresh(bound, signal);
    },
    async nextScheduledAt(signal: AbortSignal): Promise<number | undefined> {
      await revalidate(signal);
      return updates.refresh.nextScheduledAt(signal);
    },
  });
  const policy: MarketplaceDiscoveryServices["policy"] = Object.freeze({
    async setApplicationPreference(request, signal) {
      await revalidate(signal);
      if (request.scope !== "user" && request.scope !== "project") {
        throw new TypeError("marketplace policy scope must be user or current project");
      }
      if (request.scope === "project") {
        if (options.currentProject === undefined || options.projectTrust === undefined ||
            (await options.projectTrust.assess(options.currentProject.projectKey, signal)).kind !== "trusted") {
          return MarketplaceUpdatePreferenceResultSchema.parse({ kind: "rejected", code: "STATE_STALE" });
        }
        return updates.policy.setApplicationPreference({ ...request, scope: options.currentProject }, signal);
      }
      return updates.policy.setApplicationPreference({ ...request, scope: { kind: "user" as const } }, signal);
    },
  });
  const catalog: MarketplaceDiscoveryServices["catalog"] = Object.freeze({
    async search(request, signal) {
      await revalidate(signal);
      return internalCatalog.search(request, signal);
    },
    async detail(request, signal) {
      await revalidate(signal);
      return internalCatalog.detail(request, signal);
    },
  });
  const adoption: MarketplaceDiscoveryServices["adoption"] = Object.freeze({
    async preview(request, signal) {
      await revalidate(signal);
      return internalAdoption.preview(request, signal);
    },
    async import(request, signal) {
      await revalidate(signal);
      return internalAdoption.import(request, signal);
    },
  });

  const application = Object.freeze({ registration: publicRegistration, refresh, policy, catalog, adoption });
  return Object.freeze({
    application,
    inspection: Object.freeze({ catalog: internalCatalog, adoption: Object.freeze({ preview: internalAdoption.preview.bind(internalAdoption) }) }),
    updates,
  });
}

export function createNodeMarketplaceDiscoveryServices(
  options: NodeMarketplaceDiscoveryServicesOptions,
): MarketplaceDiscoveryServices {
  return createNodeMarketplaceDiscoveryComposition(options).application;
}
