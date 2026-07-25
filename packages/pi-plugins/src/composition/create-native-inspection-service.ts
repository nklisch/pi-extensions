import { createNativeCandidateInspector } from "../application/native-candidate-inspection.js";
import { createNativeInstalledInspector } from "../application/native-installed-inspection.js";
import { createNativeInspectionService } from "../application/native-inspection-service.js";
import { createNativeInspectionEvidence } from "./native-inspection-evidence.js";
import { createNativeInspectionReadiness } from "./native-inspection-readiness.js";
import type { CandidateContentLeasePort } from "../application/ports/candidate-content-lease.js";
import type { InstalledPluginLoader } from "../application/ports/installed-plugin-loader.js";
import type { LifecycleClock } from "../application/ports/lifecycle-clock.js";
import type { LifecycleStateStore } from "../application/ports/lifecycle-state-store.js";
import type { PluginConfigurationStore } from "../application/ports/plugin-configuration-store.js";
import type { ProjectTrustPort, CurrentProjectRuntimeContext } from "../application/ports/project-trust.js";
import type { ProjectionExpectation } from "../application/ports/runtime-projection.js";
import type { PluginInspectionService } from "../application/inspection-service.js";
import type { LifecycleRecoveryResult } from "../application/recovery-contract.js";
import type { NativeInspectionService } from "../application/native-inspection-contract.js";
import type { RuntimeCapabilitySnapshot } from "../domain/compatibility-policy.js";
import type { ScopeContext } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { SkillHookContributionObservationResult } from "../runtime/skills/resource-discovery.js";
import type { McpLifecycleParticipant } from "../runtime/mcp/lifecycle-participant.js";
import type { RuntimeDesiredState } from "./runtime-desired-state.js";
import type { RuntimeSelectionCatalog } from "./runtime-selection-catalog.js";
import type { HostCapabilityStatus, HostStartupResult } from "../application/host-observation-contract.js";
import type { NativeInspectionMarketplaceServices } from "./create-marketplace-discovery-services.js";
import type { HostStatusService } from "./host-status-service.js";

/** Wire the read model from narrow existing-evidence ports; no mutation service enters. */
export function createNativeInspectionComposition(input: Readonly<{
  state: LifecycleStateStore;
  scopes: readonly ScopeContext[];
  revalidateProject(signal: AbortSignal): Promise<CurrentProjectRuntimeContext>;
  selections: RuntimeSelectionCatalog;
  desired(): RuntimeDesiredState | undefined;
  skillHook: Readonly<{ observe(expectation: ProjectionExpectation, signal: AbortSignal): Promise<SkillHookContributionObservationResult> }>;
  mcp: Pick<McpLifecycleParticipant, "status">;
  capabilities?: RuntimeCapabilitySnapshot;
  recovery: LifecycleRecoveryResult;
  startup: HostStartupResult;
  status?: HostStatusService;
  configurations: PluginConfigurationStore;
  projectTrust: ProjectTrustPort;
  secretCustody: HostCapabilityStatus;
  installed: InstalledPluginLoader;
  candidateContent: Pick<CandidateContentLeasePort, "withMaterialized">;
  bundleInspector: PluginInspectionService;
  marketplace: NativeInspectionMarketplaceServices;
  clock: LifecycleClock;
  sha256: Sha256;
}>) {
  const evidence = createNativeInspectionEvidence({
    state: input.state,
    catalog: input.marketplace.catalog,
    scopes: input.scopes,
    revalidateProject: input.revalidateProject,
    selections: input.selections,
    desired: input.desired,
    skillHook: input.skillHook,
    mcp: input.mcp,
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    recovery: input.recovery,
    startup: input.startup,
    ...(input.status === undefined ? {} : { status: input.status }),
    clock: input.clock,
    sha256: input.sha256,
  });
  const readiness = createNativeInspectionReadiness({
    state: input.state,
    configurations: input.configurations,
    projectTrust: input.projectTrust,
    secretCustody: input.secretCustody,
    sha256: input.sha256,
  });
  const installed = createNativeInstalledInspector({ installed: input.installed, readiness, sha256: input.sha256 });
  const candidates = createNativeCandidateInspector({
    catalog: input.marketplace.catalog,
    content: input.candidateContent,
    inspector: input.bundleInspector,
    readiness,
    sha256: input.sha256,
  });
  const application = createNativeInspectionService({
    evidence,
    installed,
    candidates,
    catalog: input.marketplace.catalog,
    adoption: input.marketplace.adoption,
    clock: input.clock,
    sha256: input.sha256,
  });
  return Object.freeze({ application, evidence, readiness });
}

/** Source-compatible read-only composition wrapper. */
export function createComposedNativeInspectionService(
  input: Parameters<typeof createNativeInspectionComposition>[0],
): NativeInspectionService {
  return createNativeInspectionComposition(input).application;
}
