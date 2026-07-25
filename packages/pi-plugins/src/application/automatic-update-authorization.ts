import "zod";
import { ContentDigestSchema, type ContentDigest } from "../domain/content-manifest.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { ScopeReferenceSchema, type ScopeReference, type ScopeContext } from "../domain/state/scope.js";
import { InstalledRevisionRecordSchema, type InstalledRevisionRecord } from "../domain/state/installed-state.js";
import { TrustStateRecordSchema, type TrustStateRecord } from "../domain/state/trust-state.js";
import { evaluateTrust, verifyTrustCandidate, type TrustCandidate } from "../domain/trust-policy.js";
import { StableSourceIdentitySchema, type StableSourceIdentity } from "../domain/update-policy.js";
import type { LoadedInstalledPlugin } from "./ports/installed-plugin-loader.js";
import type { ProjectTrustPort } from "./ports/project-trust.js";
import type { Sha256 } from "../domain/source.js";
import type { MarketplaceUpdateRecord } from "../domain/update-policy.js";
import type { EffectiveUpdatePolicy } from "./native-update-contract.js";

export type AutomaticUpdateAuthorizationResult =
  | Readonly<{ kind: "authorized"; subject: import("../domain/state/references.js").TrustSubjectRef }>
  | Readonly<{ kind: "denied"; code:
      "POLICY_MANUAL" | "LOCAL_SOURCE" | "MARKETPLACE_SOURCE_CHANGED" |
      "PLUGIN_SOURCE_CHANGED" | "LEGACY_SOURCE_IDENTITY" |
      "BASELINE_TRUST_ABSENT" | "BASELINE_TRUST_REVOKED" |
      "PROJECT_UNTRUSTED" | "STATE_STALE" }>;

export type AutomaticUpdateAuthorizationEvidence = Readonly<{
  kind: "automatic-authorization";
  scope: ScopeReference;
  plugin: PluginKey;
  expectedRevision: ContentDigest;
  marketplaceSourceIdentity: StableSourceIdentity;
  pluginSourceIdentity: StableSourceIdentity;
}>;

const authorizationEvidence = new WeakSet<object>();

function createEvidence(input: AutomaticUpdateAuthorizationEvidence): AutomaticUpdateAuthorizationEvidence {
  const value = Object.freeze({
    ...input,
    scope: ScopeReferenceSchema.parse(input.scope),
    plugin: PluginKeySchema.parse(input.plugin),
    expectedRevision: ContentDigestSchema.parse(input.expectedRevision),
    marketplaceSourceIdentity: StableSourceIdentitySchema.parse(input.marketplaceSourceIdentity),
    pluginSourceIdentity: StableSourceIdentitySchema.parse(input.pluginSourceIdentity),
  });
  authorizationEvidence.add(value);
  return value;
}

export function isAutomaticUpdateAuthorizationEvidence(input: unknown): input is AutomaticUpdateAuthorizationEvidence {
  return typeof input === "object" && input !== null && authorizationEvidence.has(input);
}

function denied(code: AutomaticUpdateAuthorizationResult extends infer _T ? Exclude<AutomaticUpdateAuthorizationResult, { kind: "authorized" }>["code"] : never): AutomaticUpdateAuthorizationResult {
  return { kind: "denied", code };
}

function baselineTrusted(
  candidate: TrustCandidate,
  records: readonly TrustStateRecord[],
  sha256: Sha256,
): AutomaticUpdateAuthorizationResult | undefined {
  const decision = evaluateTrust(candidate, records, sha256);
  if (decision.kind === "authorized") return undefined;
  return denied(decision.reason === "REVOKED" ? "BASELINE_TRUST_REVOKED" : decision.reason === "ABSENT" ? "BASELINE_TRUST_ABSENT" : "STATE_STALE");
}

