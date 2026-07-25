import type { PluginConfiguration } from "../../domain/configuration.js";
import type { PluginConfigurationRef } from "../../domain/state/references.js";
import type { PluginKey } from "../../domain/identity.js";
import type { ScopeReference } from "../../domain/state/scope.js";
import type { TrustCandidate } from "../../domain/trust-policy.js";
import type { HostCapabilityStatus } from "../host-observation-contract.js";
import type {
  NativeConfigurationOptionView,
  NativeTrustReadiness,
} from "../native-inspection-contract.js";

/** Read-only, value-free readiness projections used by both inspectors. */
export interface InspectionReadinessPort {
  trust(candidate: TrustCandidate, scope: ScopeReference, signal: AbortSignal): Promise<NativeTrustReadiness>;
  configuration(request: Readonly<{
    plugin: PluginKey;
    scope: ScopeReference;
    descriptors: PluginConfiguration;
    configurationRef?: PluginConfigurationRef;
  }>, signal: AbortSignal): Promise<readonly NativeConfigurationOptionView[]>;
  secretCustody(): HostCapabilityStatus;
}
