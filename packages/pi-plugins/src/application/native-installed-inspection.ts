import { evaluateCompatibility } from "../domain/compatibility-evaluator.js";
import { CompatibilityReportSchema } from "../domain/compatibility.js";
import { compareUtf8 } from "../domain/canonical-json.js";
import type { ComponentId } from "../domain/components.js";
import { parsePluginKey } from "../domain/identity.js";
import type { InstalledPluginRecord, InstalledRevisionRecord } from "../domain/state/installed-state.js";
import { toScopeReference, type ScopeContext, type ScopeReference } from "../domain/state/scope.js";
import { createTrustCandidate } from "../domain/trust-policy.js";
import type { InstalledPluginLoader } from "./ports/installed-plugin-loader.js";
import type { InspectionReadinessPort } from "./ports/inspection-readiness.js";
import type { InspectionEvidenceSnapshot, InstalledRuntimeEvidence } from "./ports/native-inspection-evidence.js";
import { digestCompatibilityReport } from "./ports/runtime-projection.js";
import { marketplaceUpdateRecords } from "./marketplace-update-state.js";
import type { Sha256 } from "../domain/source.js";
import { deriveMarketplaceSourceIdentity } from "../domain/update-policy.js";
import { resolveEffectiveUpdatePolicy } from "./update-policy-resolution.js";
import {
  NativeActivationViewSchema,
  NativeCompatibilityViewSchema,
  NativeInspectionDetailResultSchema,
  NativeInspectionDetailSchema,
  NativeInspectionSummarySchema,
  NativeMcpHealthViewSchema,
  type NativeInspectionDetailResult,
  type NativeTrustReadiness,
} from "./native-inspection-contract.js";
import {
  countNativeDiagnostics,
  compileNativeDiagnostics,
  deriveNativeInspectionCondition,
  unavailableEvidenceFinding,
  type NativeDiagnosticInput,
} from "./native-diagnostic-compiler.js";
import { projectSafeComponents, projectSafeProvenance, projectSafeSource } from "./native-inspection-disclosure.js";
import { NativeDisplayLimits, toSafeDisplayField } from "./native-inspection-display.js";
import {
  deriveInspectionDetailId,
  deriveInspectionEvidenceSnapshotId,
  type InstalledInspectionDetailSubject,
} from "./native-inspection-identifiers.js";

export type NativeInstalledInspector = Readonly<{
  inspect(subject: InstalledInspectionDetailSubject, snapshot: InspectionEvidenceSnapshot, signal: AbortSignal): Promise<NativeInspectionDetailResult>;
}>;

function safe(value: string, maxScalars: number = NativeDisplayLimits.labelScalars) {
  return toSafeDisplayField(value, { maxScalars });
}

function sameScope(left: ScopeReference, right: ScopeReference): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stateRecord(subject: InstalledInspectionDetailSubject, snapshot: InspectionEvidenceSnapshot): Readonly<{
  scope: ScopeContext;
  record: InstalledPluginRecord;
  revision?: InstalledRevisionRecord;
}> | "corrupt" | undefined {
  const result = snapshot.states.find((candidate) => sameScope(toScopeReference(candidate.ok ? candidate.snapshot.scope : candidate.scope), subject.scope));
  if (result === undefined) return undefined;
  if (!result.ok) return "corrupt";
  const records = "installed" in result.snapshot ? result.snapshot.installed.plugins : result.snapshot.project.plugins;
  const record = records.find((candidate) => candidate.plugin === subject.plugin);
  if (record === undefined || record.selectedRevision !== subject.selectedRevision) return undefined;
  const revision = record.revisions.find((candidate) => candidate.revision === record.selectedRevision);
  return { scope: result.snapshot.scope, record, ...(revision === undefined ? {} : { revision }) };
}

function finding(key: NativeDiagnosticInput["findings"][number]["key"], subjectId: import("./native-inspection-contract.js").InspectionDetailId, componentId?: ComponentId): NativeDiagnosticInput["findings"][number] {
  return { key, subjectId, ...(componentId === undefined ? {} : { componentId }) };
}

