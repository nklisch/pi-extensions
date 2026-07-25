import type { MarketplaceCacheStatus } from "../marketplace-management-contract.js";
import type { StateLoadResult } from "../state-contract.js";
import type { HostStartupResult, HostStatusSnapshot } from "../host-observation-contract.js";
import type { RuntimeCapabilitySnapshot } from "../../domain/compatibility-policy.js";
import type { ContentDigest } from "../../domain/content-manifest.js";
import type { ComponentId } from "../../domain/components.js";
import type { MarketplaceRegistrationId, MarketplaceSnapshotToken } from "../../domain/marketplace-registration.js";
import type { PluginKey } from "../../domain/identity.js";
import type { ScopeReference } from "../../domain/state/scope.js";
import type { CurrentProjectRuntimeContext } from "./project-trust.js";
import type { RuntimeContributionObservation } from "./lifecycle-reload.js";
import type { McpBridgeTransport, McpRuntimeServerKey, McpSourceStatus } from "./mcp-runtime.js";
import type { LifecycleRecoveryResult } from "../recovery-contract.js";
import type { EpochMilliseconds } from "./lifecycle-clock.js";

export type InspectionSnapshotBinding = Readonly<{
  capturedAt: EpochMilliseconds;
  scopes: readonly Readonly<{
    scope: ScopeReference;
    generation?: number;
    status: "ready" | "corrupt" | "unavailable";
    corruptionCodes: readonly string[];
    /** Binds IDs and cursors to the exact quarantined-record evidence, not only its code set. */
    corruptionDigest?: ContentDigest;
  }>[];
  currentProject: Readonly<{
    projectKey: CurrentProjectRuntimeContext["projectKey"];
    trust: CurrentProjectRuntimeContext["trust"];
    epoch: ContentDigest;
  }>;
  catalogs: readonly Readonly<{
    scope: ScopeReference;
    registrationId: MarketplaceRegistrationId;
    snapshot?: MarketplaceSnapshotToken;
    cache: MarketplaceCacheStatus;
  }>[];
  capability: Readonly<{
    status: "ready" | "unavailable";
    digest?: ContentDigest;
    capturedBy?: string;
  }>;
  runtimeEpoch: ContentDigest;
  recoveryDigest: ContentDigest;
  updateDigest: ContentDigest;
}>;

export type InspectionMcpExpectation = Readonly<{
  kind: "source" | "none" | "inactive";
  registrationDigest?: ContentDigest;
  servers: readonly Readonly<{
    componentId: ComponentId;
    serverKey: McpRuntimeServerKey;
    transport: McpBridgeTransport;
  }>[];
}>;

export type InstalledRuntimeEvidence = Readonly<{
  scope: ScopeReference;
  plugin: PluginKey;
  selectedRevision: ContentDigest;
  projectionDigest?: ContentDigest;
  skillsHooks: Readonly<
    | { kind: "ready"; observation: RuntimeContributionObservation & Readonly<{ skillComponentIds: readonly ComponentId[]; hookComponentIds: readonly ComponentId[] }> }
    | { kind: "mismatched" }
    | { kind: "unavailable"; code: string }
  >;
  mcp: Readonly<{
    expected: InspectionMcpExpectation;
    status: Readonly<
      | { kind: "ready"; status: McpSourceStatus | null }
      | { kind: "mismatched" }
      | { kind: "unavailable"; code: string }
    >;
  }>;
}>;

export type InspectionEvidenceSnapshot = Readonly<{
  binding: InspectionSnapshotBinding;
  states: readonly StateLoadResult[];
  currentProject: CurrentProjectRuntimeContext;
  capabilities?: RuntimeCapabilitySnapshot;
  runtime: readonly InstalledRuntimeEvidence[];
  recovery: LifecycleRecoveryResult;
  startup: HostStartupResult;
  hostStatus?: HostStatusSnapshot;
}>;

export interface NativeInspectionEvidencePort {
  capture(signal: AbortSignal): Promise<InspectionEvidenceSnapshot>;
  validate(binding: InspectionSnapshotBinding, signal: AbortSignal): Promise<"current" | "stale">;
  /**
   * Revalidate install-bearing authority after the workflow's own configuration
   * or trust mutation. Scope generation and notice-only digest changes are
   * expected there; catalog, capability, project, runtime, and recovery
   * authority must remain exact.
   */
  validateForInstall?(binding: InspectionSnapshotBinding, signal: AbortSignal): Promise<"current" | "stale">;
}
