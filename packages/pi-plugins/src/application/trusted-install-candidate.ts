import { compareUtf8 } from "../domain/canonical-json.js";
import { evaluateCompatibility } from "../domain/compatibility-evaluator.js";
import { CompatibilityReportSchema, type CompatibilityReport } from "../domain/compatibility.js";
import { RuntimeCapabilityRegistry } from "../domain/compatibility-policy.js";
import { digestConfigurationDescriptors } from "../domain/configured-values.js";
import { createInstalledRevisionRecord, type InstalledRevisionRecord } from "../domain/state/installed-state.js";
import { toScopeReference } from "../domain/state/scope.js";
import { createTrustCandidate, type TrustCandidate } from "../domain/trust-policy.js";
import { deriveMarketplaceSourceIdentity, derivePluginSourceIdentity } from "../domain/update-policy.js";
import { createMcpLaunchTemplate } from "../domain/mcp-launch-template.js";
import { digestCompatibilityReport } from "./ports/runtime-projection.js";
import {
  isCandidateContentCleanupError,
  type CandidateContentCleanupRecovery,
  type CandidateContentLease,
  type CandidateContentLeasePort,
} from "./ports/candidate-content-lease.js";
import type { InspectionReadinessPort } from "./ports/inspection-readiness.js";
import type { InspectionEvidenceSnapshot } from "./ports/native-inspection-evidence.js";
import type { PluginInspectionService } from "./inspection-service.js";
import type { MarketplaceCatalogService, ResolvedMarketplaceCandidate } from "./marketplace-catalog-service.js";
import { createNativeCandidateInspector } from "./native-candidate-inspection.js";
import { projectSafeComponents, projectSafeSource } from "./native-inspection-disclosure.js";
import { NativeDisplayLimits, toSafeDisplayField } from "./native-inspection-display.js";
import {
  deriveInspectionDetailId,
  deriveInspectionEvidenceSnapshotId,
  type CandidateInspectionDetailSubject,
} from "./native-inspection-identifiers.js";
import {
  NativeInspectionDetailResultSchema,
  type NativeComponentInventoryView,
  type NativeInspectionDetail,
  type NativeInspectionDetailResult,
} from "./native-inspection-contract.js";
import {
  TrustedInstallCandidateBindingSchema,
  TrustedInstallConfigurationFieldSchema,
  TrustedInstallConsentDisclosureSchema,
  type TrustedInstallCandidateBinding,
  type TrustedInstallConfigurationField,
  type TrustedInstallConsentDisclosure,
} from "./trusted-install-contract.js";
import {
  deriveTrustedInstallConsentDisclosureDigest,
  deriveTrustedInstallConsentId,
} from "./trusted-install-identifiers.js";
import type { Sha256 } from "../domain/source.js";

export type TrustedInstallCandidate = Readonly<{
  lease: CandidateContentLease;
  resolved: ResolvedMarketplaceCandidate;
  plugin: import("../domain/plugin.js").NormalizedPlugin;
  compatibility: CompatibilityReport;
  revision: InstalledRevisionRecord;
  trust: TrustCandidate;
  binding: TrustedInstallCandidateBinding;
  detail: NativeInspectionDetail;
  fields: readonly TrustedInstallConfigurationField[];
  consent: TrustedInstallConsentDisclosure;
  snapshotBinding: InspectionEvidenceSnapshot["binding"];
}>;

export type TrustedInstallCandidateDependencies = Readonly<{
  catalog: Pick<MarketplaceCatalogService, "resolve">;
  content: CandidateContentLeasePort;
  inspector: PluginInspectionService;
  readiness: InspectionReadinessPort;
  sha256: Sha256;
}>;

export interface TrustedInstallCandidateService {
  acquire(request: Readonly<{ subject: CandidateInspectionDetailSubject; snapshot: InspectionEvidenceSnapshot }>, signal: AbortSignal): Promise<TrustedInstallCandidateResult>;
  validate(candidate: TrustedInstallCandidate, signal: AbortSignal): Promise<"current" | "stale">;
}

export type TrustedInstallCandidateResult =
  | Readonly<{ kind: "ready"; candidate: TrustedInstallCandidate }>
  | Readonly<{ kind: "stale" | "unavailable" | "rejected"; diagnostics: readonly import("./native-inspection-contract.js").NativeDiagnostic[] }>
  | Readonly<{
      kind: "cleanup-failed";
      cleanup: CandidateContentCleanupRecovery;
      diagnostics: readonly import("./native-inspection-contract.js").NativeDiagnostic[];
    }>;