function sorted(values: readonly ComponentId[]): readonly ComponentId[] {
  return [...values].sort(compareUtf8);
}

function sameIds(left: readonly ComponentId[], right: readonly ComponentId[]): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function recoveryTransition(subject: InstalledInspectionDetailSubject, snapshot: InspectionEvidenceSnapshot): "none" | "deferred" | "blocked" | "recovery-required" {
  const matches = snapshot.recovery.results.filter((result) =>
    sameScope(result.scope, subject.scope) && result.plugin === subject.plugin);
  if (matches.some((result) => result.kind === "blocked")) return "blocked";
  if (matches.some((result) => result.kind === "deferred")) return "deferred";
  return snapshot.startup.blocked.some((entry) => entry.plugin === subject.plugin) ? "recovery-required" : "none";
}

function updateState(
  subject: InstalledInspectionDetailSubject,
  snapshot: InspectionEvidenceSnapshot,
  revision: InstalledRevisionRecord,
  sha256: Sha256,
) {
  const loaded = snapshot.states.find((result) => result.ok && sameScope(toScopeReference(result.snapshot.scope), subject.scope));
  if (loaded === undefined || !loaded.ok) return {
    state: "unknown" as const,
    stale: false,
    policy: undefined,
    notice: undefined,
    schedule: undefined,
    updateSubsystem: undefined,
  };
  const user = snapshot.states.find((result) => result.ok && result.snapshot.scope.kind === "user");
  const global = user?.ok && "config" in user.snapshot
    ? (user.snapshot.config as typeof user.snapshot.config & { global?: { application?: "manual" | "automatic" } }).global?.application ?? "manual"
    : "manual";
  for (const registration of marketplaceUpdateRecords(loaded.snapshot)) {
    if (!subject.plugin.endsWith(`@${registration.marketplace}`)) continue;
    const notice = [...registration.notices]
      .filter((entry) => sameScope(entry.scope, subject.scope) && entry.plugin === subject.plugin)
      .sort((left, right) => right.discoveredAt - left.discoveredAt || compareUtf8(right.id, left.id))[0];
    const stale = registration.refresh.lastAttempt?.outcome === "failed" || registration.refresh.lastAttempt?.outcome === "unavailable";
    const scoped = "config" in loaded.snapshot
      ? (loaded.snapshot.config as typeof loaded.snapshot.config & { scope?: { application?: "manual" | "automatic" } }).scope?.application
      : (loaded.snapshot.project as typeof loaded.snapshot.project & { scope?: { application?: "manual" | "automatic" } }).scope?.application;
    const policy = resolveEffectiveUpdatePolicy({
      plugin: subject.plugin,
      record: registration,
      global,
      ...(scoped === undefined ? {} : { scope: scoped }),
      marketplaceSourceIdentity: revision.evidence.source.marketplaceSourceIdentity ?? "legacy-unavailable",
      registeredMarketplaceSourceIdentity: deriveMarketplaceSourceIdentity(registration.source, sha256),
      pluginSourceIdentity: revision.evidence.source.pluginSourceIdentity ?? "legacy-unavailable",
    });
    const schedule = registration.refresh.schedule;
    const scheduleView = schedule === undefined
      ? { state: "unavailable" as const }
      : snapshot.binding.capturedAt < schedule.anchorAt
        ? { state: "clock-regressed" as const, nextAt: schedule.dueAt }
        : snapshot.binding.capturedAt >= schedule.dueAt
          ? { state: "due" as const, nextAt: schedule.dueAt }
          : { state: "current" as const, nextAt: schedule.dueAt };
    return {
      state: notice === undefined ? (stale ? "failed" as const : "current" as const) : notice.disposition,
      stale,
      policy,
      ...(notice === undefined ? {} : { notice: { disposition: notice.disposition, unread: notice.unread, unresolved: notice.resolution === undefined } }),
      schedule: scheduleView,
      ...(snapshot.hostStatus === undefined ? {} : { updateSubsystem: snapshot.hostStatus.update.state }),
    };
  }
  return {
    state: "unknown" as const,
    stale: false,
    policy: undefined,
    notice: undefined,
    schedule: undefined,
    updateSubsystem: undefined,
  };
}

