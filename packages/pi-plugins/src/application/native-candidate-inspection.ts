import { evaluateCompatibility } from "../domain/compatibility-evaluator.js";
import { CompatibilityReportSchema } from "../domain/compatibility.js";
import { compareUtf8 } from "../domain/canonical-json.js";
import { parsePluginKey } from "../domain/identity.js";
import { createTrustCandidate } from "../domain/trust-policy.js";
import { toScopeReference } from "../domain/state/scope.js";
import { digestCompatibilityReport } from "./ports/runtime-projection.js";
import type { PluginInspectionService } from "./inspection-service.js";
import type { MarketplaceCatalogService } from "./marketplace-catalog-service.js";
import type { CandidateContentLeasePort } from "./ports/candidate-content-lease.js";
import type { InspectionReadinessPort } from "./ports/inspection-readiness.js";
import type { InspectionEvidenceSnapshot } from "./ports/native-inspection-evidence.js";
import type { Sha256 } from "../domain/source.js";
import {
  NativeCompatibilityViewSchema,
  NativeInspectionDetailResultSchema,
  NativeInspectionDetailSchema,
  NativeInspectionSummarySchema,
  type NativeInspectionDetailResult,
} from "./native-inspection-contract.js";
import {
  countNativeDiagnostics,
  compileNativeDiagnostics,
  deriveNativeInspectionCondition,
  unavailableEvidenceFinding,
  type NativeDiagnosticInput,
} from "./native-diagnostic-compiler.js";
import { projectInspectionFailureFindings } from "./inspection-failure-projection.js";
import { projectSafeComponents, projectSafeProvenance, projectSafeSource } from "./native-inspection-disclosure.js";
import { NativeDisplayLimits, toSafeDisplayField } from "./native-inspection-display.js";
import {
  deriveInspectionDetailId,
  deriveInspectionEvidenceSnapshotId,
  type CandidateInspectionDetailSubject,
} from "./native-inspection-identifiers.js";

export type MarketplaceCatalogResolverPort = Pick<MarketplaceCatalogService, "resolve">;
export type CandidateInspectionSubject = CandidateInspectionDetailSubject;

export type CandidateInspectionDependencies = Readonly<{
  catalog: MarketplaceCatalogResolverPort;
  content: Pick<CandidateContentLeasePort, "withMaterialized">;
  inspector: PluginInspectionService;
  readiness: InspectionReadinessPort;
  sha256: Sha256;
}>;

function safe(value: string, maxScalars: number = NativeDisplayLimits.labelScalars) {
  return toSafeDisplayField(value, { maxScalars });
}

function sourceRevision(source: import("../domain/source.js").ResolvedPluginSource): string {
  if (source.kind === "npm") return source.version;
  if (source.kind === "marketplace-path") return source.marketplaceRevision;
  return source.revision;
}

function selectedConfigurationRef(
  subject: CandidateInspectionSubject,
  snapshot: InspectionEvidenceSnapshot,
): import("../domain/configured-values.js").PluginConfigurationRef | undefined {
  const state = snapshot.states.find((result) => result.ok &&
    JSON.stringify(toScopeReference(result.snapshot.scope)) === JSON.stringify(subject.scope));
  if (state === undefined || !state.ok) return undefined;
  const plugins = "installed" in state.snapshot ? state.snapshot.installed.plugins : state.snapshot.project.plugins;
  const record = plugins.find((plugin) => plugin.plugin === subject.plugin);
  return record?.revisions.find((revision) => revision.revision === record.selectedRevision)?.configurationRef;
}

function finding(key: NativeDiagnosticInput["findings"][number]["key"], subjectId: import("./native-inspection-contract.js").InspectionDetailId, componentId?: import("../domain/components.js").ComponentId): NativeDiagnosticInput["findings"][number] {
  return { key, subjectId, ...(componentId === undefined ? {} : { componentId }) };
}