function leaseCleanupRecovery(lease: CandidateContentLease): CandidateContentCleanupRecovery {
  return Object.freeze({ retry: () => lease.release() }) as CandidateContentCleanupRecovery;
}

async function releaseForResult(
  lease: CandidateContentLease,
  result: Exclude<TrustedInstallCandidateResult, { kind: "ready" | "cleanup-failed" }>,
): Promise<TrustedInstallCandidateResult> {
  try {
    await lease.release();
    return result;
  } catch (error) {
    return {
      kind: "cleanup-failed",
      cleanup: isCandidateContentCleanupError(error) ? error.recovery : leaseCleanupRecovery(lease),
      diagnostics: result.diagnostics,
    };
  }
}

function sameScope(left: ReturnType<typeof toScopeReference>, right: CandidateInspectionDetailSubject["scope"]): boolean {
  return left.kind === right.kind && (left.kind === "user" || (right.kind === "project" && left.projectKey === right.projectKey));
}

function exactCandidate(candidate: ResolvedMarketplaceCandidate, subject: CandidateInspectionDetailSubject): boolean {
  return candidate.id === subject.candidateId && candidate.registrationId === subject.registrationId &&
    candidate.snapshot === subject.catalogSnapshot && candidate.entry.identity.value.key === subject.plugin &&
    sameScope(toScopeReference(candidate.scope), subject.scope);
}

function catalogAuthority(
  snapshot: InspectionEvidenceSnapshot,
  subject: CandidateInspectionDetailSubject,
): "current" | "stale" | "unavailable" {
  const scopes = snapshot.binding.scopes.filter((candidate) => sameScope(candidate.scope, subject.scope));
  if (scopes.length !== 1) return scopes.length === 0 ? "stale" : "unavailable";
  if (scopes[0]!.status !== "ready" || scopes[0]!.generation === undefined) return "unavailable";
  const bindings = snapshot.binding.catalogs.filter((catalog) =>
    catalog.registrationId === subject.registrationId && sameScope(catalog.scope, subject.scope));
  if (bindings.length !== 1) return bindings.length === 0 ? "stale" : "unavailable";
  const selected = bindings[0]!;
  if (selected.snapshot !== subject.catalogSnapshot) return "stale";
  if (selected.cache.kind === "corrupt" || selected.cache.kind === "unavailable" || selected.cache.kind === "not-materialized") {
    return "unavailable";
  }
  return "current";
}

function safe(value: string, maxScalars: number = NativeDisplayLimits.labelScalars) {
  return toSafeDisplayField(value, { maxScalars });
}

function defaultView(option: import("../domain/configuration.js").ConfigurationOption): unknown {
  if (!("default" in option.value) || option.value.default === undefined || option.sensitive) return undefined;
  switch (option.value.kind) {
    case "string": return { kind: "string", value: safe(option.value.default!) };
    case "number": return { kind: "number", value: option.value.default! };
    case "boolean": return { kind: "boolean", value: option.value.default! };
    case "strings": return { kind: "strings", values: option.value.default!.map((entry) => safe(entry)) };
    case "directory": return { kind: "directory", value: safe(option.value.default!, NativeDisplayLimits.pathScalars) };
    case "file": return { kind: "file", value: safe(option.value.default!, NativeDisplayLimits.pathScalars) };
  }
}

function fields(
  plugin: TrustedInstallCandidate["plugin"],
  readiness: readonly import("./native-inspection-contract.js").NativeConfigurationOptionView[],
): readonly TrustedInstallConfigurationField[] {
  const state = new Map(readiness.map((field) => [field.key, field.state]));
  return Object.freeze(plugin.configuration.options.map((option) => {
    const constraints = option.value.kind === "string" ? { ...(option.value.pattern === undefined ? {} : { pattern: safe(option.value.pattern, NativeDisplayLimits.descriptionScalars) }) }
      : option.value.kind === "number" ? { ...(option.value.min === undefined ? {} : { min: option.value.min }), ...(option.value.max === undefined ? {} : { max: option.value.max }) }
      : option.value.kind === "strings" ? { ...(option.value.minItems === undefined ? {} : { minItems: option.value.minItems }), ...(option.value.maxItems === undefined ? {} : { maxItems: option.value.maxItems }) }
      : option.value.kind === "directory" || option.value.kind === "file" ? { mustExist: option.value.mustExist }
      : {};
    const projectedDefault = defaultView(option);
    return TrustedInstallConfigurationFieldSchema.parse({
      key: option.key,
      label: safe(option.label.value),
      ...(option.description === undefined ? {} : { description: safe(option.description.value, NativeDisplayLimits.descriptionScalars) }),
      kind: option.value.kind,
      required: option.required,
      sensitive: option.sensitive,
      defaultPresent: projectedDefault !== undefined,
      ...(projectedDefault === undefined ? {} : { default: projectedDefault }),
      constraints,
      state: state.get(option.key) ?? (projectedDefault === undefined ? "missing" : "defaulted"),
    });
  }).sort((left, right) => compareUtf8(left.key, right.key)));
}