type ParticipantStatus = "matching" | "missing" | "mismatched" | "unavailable";

function participantStatus(input: Readonly<{
  evidence: InstalledRuntimeEvidence | undefined;
  participant: "skills-hooks" | "mcp";
  expectedSkills?: readonly ComponentId[];
  expectedHooks?: readonly ComponentId[];
  expectedMcp?: readonly ComponentId[];
  selectedRevision: string;
  activeExpected: boolean;
}>): ParticipantStatus {
  if (input.evidence === undefined) return "missing";
  if (input.participant === "skills-hooks") {
    const required = (input.expectedSkills?.length ?? 0) + (input.expectedHooks?.length ?? 0) > 0;
    const result = input.evidence.skillsHooks;
    if (result.kind === "mismatched") return "mismatched";
    if (result.kind === "unavailable") return required ? "unavailable" : "matching";
    const observation = result.observation;
    if (observation.kind === "inactive") return input.activeExpected && required ? "missing" : "matching";
    if (!input.activeExpected) return "mismatched";
    return observation.revision === input.selectedRevision && observation.projectionDigest === input.evidence.projectionDigest &&
      sameIds(observation.skillComponentIds, input.expectedSkills ?? []) && sameIds(observation.hookComponentIds, input.expectedHooks ?? [])
      ? "matching" : "mismatched";
  }

  const required = (input.expectedMcp?.length ?? 0) > 0;
  const expected = input.evidence.mcp.expected;
  const status = input.evidence.mcp.status;
  if (status.kind === "mismatched") return "mismatched";
  if (status.kind === "unavailable") return required ? "unavailable" : "matching";
  if (!input.activeExpected) {
    return expected.kind !== "source" && status.status === null ? "matching" : "mismatched";
  }
  if (!required) return expected.kind !== "source" && status.status === null ? "matching" : "mismatched";
  if (expected.kind !== "source" || status.status === null) return "missing";
  if (status.status.registrationDigest !== expected.registrationDigest || status.status.state !== "registered" ||
      status.status.identity.plugin !== input.evidence.plugin || status.status.identity.revision !== input.selectedRevision ||
      !sameScope(status.status.identity.scope, input.evidence.scope) || status.status.identity.projectionDigest !== input.evidence.projectionDigest) {
    return "mismatched";
  }
  return sameIds(status.status.servers.map((server) => server.componentId), input.expectedMcp ?? []) &&
    sameIds(expected.servers.map((server) => server.componentId), input.expectedMcp ?? [])
    ? "matching" : "mismatched";
}

function runtimeFinding(participant: "skills-hooks" | "mcp", status: ParticipantStatus): NativeDiagnosticInput["findings"][number]["key"] | undefined {
  if (status === "matching") return undefined;
  if (participant === "skills-hooks") {
    return status === "mismatched" ? "activationMismatch" : status === "missing" ? "runtimeMissing" : "projectionUnavailable";
  }
  return status === "mismatched" ? "mcpRegistrationMismatch" : status === "missing" ? "mcpRegistrationMissing" : "runtimeUnavailable";
}

