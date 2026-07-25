import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import {
  MarketplaceRegistrationRecordSchema,
  StableSourceIdentitySchema,
  UpdateApplicationModeSchema,
  type MarketplaceRegistrationRecord,
  type StableSourceIdentity,
  type UpdateApplicationMode,
} from "../domain/update-policy.js";
import { EffectiveUpdatePolicySchema, type EffectiveUpdatePolicy } from "./native-update-contract.js";

export type UpdatePolicyResolutionInput = Readonly<{
  plugin: PluginKey;
  record: MarketplaceRegistrationRecord;
  global: UpdateApplicationMode;
  scope?: UpdateApplicationMode;
  marketplaceSourceIdentity: StableSourceIdentity;
  registeredMarketplaceSourceIdentity?: StableSourceIdentity;
  pluginSourceIdentity: StableSourceIdentity;
}>;

/** Pure precedence and hard-source-guard authority used by every update caller. */
export function resolveEffectiveUpdatePolicy(input: UpdatePolicyResolutionInput): EffectiveUpdatePolicy {
  const plugin = PluginKeySchema.parse(input.plugin);
  const record = MarketplaceRegistrationRecordSchema.parse(input.record);
  const global = UpdateApplicationModeSchema.parse(input.global);
  const scope = input.scope === undefined ? undefined : UpdateApplicationModeSchema.parse(input.scope);
  const marketplaceSourceIdentity = StableSourceIdentitySchema.parse(input.marketplaceSourceIdentity);
  const pluginSourceIdentity = StableSourceIdentitySchema.parse(input.pluginSourceIdentity);
  const registeredMarketplaceSourceIdentity = input.registeredMarketplaceSourceIdentity === undefined
    ? marketplaceSourceIdentity
    : StableSourceIdentitySchema.parse(input.registeredMarketplaceSourceIdentity);

  if (record.source.kind === "local-git") return EffectiveUpdatePolicySchema.parse({ application: "manual", winningLevel: "guard", sourceGuard: "local" });
  if (marketplaceSourceIdentity === "legacy-unavailable" || pluginSourceIdentity === "legacy-unavailable") {
    return EffectiveUpdatePolicySchema.parse({ application: "manual", winningLevel: "guard", sourceGuard: "legacy-source" });
  }

  if (marketplaceSourceIdentity !== registeredMarketplaceSourceIdentity) {
    return EffectiveUpdatePolicySchema.parse({ application: "manual", winningLevel: "guard", sourceGuard: "marketplace-source-changed" });
  }

  const pluginOverride = record.pluginOverrides.find((override) => override.plugin === plugin);
  if (pluginOverride !== undefined && pluginOverride.sourceIdentity !== pluginSourceIdentity) {
    return EffectiveUpdatePolicySchema.parse({ application: "manual", winningLevel: "guard", sourceGuard: "plugin-source-changed" });
  }
  if (pluginOverride !== undefined && pluginOverride.mode !== "inherit") {
    return EffectiveUpdatePolicySchema.parse({ application: pluginOverride.mode, winningLevel: "plugin", sourceGuard: "none" });
  }
  if (record.applicationOverride !== undefined && record.applicationOverride !== "inherit") {
    return EffectiveUpdatePolicySchema.parse({ application: record.applicationOverride, winningLevel: "marketplace", sourceGuard: "none" });
  }
  if (scope !== undefined) return EffectiveUpdatePolicySchema.parse({ application: scope, winningLevel: "scope", sourceGuard: "none" });
  return EffectiveUpdatePolicySchema.parse({ application: global, winningLevel: "global", sourceGuard: "none" });
}
