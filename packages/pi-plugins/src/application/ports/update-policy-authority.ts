import type { MarketplaceRegistrationId } from "../../domain/marketplace-registration.js";
import type { PluginKey } from "../../domain/identity.js";
import type { ScopeContext } from "../../domain/state/scope.js";
import type { StableSourceIdentity } from "../../domain/update-policy.js";
import type { EffectiveUpdatePolicy } from "../native-update-contract.js";

/** Current, source-bound policy authority used by lifecycle admission. */
export interface UpdatePolicyAuthorityPort {
  resolve(request: Readonly<{
    scope: ScopeContext;
    registrationId: MarketplaceRegistrationId;
    plugin: PluginKey;
    marketplaceSourceIdentity: StableSourceIdentity;
    pluginSourceIdentity: StableSourceIdentity;
  }>, signal: AbortSignal): Promise<EffectiveUpdatePolicy>;
}
