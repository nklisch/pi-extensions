import { createExactTrustGrantService } from "../application/exact-trust-grant-service.js";
import { createTrustedInstallCandidateService, type TrustedInstallCandidateService } from "../application/trusted-install-candidate.js";
import { createTrustedInstallConfigurationAuthority } from "../application/trusted-install-configuration.js";
import { createTrustedInstallationService } from "../application/trusted-install-service.js";
import type { CandidateContentLeasePort } from "../application/ports/candidate-content-lease.js";
import type { ConfigurationPathPort } from "../application/ports/configuration-path.js";
import type { LifecycleClock } from "../application/ports/lifecycle-clock.js";
import type { LifecycleOperationIdPort } from "../application/ports/lifecycle-operation-id.js";
import type { LifecycleStateStore } from "../application/ports/lifecycle-state-store.js";
import type { NativeInspectionEvidencePort } from "../application/ports/native-inspection-evidence.js";
import type { PluginConfigurationStore } from "../application/ports/plugin-configuration-store.js";
import type { ProjectRootAuthorityPort } from "../application/ports/project-root-authority.js";
import type { ProjectTrustPort } from "../application/ports/project-trust.js";
import type { InspectionReadinessPort } from "../application/ports/inspection-readiness.js";
import type { PluginInspectionService } from "../application/inspection-service.js";
import type { MarketplaceCatalogService } from "../application/marketplace-catalog-service.js";
import type { GenerationMutationCoordinator } from "../application/generation-mutation-coordinator.js";
import type { PluginLifecycleComposition } from "../application/plugin-lifecycle-service.js";
import type { BoundPluginConfigurationService } from "../application/configuration-service.js";
import type { HostCapabilityStatus } from "../application/host-observation-contract.js";
import type { ContentDigest } from "../domain/content-manifest.js";
import type { Sha256 } from "../domain/source.js";

/** Private packaged wiring; raw acquisition, state, roots, and mutation ports never escape. */
export function createComposedTrustedInstallationService(input: Readonly<{
  catalog: Pick<MarketplaceCatalogService, "resolve">;
  candidateContent: CandidateContentLeasePort;
  candidate?: TrustedInstallCandidateService;
  inspector: PluginInspectionService;
  readiness: InspectionReadinessPort;
  evidence: NativeInspectionEvidencePort;
  configuration: BoundPluginConfigurationService;
  configurations: PluginConfigurationStore;
  configurationPaths: ConfigurationPathPort;
  secretCustody: HostCapabilityStatus;
  userBaseDirectory: string;
  state: LifecycleStateStore;
  mutations: GenerationMutationCoordinator;
  projectTrust: ProjectTrustPort;
  projectRoots: ProjectRootAuthorityPort;
  lifecycle: PluginLifecycleComposition;
  clock: LifecycleClock;
  sessionIds: LifecycleOperationIdPort;
  hostEpoch: ContentDigest;
  sha256: Sha256;
}>) {
  const candidate = input.candidate ?? createTrustedInstallCandidateService({
    catalog: input.catalog,
    content: input.candidateContent,
    inspector: input.inspector,
    readiness: input.readiness,
    sha256: input.sha256,
  });
  const configurationAuthority = createTrustedInstallConfigurationAuthority({ configurations: input.configurations, sha256: input.sha256 });
  const trust = createExactTrustGrantService({
    state: input.state,
    mutations: input.mutations,
    projectTrust: input.projectTrust,
    projectRoots: input.projectRoots,
    sha256: input.sha256,
  });
  return createTrustedInstallationService({
    candidate,
    configuration: input.configuration,
    configurationAuthority,
    configurationInput(candidateValue, projectRoot) {
      const scope = candidateValue.resolved.scope;
      if (scope.kind === "project" && projectRoot === undefined) throw new Error("project configuration requires current root authority");
      const pathContext = scope.kind === "project"
        ? { scope, trustedProjectRoot: projectRoot! }
        : { scope, trustedBaseDirectory: input.userBaseDirectory };
      return { pathContext, paths: input.configurationPaths, secretCustody: input.secretCustody };
    },
    trust,
    lifecycle: {
      state: input.state,
      prepared: input.lifecycle.preparedInstall,
      publicLifecycle: input.lifecycle.application,
    },
    evidence: input.evidence,
    projectRoots: input.projectRoots,
    clock: input.clock,
    sessionIds: input.sessionIds,
    hostEpoch: input.hostEpoch,
    sha256: input.sha256,
  });
}