function catalogFinding(
  snapshot: InspectionEvidenceSnapshot,
  registrationId: CandidateInspectionSubject["registrationId"],
  detailId: import("./native-inspection-contract.js").InspectionDetailId,
): NativeDiagnosticInput["findings"][number] {
  const cache = snapshot.binding.catalogs.find((catalog) => catalog.registrationId === registrationId)?.cache;
  return finding(cache?.kind === "corrupt" ? "catalogCorrupt" : "catalogUnavailable", detailId);
}

/** Exact, read-only candidate detail projection with disposable acquisition. */
export function createNativeCandidateInspector(dependencies: CandidateInspectionDependencies): Readonly<{
  inspect(subject: CandidateInspectionSubject, snapshot: InspectionEvidenceSnapshot, signal: AbortSignal): Promise<NativeInspectionDetailResult>;
}> {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") {
    throw new TypeError("candidate inspection dependencies are required");
  }

  return Object.freeze({
    async inspect(subjectInput, snapshot, signal) {
      signal.throwIfAborted();
      const subject = subjectInput;
      const snapshotId = deriveInspectionEvidenceSnapshotId(snapshot.binding, dependencies.sha256);
      const detailId = deriveInspectionDetailId(subject, dependencies.sha256);
      let resolved: Awaited<ReturnType<MarketplaceCatalogResolverPort["resolve"]>>;
      try {
        resolved = await dependencies.catalog.resolve({ candidateId: subject.candidateId, snapshot: subject.catalogSnapshot }, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        const diagnostics = compileNativeDiagnostics({ findings: [catalogFinding(snapshot, subject.registrationId, detailId)] }, dependencies.sha256);
        const names = parsePluginKey(subject.plugin);
        const summary = NativeInspectionSummarySchema.parse({
          detailId, subject: subject.subject, scope: subject.scope, plugin: subject.plugin,
          name: safe(names.plugin), marketplace: safe(names.marketplace), revision: { resolution: "unresolved" },
          condition: deriveNativeInspectionCondition(diagnostics), freshness: { status: "unavailable", basis: "marketplace" },
          diagnosticCounts: countNativeDiagnostics(diagnostics),
        });
        return NativeInspectionDetailResultSchema.parse({ kind: "unavailable", summary, diagnostics });
      }
      if (resolved.kind === "candidate-stale") return NativeInspectionDetailResultSchema.parse({ kind: "stale", action: "retry-read" });
      if (resolved.kind === "candidate-missing") return NativeInspectionDetailResultSchema.parse({ kind: "missing" });
      if (resolved.kind === "catalog-unavailable") {
        const diagnostics = compileNativeDiagnostics({ findings: [catalogFinding(snapshot, subject.registrationId, detailId)] }, dependencies.sha256);
        const names = parsePluginKey(subject.plugin);
        const summary = NativeInspectionSummarySchema.parse({
          detailId,
          subject: subject.subject,
          scope: subject.scope,
          plugin: subject.plugin,
          name: safe(names.plugin),
          marketplace: safe(names.marketplace),
          revision: { resolution: "unresolved" },
          condition: deriveNativeInspectionCondition(diagnostics),
          freshness: { status: "unavailable", basis: "marketplace" },
          diagnosticCounts: countNativeDiagnostics(diagnostics),
        });
        return NativeInspectionDetailResultSchema.parse({ kind: "unavailable", summary, diagnostics });
      }
      if (resolved.kind !== "resolved") return NativeInspectionDetailResultSchema.parse({ kind: "missing" });
      const candidate = resolved.candidate;
      if (candidate.registrationId !== subject.registrationId || candidate.snapshot !== subject.catalogSnapshot ||
          candidate.id !== subject.candidateId || candidate.entry.identity.value.key !== subject.plugin ||
          JSON.stringify(candidate.scope.kind === "user" ? { kind: "user" } : { kind: "project", projectKey: candidate.scope.projectKey }) !== JSON.stringify(subject.scope)) {
        return NativeInspectionDetailResultSchema.parse({ kind: "missing" });
      }

      try {
        return await dependencies.content.withMaterialized(candidate, signal, async (materialized) => {
          const inspected = await dependencies.inspector.inspect({ entry: candidate.entry, materialized }, signal);
          if (!inspected.ok) {
            // Surface the real inspection failures (document, pointer,
            // reason vocabulary) alongside the umbrella blocking code —
            // "source invalid" alone is not actionable.
            const diagnostics = compileNativeDiagnostics(
              { findings: projectInspectionFailureFindings(inspected.diagnostics, detailId) },
              dependencies.sha256,
            );
            const names = parsePluginKey(subject.plugin);
            const summary = NativeInspectionSummarySchema.parse({
              detailId, subject: subject.subject, scope: subject.scope, plugin: subject.plugin,
              name: safe(names.plugin), marketplace: safe(names.marketplace),
              revision: { available: safe(sourceRevision(materialized.source)), immutable: materialized.binding, resolution: "exact" },
              condition: deriveNativeInspectionCondition(diagnostics), freshness: { status: "current", basis: "marketplace" },
              diagnosticCounts: countNativeDiagnostics(diagnostics),
            });
            return NativeInspectionDetailResultSchema.parse({ kind: "unavailable", summary, diagnostics });
          }
          const plugin = inspected.value;
          if (plugin.identity.key !== subject.plugin) {
            const diagnostics = compileNativeDiagnostics({ findings: [finding("sourceInvalid", detailId)] }, dependencies.sha256);
            return NativeInspectionDetailResultSchema.parse({ kind: "unavailable", diagnostics });
          }

          const report = snapshot.capabilities === undefined
            ? undefined
            : CompatibilityReportSchema.parse(evaluateCompatibility({
                plugin,
                capabilities: snapshot.capabilities,
                ...(candidate.entry.policy === undefined ? {} : { marketplacePolicy: candidate.entry.policy }),
              }));
          let configuration: Awaited<ReturnType<InspectionReadinessPort["configuration"]>> = [];
          let configurationUnavailable = false;
          try {
            const configurationRef = selectedConfigurationRef(subject, snapshot);
            configuration = await dependencies.readiness.configuration({
              plugin: subject.plugin,
              scope: subject.scope,
              descriptors: plugin.configuration,
              ...(configurationRef === undefined ? {} : { configurationRef }),
            }, signal);
          } catch (error) {
            if (signal.aborted) throw signal.reason ?? error;
            configurationUnavailable = true;
          }
          let trust: import("./native-inspection-contract.js").NativeTrustReadiness = "not-applicable";
          if (report?.activatable === true) {
            const trustCandidate = createTrustCandidate({
              scope: subject.scope,
              marketplaceSource: candidate.marketplace.source,
              plugin,
              compatibility: report,
              content: materialized.content,
              materializationBinding: materialized.binding,
            }, dependencies.sha256);
            try {
              trust = await dependencies.readiness.trust(trustCandidate, subject.scope, signal);
            } catch (error) {
              if (signal.aborted) throw signal.reason ?? error;
              trust = "unavailable";
            }
          }

          const findings: NativeDiagnosticInput["findings"][number][] = [];
          if (report === undefined) findings.push(finding("capabilityUnavailable", detailId));
          else {
            if (!report.activatable) findings.push(finding("incompatible", detailId));
            for (const assessment of report.requirements) {
              if (assessment.status === "unavailable") {
                for (const component of report.components.filter((item) => item.requirementIds.includes(assessment.requirement.id))) {
                  findings.push(finding("requirementUnavailable", detailId, component.componentId));
                }
              }
            }
          }
          if (trust === "required") findings.push(finding("trustRequired", detailId));
          else if (trust === "revoked") findings.push(finding("trustRevoked", detailId));
          else if (trust === "invalid-evidence") findings.push(finding("trustInvalid", detailId));
          else if (trust === "project-untrusted") findings.push(finding("projectUntrusted", detailId));
          else if (trust === "unavailable") findings.push(unavailableEvidenceFinding("trust", detailId));
          if (configurationUnavailable) findings.push(unavailableEvidenceFinding("configuration", detailId));
          let requiredConfigurationUnavailable = false;
          for (const option of configuration) {
            if (option.required && option.state === "missing") findings.push(finding("configurationRequired", detailId));
            if (option.state === "invalid") findings.push(finding("configurationInvalid", detailId));
            if (option.required && option.state === "unavailable") {
              if (option.sensitive) findings.push(finding("secretCustodyUnavailable", detailId));
              else requiredConfigurationUnavailable = true;
            }
          }
          if (requiredConfigurationUnavailable) findings.push(unavailableEvidenceFinding("configuration", detailId));
          const catalogBinding = snapshot.binding.catalogs.find((catalog) => catalog.registrationId === subject.registrationId);
          if (catalogBinding?.cache.kind === "corrupt") findings.push(finding("catalogCorrupt", detailId));
          else if (catalogBinding?.cache.kind === "stale") findings.push(finding("catalogStale", detailId));
          else if (catalogBinding === undefined || ["unavailable", "not-materialized"].includes(catalogBinding.cache.kind)) findings.push(finding("catalogUnavailable", detailId));
          const diagnostics = compileNativeDiagnostics({ findings }, dependencies.sha256);
          const condition = deriveNativeInspectionCondition(diagnostics);
          const names = parsePluginKey(subject.plugin);
          const revision = sourceRevision(materialized.source);
          const freshness = catalogBinding?.cache.kind === "stale" ? "stale" : catalogBinding?.cache.kind === "unknown-local" ? "unknown" : "current";
          const summary = NativeInspectionSummarySchema.parse({
            detailId,
            subject: subject.subject,
            scope: subject.scope,
            plugin: subject.plugin,
            name: safe(plugin.identity.manifestName ?? plugin.identity.marketplaceEntryName),
            marketplace: safe(names.marketplace),
            revision: { available: safe(plugin.version?.value ?? revision), immutable: materialized.binding, resolution: "exact" },
            condition,
            freshness: { status: freshness, basis: "marketplace" },
            diagnosticCounts: countNativeDiagnostics(diagnostics),
          });
          const compatibility = NativeCompatibilityViewSchema.parse({
            status: report === undefined ? "unavailable" : report.activatable ? "activatable" : "incompatible",
            ...(report === undefined ? {} : { reportFingerprint: digestCompatibilityReport(report, dependencies.sha256) }),
            components: projectSafeComponents({ plugin, ...(report === undefined ? {} : { compatibility: report }) }),
            requirements: (report?.requirements ?? []).map((assessment) => ({
              id: assessment.requirement.id,
              capability: safe(assessment.requirement.capability),
              status: assessment.status,
              explanation: safe(assessment.explanation, NativeDisplayLimits.descriptionScalars),
              provenance: projectSafeProvenance(assessment.requirement.provenance),
            })).sort((left, right) => compareUtf8(left.id, right.id)),
          });
          return NativeInspectionDetailResultSchema.parse({
            kind: "found",
            detail: NativeInspectionDetailSchema.parse({
              snapshotId,
              summary,
              source: projectSafeSource(materialized.source),
              provenance: projectSafeProvenance([...candidate.entry.identity.provenance, ...candidate.entry.source.provenance]),
              compatibility,
              trust,
              configuration,
              lifecycle: { installed: false, transition: "none", update: "not-applicable" },
              diagnostics,
            }),
          });
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        const diagnostics = compileNativeDiagnostics({ findings: [finding("sourceUnavailable", detailId)] }, dependencies.sha256);
        const names = parsePluginKey(subject.plugin);
        const summary = NativeInspectionSummarySchema.parse({
          detailId, subject: subject.subject, scope: subject.scope, plugin: subject.plugin,
          name: safe(names.plugin), marketplace: safe(names.marketplace), revision: { resolution: "unresolved" },
          condition: deriveNativeInspectionCondition(diagnostics), freshness: { status: "unavailable", basis: "marketplace" },
          diagnosticCounts: countNativeDiagnostics(diagnostics),
        });
        return NativeInspectionDetailResultSchema.parse({ kind: "unavailable", summary, diagnostics });
      }
    },
  });
}
