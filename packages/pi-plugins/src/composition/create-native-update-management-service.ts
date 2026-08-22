import { createAutomaticUpdateCoordinator } from "../application/automatic-update-coordinator.js";
import { createAutomaticTrustContinuity } from "../application/automatic-trust-continuity.js";
import { createNativeUpdateManagementService } from "../application/native-update-management-service.js";
import { createNativeUpdatePolicyService } from "../application/native-update-policy-service.js";
import { createUpdateNotificationService } from "../application/update-notification-service.js";
import type { MarketplaceUpdateScheduler } from "../application/marketplace-update-scheduler.js";
import type { AutomaticUpdateLifecyclePort } from "../application/ports/automatic-update-lifecycle.js";
import type { LifecycleClock } from "../application/ports/lifecycle-clock.js";
import type { LifecycleStateInventoryPort } from "../application/ports/lifecycle-state-inventory.js";
import type { LifecycleStateStore } from "../application/ports/lifecycle-state-store.js";
import type { ProjectTrustPort } from "../application/ports/project-trust.js";
import type { InstalledPluginLoader } from "../application/ports/installed-plugin-loader.js";
import type { UpdateNotificationPublisherPort } from "../application/ports/update-notification-publisher.js";
import type { ScopeContext } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { CurrentProjectRuntimeContext } from "../application/ports/project-trust.js";
import type { UpdateSchedulerStatusProjection } from "../application/update-scheduler-status.js";

export function createNativeUpdateManagementComposition(input: Readonly<{
  state: LifecycleStateStore;
  inventory: LifecycleStateInventoryPort;
  mutations: LifecycleStateStore;
  clock: LifecycleClock;
  sha256: Sha256;
  scheduler: MarketplaceUpdateScheduler;
  schedulerStatus?: UpdateSchedulerStatusProjection;
  lifecycle: AutomaticUpdateLifecyclePort;
  installed: InstalledPluginLoader;
  currentProject?: Extract<ScopeContext, { kind: "project" }>;
  projectTrust?: ProjectTrustPort;
  revalidateCurrentProject?: (signal: AbortSignal) => Promise<CurrentProjectRuntimeContext>;
  publisher?: UpdateNotificationPublisherPort;
  onCounts?: (counts: Readonly<{ unreadCount: number; unresolvedCount: number }>) => void;
}>) {
  const policy = createNativeUpdatePolicyService({
    state: input.state,
    inventory: input.inventory,
    mutations: input.mutations,
    clock: input.clock,
    sha256: input.sha256,
    ...(input.currentProject === undefined ? {} : { currentProject: input.currentProject }),
    ...(input.projectTrust === undefined ? {} : { projectTrust: input.projectTrust }),
    ...(input.revalidateCurrentProject === undefined ? {} : { revalidateCurrentProject: input.revalidateCurrentProject }),
    ...(input.schedulerStatus === undefined ? {} : { schedulerStatus: input.schedulerStatus }),
  });
  const notifications = createUpdateNotificationService({
    state: input.state,
    inventory: input.inventory,
    mutations: input.mutations,
    clock: input.clock,
    sha256: input.sha256,
    ...(input.publisher === undefined ? {} : { publisher: input.publisher }),
    ...(input.currentProject === undefined ? {} : { currentProject: input.currentProject }),
    ...(input.projectTrust === undefined ? {} : { projectTrust: input.projectTrust }),
    ...(input.revalidateCurrentProject === undefined ? {} : { revalidateCurrentProject: input.revalidateCurrentProject }),
  });
  const continuity = createAutomaticTrustContinuity({
    state: input.state,
    mutations: input.mutations,
    installed: input.installed,
    ...(input.projectTrust === undefined ? {} : { projectTrust: input.projectTrust }),
    sha256: input.sha256,
  });
  const automatic = createAutomaticUpdateCoordinator({
    state: input.state,
    inventory: input.inventory,
    mutations: input.mutations,
    policy: policy.authority,
    lifecycle: input.lifecycle,
    continuity,
    clock: input.clock,
    sha256: input.sha256,
    ...(input.currentProject === undefined ? {} : { currentProject: input.currentProject }),
    ...(input.projectTrust === undefined ? {} : { projectTrust: input.projectTrust }),
    ...(input.revalidateCurrentProject === undefined ? {} : { revalidateCurrentProject: input.revalidateCurrentProject }),
  });
  const application = createNativeUpdateManagementService({
    policy,
    notifications,
    automatic,
    scheduler: input.scheduler,
    ...(input.onCounts === undefined ? {} : { onCounts: input.onCounts }),
  });
  return Object.freeze({ application, policy, notifications, automatic });
}