function subagentInterception(plugin: TrustedInstallCandidate["plugin"], snapshot: InspectionEvidenceSnapshot) {
  const declared = plugin.components.hooks.some((hook) => hook.event.value === "SubagentStart" || hook.event.value === "SubagentStop");
  if (!declared) return "not-declared" as const;
  return snapshot.capabilities?.capabilities[RuntimeCapabilityRegistry.subagentInterception.id]?.status === "available"
    ? "available" as const : "unavailable" as const;
}

function displayComplete(field: { truncated: boolean } | undefined): boolean {
  return field === undefined || !field.truncated;
}

/** Consent never silently drops or truncates a launch-bearing declaration. */
function executableDisclosureComplete(
  plugin: TrustedInstallCandidate["plugin"],
  components: NativeComponentInventoryView,
): boolean {
  if (components.skills.some((component) => !displayComplete(component.name) || !displayComplete(component.root))) return false;
  for (const component of components.hooks) {
    if (!displayComplete(component.event) || !displayComplete(component.matcher) || !displayComplete(component.handler.command)) return false;
    if (component.handler.kind === "exec") {
      const source = plugin.components.hooks.find((candidate) => candidate.id === component.componentId);
      if (source?.handler.value.kind !== "exec" || source.handler.value.args.length !== component.handler.args.length ||
          component.handler.args.some((argument) => !displayComplete(argument))) return false;
    }
  }
  for (const component of components.mcpServers) {
    if (!displayComplete(component.nativeKey) || !displayComplete(component.command) ||
        component.args.some((argument) => !displayComplete(argument)) ||
        component.environmentNames.some((name) => !displayComplete(name)) ||
        component.headerNames.some((name) => !displayComplete(name)) ||
        component.toolPolicy.allowed.some((name) => !displayComplete(name)) ||
        component.toolPolicy.denied.some((name) => !displayComplete(name)) ||
        !displayComplete(component.url?.host) || !displayComplete(component.url?.port) || !displayComplete(component.url?.path)) return false;
    const source = plugin.components.mcpServers.find((candidate) => candidate.id === component.componentId);
    if (source === undefined) return false;
    try {
      const template = createMcpLaunchTemplate(source, plugin.identity.key);
      if (template.transport === "stdio") {
        if (component.args.length !== template.args.length || component.environmentNames.length !== template.env.length) return false;
      } else {
        const authenticationEnvironmentCount = template.bearerToken?.kind === "environment" ? 1 : 0;
        if (component.headerNames.length !== template.headers.length || component.environmentNames.length !== authenticationEnvironmentCount) return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function nativeDetail(
  subject: CandidateInspectionDetailSubject,
  snapshot: InspectionEvidenceSnapshot,
  candidate: ResolvedMarketplaceCandidate,
  lease: CandidateContentLease,
  dependencies: TrustedInstallCandidateDependencies,
  signal: AbortSignal,
): Promise<NativeInspectionDetailResult> {
  const inspector = createNativeCandidateInspector({
    catalog: { resolve: async () => ({ kind: "resolved" as const, candidate }) },
    content: { withMaterialized: async (_candidate, useSignal, use) => { useSignal.throwIfAborted(); return use(lease.materialized); } },
    inspector: dependencies.inspector,
    readiness: dependencies.readiness,
    sha256: dependencies.sha256,
  });
  return NativeInspectionDetailResultSchema.parse(await inspector.inspect(subject, snapshot, signal));
}

export function createTrustedInstallCandidateService(dependencies: TrustedInstallCandidateDependencies): TrustedInstallCandidateService {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") throw new TypeError("trusted-install candidate dependencies are required");

  async function acquire(
    request: Readonly<{ subject: CandidateInspectionDetailSubject; snapshot: InspectionEvidenceSnapshot }>,
    signal: AbortSignal,
  ): Promise<TrustedInstallCandidateResult> {
    signal.throwIfAborted();
    const authority = catalogAuthority(request.snapshot, request.subject);
    if (authority === "stale") return { kind: "stale", diagnostics: [] };
    if (authority === "unavailable") return { kind: "unavailable", diagnostics: [] };
    if (request.subject.scope.kind === "project" &&
        (request.snapshot.binding.currentProject.projectKey !== request.subject.scope.projectKey || request.snapshot.binding.currentProject.trust.kind !== "trusted")) {
      return { kind: "rejected", diagnostics: [] };
    }
    const resolution = await dependencies.catalog.resolve({ candidateId: request.subject.candidateId, snapshot: request.subject.catalogSnapshot }, signal)
      .catch(() => ({ kind: "catalog-unavailable" as const }));
    if (resolution.kind === "candidate-stale" || resolution.kind === "candidate-missing") return { kind: "stale", diagnostics: [] };
    if (resolution.kind !== "resolved") return { kind: "unavailable", diagnostics: [] };
    if (!exactCandidate(resolution.candidate, request.subject)) return { kind: "stale", diagnostics: [] };

    let lease: CandidateContentLease;
    try { lease = await dependencies.content.acquire(resolution.candidate, signal); }
    catch (error) {
      if (isCandidateContentCleanupError(error)) {
        return { kind: "cleanup-failed", cleanup: error.recovery, diagnostics: [] };
      }
      if (signal.aborted) throw signal.reason ?? error;
      return { kind: "unavailable", diagnostics: [] };
    }
    try {
      const inspected = await dependencies.inspector.inspect({ entry: resolution.candidate.entry, materialized: lease.materialized }, signal);
      const detailResult = await nativeDetail(request.subject, request.snapshot, resolution.candidate, lease, dependencies, signal);
      if (detailResult.kind !== "found") {
        if (detailResult.kind === "stale" || detailResult.kind === "missing" || detailResult.kind === "invalid-id") {
          return releaseForResult(lease, { kind: "stale", diagnostics: [] });
        }
        return releaseForResult(lease, { kind: "unavailable", diagnostics: detailResult.diagnostics });
      }
      const detail = detailResult.detail;
      if (!inspected.ok || inspected.value.identity.key !== request.subject.plugin || request.snapshot.capabilities === undefined || request.snapshot.binding.capability.digest === undefined) {
        return releaseForResult(lease, { kind: "rejected", diagnostics: detail.diagnostics });
      }
      const plugin = inspected.value;
      const compatibility = CompatibilityReportSchema.parse(evaluateCompatibility({
        plugin,
        capabilities: request.snapshot.capabilities,
        ...(resolution.candidate.entry.policy === undefined ? {} : { marketplacePolicy: resolution.candidate.entry.policy }),
      }));
      if (!compatibility.activatable) {
        return releaseForResult(lease, { kind: "rejected", diagnostics: detail.diagnostics });
      }
      const components = projectSafeComponents({ plugin, compatibility });
      if (!executableDisclosureComplete(plugin, components)) {
        return releaseForResult(lease, { kind: "rejected", diagnostics: detail.diagnostics });
      }
      const consentDisclosureDigest = deriveTrustedInstallConsentDisclosureDigest(components, dependencies.sha256);
      const scope = toScopeReference(resolution.candidate.scope);
      const trust = createTrustCandidate({
        scope,
        marketplaceSource: resolution.candidate.marketplace.source,
        plugin,
        compatibility,
        content: lease.materialized.content,
        materializationBinding: lease.materialized.binding,
      }, dependencies.sha256);
      const revision = createInstalledRevisionRecord({
        plugin,
        compatibility,
        content: lease.materialized.content,
        scope,
        marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(resolution.candidate.marketplace.source.declared, dependencies.sha256),
        pluginSourceIdentity: derivePluginSourceIdentity(resolution.candidate.entry.source.value, dependencies.sha256),
        ...(plugin.version?.value === undefined && resolution.candidate.entry.version?.value === undefined ? {} : { declaredVersion: plugin.version?.value ?? resolution.candidate.entry.version?.value }),
      }, dependencies.sha256);
      const binding = TrustedInstallCandidateBindingSchema.parse({
        scope,
        registrationId: resolution.candidate.registrationId,
        candidateId: resolution.candidate.id,
        catalogSnapshot: resolution.candidate.snapshot,
        plugin: plugin.identity.key,
        sourceIdentity: lease.materialized.source.hash,
        immutableRevision: revision.revision,
        contentDigest: lease.materialized.content.rootDigest,
        compatibilityFingerprint: digestCompatibilityReport(compatibility, dependencies.sha256),
        configurationDescriptorDigest: digestConfigurationDescriptors(plugin.configuration, dependencies.sha256),
        consentDisclosureDigest,
        ...(revision.configurationRef === undefined ? {} : { configurationRef: revision.configurationRef }),
        trustSubject: trust.subject,
        executableSurfaceDigest: trust.evidence.executableSurfaceDigest,
        capabilityDigest: request.snapshot.binding.capability.digest,
        ...(scope.kind === "project" ? { projectEpoch: request.snapshot.binding.currentProject.epoch } : {}),
      });
      const exactDetail = detail.snapshotId === deriveInspectionEvidenceSnapshotId(request.snapshot.binding, dependencies.sha256) &&
        detail.summary.detailId === deriveInspectionDetailId(request.subject, dependencies.sha256) &&
        detail.summary.subject === "marketplace-candidate" && detail.summary.plugin === binding.plugin &&
        sameScope(detail.summary.scope, binding.scope) && detail.summary.revision.immutable === binding.immutableRevision &&
        detail.source.identity === binding.sourceIdentity && detail.compatibility.status === "activatable" &&
        detail.compatibility.reportFingerprint === binding.compatibilityFingerprint;
      if (!exactDetail || detail.summary.condition === "unavailable" || detail.trust === "unavailable" || detail.trust === "project-untrusted") {
        return releaseForResult(lease, {
          kind: detail.summary.condition === "unavailable" || detail.trust === "unavailable" ? "unavailable" : "rejected",
          diagnostics: detail.diagnostics,
        });
      }
      // Candidate inspection has no installed-revision reference. The install
      // form does, so enrich its field state from that exact configuration
      // authority without changing the parsed inspection result.
      const configurationReadiness = await dependencies.readiness.configuration({
        plugin: plugin.identity.key,
        scope,
        descriptors: plugin.configuration,
        ...(revision.configurationRef === undefined ? {} : { configurationRef: revision.configurationRef }),
      }, signal);
      const configurationFields = fields(plugin, configurationReadiness);
      const consent = TrustedInstallConsentDisclosureSchema.parse({
        consentId: deriveTrustedInstallConsentId(binding, dependencies.sha256),
        source: projectSafeSource(lease.materialized.source),
        immutableRevision: revision.revision,
        executableSurfaceDigest: trust.evidence.executableSurfaceDigest,
        components,
        requirements: detail.compatibility.requirements,
        persistentData: true,
        configurationEnvironmentNames: plugin.configuration.options.map((option) => safe(`CLAUDE_PLUGIN_OPTION_${option.key}`)).sort((left, right) => compareUtf8(left.text, right.text)),
        subagentInterception: subagentInterception(plugin, request.snapshot),
        remoteMcpDiscovery: "not-performed",
        statement: safe("Grant trust to this exact revision and executable surface.", NativeDisplayLimits.descriptionScalars),
      });
      return { kind: "ready", candidate: Object.freeze({ lease, resolved: resolution.candidate, plugin, compatibility, revision, trust, binding, detail, fields: configurationFields, consent, snapshotBinding: request.snapshot.binding }) };
    } catch (error) {
      const released = await releaseForResult(lease, { kind: "rejected", diagnostics: [] });
      if (released.kind === "cleanup-failed") return released;
      if (signal.aborted) throw signal.reason ?? error;
      return released;
    }
  }

  const service: TrustedInstallCandidateService = {
    acquire,
    async validate(candidate: TrustedInstallCandidate, signal: AbortSignal) {
      const resolved = await dependencies.catalog.resolve({ candidateId: candidate.binding.candidateId, snapshot: candidate.binding.catalogSnapshot }, signal).catch(() => undefined);
      return resolved?.kind === "resolved" && exactCandidate(resolved.candidate, {
        version: 1, subject: "marketplace-candidate", scope: candidate.binding.scope, plugin: candidate.binding.plugin,
        registrationId: candidate.binding.registrationId, candidateId: candidate.binding.candidateId, catalogSnapshot: candidate.binding.catalogSnapshot,
      }) ? "current" : "stale";
    },
  };
  return Object.freeze(service);
}

export const acquireTrustedInstallCandidate = (
  request: Readonly<{ subject: CandidateInspectionDetailSubject; snapshot: InspectionEvidenceSnapshot }>,
  dependencies: TrustedInstallCandidateDependencies,
  signal: AbortSignal,
): Promise<TrustedInstallCandidateResult> => createTrustedInstallCandidateService(dependencies).acquire(request, signal);