export async function authorizeAutomaticUpdateCandidate(
  request: Readonly<{
    scope: ScopeContext;
    previous: LoadedInstalledPlugin;
    previousRecord: InstalledRevisionRecord;
    /** The candidate trust shape; the authorization result is still bound to the expected revision. */
    candidate: TrustCandidate;
    candidateMarketplaceSourceIdentity: StableSourceIdentity;
    candidatePluginSourceIdentity: StableSourceIdentity;
    expectedRevision: ContentDigest;
    policyRecord: MarketplaceUpdateRecord;
    effectivePolicy?: EffectiveUpdatePolicy;
    trustRecords: readonly TrustStateRecord[];
    projectDeclarationDigest?: ContentDigest;
  }>,
  dependencies: Readonly<{ projectTrust: ProjectTrustPort; sha256: Sha256 }>,
  signal: AbortSignal,
): Promise<AutomaticUpdateAuthorizationResult> {
  signal.throwIfAborted();
  const scope = ScopeReferenceSchema.parse(request.scope.kind === "user" ? { kind: "user" } : { kind: "project", projectKey: request.scope.projectKey });
  const previousRecord = InstalledRevisionRecordSchema.parse(request.previousRecord);
  const candidate = verifyTrustCandidate(request.candidate, dependencies.sha256);
  const expectedRevision = ContentDigestSchema.parse(request.expectedRevision);
  const policy = request.policyRecord;
  if ((request.effectivePolicy?.application ?? (policy.applicationOverride === "automatic" ? "automatic" : "manual")) !== "automatic") return denied("POLICY_MANUAL");
  if (request.effectivePolicy !== undefined && request.effectivePolicy.sourceGuard !== "none") {
    return denied(request.effectivePolicy.sourceGuard === "marketplace-source-changed" ? "MARKETPLACE_SOURCE_CHANGED" : request.effectivePolicy.sourceGuard === "plugin-source-changed" ? "PLUGIN_SOURCE_CHANGED" : request.effectivePolicy.sourceGuard === "legacy-source" ? "LEGACY_SOURCE_IDENTITY" : "LOCAL_SOURCE");
  }
  if (policy.source.kind === "local-git") return denied("LOCAL_SOURCE");
  const marketplaceIdentity = StableSourceIdentitySchema.parse(request.candidateMarketplaceSourceIdentity);
  const pluginIdentity = StableSourceIdentitySchema.parse(request.candidatePluginSourceIdentity);
  const previousMarketplace = StableSourceIdentitySchema.parse(previousRecord.evidence.source.marketplaceSourceIdentity ?? "legacy-unavailable");
  const previousPlugin = StableSourceIdentitySchema.parse(previousRecord.evidence.source.pluginSourceIdentity ?? "legacy-unavailable");
  if (previousMarketplace === "legacy-unavailable" || previousPlugin === "legacy-unavailable") return denied("LEGACY_SOURCE_IDENTITY");
  if (marketplaceIdentity !== previousMarketplace) return denied("MARKETPLACE_SOURCE_CHANGED");
  if (pluginIdentity !== previousPlugin) return denied("PLUGIN_SOURCE_CHANGED");
  if (candidate.evidence.scope.kind !== scope.kind || candidate.evidence.plugin !== previousRecord.evidence.plugin.key) return denied("STATE_STALE");
  const baseline = baselineTrusted({
    ...candidate,
    evidence: {
      ...candidate.evidence,
      immutableRevision: previousRecord.revision,
      executableSurfaceDigest: previousRecord.evidence.trust.executableSurfaceDigest,
    },
  }, request.trustRecords, dependencies.sha256);
  if (baseline !== undefined) return baseline;
  if (scope.kind === "project") {
    if (request.projectDeclarationDigest === undefined) return denied("STATE_STALE");
    try { ContentDigestSchema.parse(request.projectDeclarationDigest); } catch { return denied("STATE_STALE"); }
    const assessment = await dependencies.projectTrust.assess(scope.projectKey, signal);
    if (assessment.kind !== "trusted") return denied("PROJECT_UNTRUSTED");
  }
  return {
    kind: "authorized",
    subject: candidate.subject,
  };
}

/** Internal capability constructor used only by lifecycle preparation. */
export function createAutomaticUpdateAuthorizationEvidence(input: AutomaticUpdateAuthorizationEvidence): AutomaticUpdateAuthorizationEvidence {
  return createEvidence(input);
}

export { TrustStateRecordSchema };