/** Installed detail over one exact state/runtime evidence snapshot. */
export function createNativeInstalledInspector(dependencies: Readonly<{
  installed: InstalledPluginLoader;
  readiness: InspectionReadinessPort;
  sha256: Sha256;
}>): NativeInstalledInspector {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") {
    throw new TypeError("installed inspection dependencies are required");
  }

  return Object.freeze({
    async inspect(subject, snapshot, signal) {
      signal.throwIfAborted();
      const detailId = deriveInspectionDetailId(subject, dependencies.sha256);
      const snapshotId = deriveInspectionEvidenceSnapshotId(snapshot.binding, dependencies.sha256);
      const authority = stateRecord(subject, snapshot);
      if (authority === undefined) return NativeInspectionDetailResultSchema.parse({ kind: "missing" });
      if (authority === "corrupt") {
        const diagnostics = compileNativeDiagnostics({ findings: [finding("stateCorrupt", detailId)] }, dependencies.sha256);
        return NativeInspectionDetailResultSchema.parse({ kind: "unavailable", diagnostics });
      }
      if (authority.revision === undefined) {
        const diagnostics = compileNativeDiagnostics({ findings: [finding("revisionUnavailable", detailId)] }, dependencies.sha256);
        return NativeInspectionDetailResultSchema.parse({ kind: "unavailable", diagnostics });
      }

      let loaded: Awaited<ReturnType<InstalledPluginLoader["load"]>>;
      try {
        loaded = await dependencies.installed.load({ scope: authority.scope, revision: authority.revision }, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        const diagnostics = compileNativeDiagnostics({ findings: [finding("revisionUnavailable", detailId)] }, dependencies.sha256);
        const names = parsePluginKey(subject.plugin);
        const summary = NativeInspectionSummarySchema.parse({
          detailId, subject: "installed", scope: subject.scope, plugin: subject.plugin,
          name: safe(names.plugin), marketplace: safe(names.marketplace),
          revision: { installed: safe(subject.selectedRevision), immutable: subject.selectedRevision, resolution: "exact" },
          condition: deriveNativeInspectionCondition(diagnostics), freshness: { status: "unavailable", basis: "state" },
          diagnosticCounts: countNativeDiagnostics(diagnostics),
        });
        return NativeInspectionDetailResultSchema.parse({ kind: "unavailable", summary, diagnostics });
      }
      if (loaded.plugin.identity.key !== subject.plugin || loaded.binding !== subject.selectedRevision) {
        const diagnostics = compileNativeDiagnostics({ findings: [finding("revisionUnavailable", detailId)] }, dependencies.sha256);
        return NativeInspectionDetailResultSchema.parse({ kind: "unavailable", diagnostics });
      }

      const report = snapshot.capabilities === undefined
        ? undefined
        : CompatibilityReportSchema.parse(evaluateCompatibility({ plugin: loaded.plugin, capabilities: snapshot.capabilities }));
      let configuration: Awaited<ReturnType<InspectionReadinessPort["configuration"]>> = [];
      let configurationUnavailable = false;
      try {
        configuration = await dependencies.readiness.configuration({
          plugin: subject.plugin,
          scope: subject.scope,
          descriptors: loaded.plugin.configuration,
          ...(authority.revision.configurationRef === undefined ? {} : { configurationRef: authority.revision.configurationRef }),
        }, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        configurationUnavailable = true;
      }
      let trust: NativeTrustReadiness = "not-applicable";
      if (subject.scope.kind === "project" && snapshot.currentProject.trust.kind !== "trusted") {
        trust = "project-untrusted";
      } else if (report?.activatable === true) {
        try {
          trust = await dependencies.readiness.trust(createTrustCandidate({
            scope: subject.scope,
            marketplaceSource: loaded.marketplaceSource,
            plugin: loaded.plugin,
            compatibility: report,
            content: loaded.content,
            materializationBinding: loaded.binding,
          }, dependencies.sha256), subject.scope, signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          trust = "unavailable";
        }
      }

      const runtime = snapshot.runtime.find((candidate) => sameScope(candidate.scope, subject.scope) && candidate.plugin === subject.plugin && candidate.selectedRevision === subject.selectedRevision);
      const assessments = new Map(report?.components.map((assessment) => [assessment.componentId, assessment]) ?? []);
      const expectedSkills = loaded.plugin.components.skills.filter((component) => assessments.get(component.id)?.verdict.kind === "supported").map((component) => component.id);
      const expectedHooks = loaded.plugin.components.hooks.filter((component) => assessments.get(component.id)?.verdict.kind === "supported").map((component) => component.id);
      const expectedMcp = loaded.plugin.components.mcpServers.filter((component) => assessments.get(component.id)?.verdict.kind === "supported").map((component) => component.id);
      const activeExpected = authority.record.activation === "enabled";
      const skillsStatus = participantStatus({ evidence: runtime, participant: "skills-hooks", expectedSkills, expectedHooks, selectedRevision: subject.selectedRevision, activeExpected });
      const mcpStatus = participantStatus({ evidence: runtime, participant: "mcp", expectedMcp, selectedRevision: subject.selectedRevision, activeExpected });
      const transition = authority.record.pendingTransition !== undefined ? "pending" as const : recoveryTransition(subject, snapshot);
      const update = updateState(subject, snapshot, authority.revision, dependencies.sha256);
      const findings: NativeDiagnosticInput["findings"][number][] = [];
      if (transition === "pending") findings.push(finding("transitionPending", detailId));
      else if (transition === "deferred") findings.push(finding("recoveryDeferred", detailId));
      else if (transition === "blocked" || transition === "recovery-required") findings.push(finding("recoveryRequired", detailId));
      if (trust === "project-untrusted") findings.push(finding("projectUntrusted", detailId));
      if (report === undefined) findings.push(finding("capabilityUnavailable", detailId));
      else {
        if (!report.activatable) findings.push(finding("incompatible", detailId));
        for (const assessment of report.requirements.filter((item) => item.status === "unavailable")) {
          for (const component of report.components.filter((item) => item.requirementIds.includes(assessment.requirement.id))) {
            findings.push(finding("requirementUnavailable", detailId, component.componentId));
          }
        }
      }
      if (trust === "required") findings.push(finding("trustRequired", detailId));
      else if (trust === "revoked") findings.push(finding("trustRevoked", detailId));
      else if (trust === "invalid-evidence") findings.push(finding("trustInvalid", detailId));
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

      const configurationReady = !configurationUnavailable && !configuration.some((option) =>
        option.state === "invalid" || option.required && ["missing", "unavailable"].includes(option.state));
      const runtimeAuthorityEligible = report?.activatable === true && trust === "authorized" && configurationReady && transition === "none";
      if (runtimeAuthorityEligible) {
        const skillsFinding = runtimeFinding("skills-hooks", skillsStatus);
        const mcpFinding = runtimeFinding("mcp", mcpStatus);
        if (skillsFinding !== undefined) findings.push(finding(skillsFinding, detailId));
        if (mcpFinding !== undefined) findings.push(finding(mcpFinding, detailId));
      }
      const localRuntimeCurrent = runtimeAuthorityEligible && skillsStatus === "matching" && mcpStatus === "matching";
      if (localRuntimeCurrent && runtime?.mcp.status.kind === "ready") {
        for (const server of runtime.mcp.status.status?.servers ?? []) {
          if (server.state === "needs-auth") findings.push(finding("mcpAuthRequired", detailId, server.componentId));
          else if (server.state === "failed") findings.push(finding("mcpRemoteFailed", detailId, server.componentId));
        }
      }
      if (update.state === "automatic-pending") findings.push(finding("updateAutomaticPending", detailId));
      else if (update.state === "configuration-blocked") findings.push(finding("updateConfigurationBlocked", detailId));
      else if (update.state === "capability-blocked") findings.push(finding("updateCapabilityBlocked", detailId));
      else if (update.state === "automatic-retryable") findings.push(finding("updateAvailable", detailId));
      else if (update.state === "approval-required") findings.push(finding("updateApprovalRequired", detailId));
      else if (update.state === "manual-required") findings.push(finding("updateManualRequired", detailId));
      else if (update.state === "recovery-required") findings.push(finding("updateRecoveryRequired", detailId));
      else if (update.state === "failed" || update.stale) findings.push(finding("updateFailed", detailId));
      if (update.schedule?.state === "clock-regressed") findings.push(finding("updateClockRegressed", detailId));

      const diagnostics = compileNativeDiagnostics({ findings }, dependencies.sha256);
      const condition = deriveNativeInspectionCondition(diagnostics);
      const names = parsePluginKey(subject.plugin);
      const displayRevision = authority.revision.evidence.source.declaredVersion ?? authority.revision.evidence.source.sourceRevision ?? subject.selectedRevision;
      const summary = NativeInspectionSummarySchema.parse({
        detailId,
        subject: "installed",
        scope: subject.scope,
        plugin: subject.plugin,
        name: safe(loaded.plugin.identity.manifestName ?? names.plugin),
        marketplace: safe(names.marketplace),
        revision: { installed: safe(displayRevision), immutable: subject.selectedRevision, resolution: "exact" },
        condition,
        freshness: { status: update.stale ? "stale" : "current", basis: update.stale ? "update" : "state" },
        diagnosticCounts: countNativeDiagnostics(diagnostics),
      });
      const compatibility = NativeCompatibilityViewSchema.parse({
        status: report === undefined ? "unavailable" : report.activatable ? "activatable" : "incompatible",
        reportFingerprint: report === undefined ? authority.revision.evidence.compatibility.fingerprint : digestCompatibilityReport(report, dependencies.sha256),
        components: projectSafeComponents({ plugin: loaded.plugin, ...(report === undefined ? {} : { compatibility: report }) }),
        requirements: (report?.requirements ?? []).map((assessment) => ({
          id: assessment.requirement.id,
          capability: safe(assessment.requirement.capability),
          status: assessment.status,
          explanation: safe(assessment.explanation, NativeDisplayLimits.descriptionScalars),
          provenance: projectSafeProvenance(assessment.requirement.provenance),
        })).sort((left, right) => compareUtf8(left.id, right.id)),
      });
      const activationState = transition !== "none" ? (transition === "pending" ? "pending" : "recovery-required")
        : condition === "blocked" ? "blocked"
        : !localRuntimeCurrent ? "unavailable"
        : authority.record.activation === "disabled" ? "inactive"
        : "active";
      const activation = NativeActivationViewSchema.parse({
        intent: authority.record.activation,
        state: activationState,
        selectedRevision: subject.selectedRevision,
        ...(runtime?.projectionDigest === undefined ? {} : { projectionDigest: runtime.projectionDigest }),
        participants: [
          { participant: "skills-hooks", status: skillsStatus, ...(runtime?.skillsHooks.kind === "ready" ? { contributionDigest: runtime.skillsHooks.observation.contributionDigest } : {}) },
          { participant: "mcp", status: mcpStatus, ...(runtime?.mcp.expected.registrationDigest === undefined ? {} : { contributionDigest: runtime.mcp.expected.registrationDigest }) },
        ],
      });
      const observedMcp = runtime?.mcp.status.kind === "ready" ? runtime.mcp.status.status : null;
      const mcpHealth = runtime === undefined || expectedMcp.length === 0 && observedMcp === null && mcpStatus === "matching"
        ? undefined
        : NativeMcpHealthViewSchema.parse({
            localRegistration: mcpStatus === "matching" ? "matching" : mcpStatus === "missing" ? "absent" : mcpStatus,
            servers: observedMcp?.servers.map((server) => {
              const exactExpectation = runtime.mcp.expected.servers.find((candidate) =>
                candidate.componentId === server.componentId && candidate.serverKey === server.key);
              return {
                componentId: server.componentId,
                serverKey: server.key,
                nativeKey: safe(server.nativeKey),
                authority: localRuntimeCurrent ? "current" as const : "stale" as const,
                ...(exactExpectation === undefined ? {} : { transport: exactExpectation.transport }),
                state: server.state,
                ...(server.toolCount === undefined ? {} : { toolCount: server.toolCount }),
                ...(server.errorCode === undefined ? {} : { errorCode: server.errorCode }),
              };
            }) ?? [],
          });
      return NativeInspectionDetailResultSchema.parse({
        kind: "found",
        detail: NativeInspectionDetailSchema.parse({
          snapshotId,
          summary,
          source: projectSafeSource(loaded.plugin.source),
          provenance: [],
          compatibility,
          trust,
          configuration,
          lifecycle: {
            installed: true,
            activationIntent: authority.record.activation,
            transition,
            update: update.state,
            ...(update.policy === undefined ? {} : { policy: update.policy }),
            ...(update.notice === undefined ? {} : { notice: update.notice }),
            ...(update.schedule === undefined ? {} : { schedule: update.schedule }),
            ...(update.updateSubsystem === undefined ? {} : { updateSubsystem: update.updateSubsystem }),
          },
          activation,
          ...(mcpHealth === undefined ? {} : { mcpHealth }),
          diagnostics,
        }),
      });
    },
  });
}
