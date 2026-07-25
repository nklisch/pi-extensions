import { createHash } from "node:crypto";
import { compileNativeDiagnostics, countNativeDiagnostics, deriveNativeInspectionCondition } from "../../../src/application/native-diagnostic-compiler.js";
import { toSafeDisplayField } from "../../../src/application/native-inspection-display.js";
import { deriveInspectionDetailId, deriveInspectionSnapshotId } from "../../../src/application/native-inspection-identifiers.js";
import { NativeInspectionDetailSchema, NativeInspectionPageSchema, NativeInspectionSummarySchema } from "../../../src/application/native-inspection-contract.js";
import { NativeInspectionLeakageCanaries } from "./hostile-values.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const snapshotId = deriveInspectionSnapshotId({ fixture: "split-inspector-v1" }, sha256);
const projectKey = `project-v1:sha256:${"12".repeat(32)}` as never;
const componentId = `component-v1:mcp-server:${"34".repeat(32)}` as never;
const serverKey = `mcp-server-v1:${"34".repeat(32)}` as never;
const safe = (text: string) => toSafeDisplayField(text, { maxScalars: 256 });
const emptyComponents = { counts: { skills: 0, hooks: 0, mcpServers: 0, foreign: 0 }, skills: [], hooks: [], mcpServers: [], foreign: [] };
const source = { kind: "git" as const, identity: `sha256:${"56".repeat(32)}`, endpoint: { scheme: "https" as const, host: safe("example.invalid"), path: safe("/plugin.git"), queryPresent: false, fragmentPresent: false }, revision: safe("a".repeat(40)) };

const definitions = [
  { key: "active-update", plugin: "active@market", subject: "installed", finding: "updateAvailable", activation: "enabled", update: "available", trust: "authorized" },
  { key: "disabled", plugin: "disabled@market", subject: "installed", activation: "disabled", update: "current", trust: "authorized" },
  { key: "marketplace", plugin: "candidate@market", subject: "marketplace-candidate", update: "not-applicable", trust: "required" },
  { key: "incompatible", plugin: "incompatible@market", subject: "marketplace-candidate", finding: "incompatible", update: "not-applicable", trust: "not-applicable", incompatible: true },
  { key: "recovery-required", plugin: "recovery@market", subject: "installed", finding: "recoveryRequired", activation: "enabled", transition: "recovery-required", update: "recovery-required", trust: "authorized" },
  { key: "project-untrusted", plugin: "project@market", subject: "installed", finding: "projectUntrusted", activation: "enabled", update: "current", trust: "project-untrusted", project: true },
  { key: "mcp-remote-failed", plugin: "remote@market", subject: "installed", finding: "mcpRemoteFailed", activation: "enabled", update: "current", trust: "authorized", mcp: true },
  { key: "stale-offline", plugin: "offline@market", subject: "marketplace-candidate", finding: "catalogStale", update: "not-applicable", trust: "required", stale: true },
  { key: "hostile-display", plugin: "hostile@market", subject: "installed", activation: "enabled", update: "current", trust: "authorized", hostile: true },
] as const;

function revision(index: number) {
  return `sha256:${index.toString(16).padStart(2, "0").repeat(32)}` as never;
}

function subject(definition: typeof definitions[number], index: number) {
  const scope = definition.project ? { kind: "project" as const, projectKey } : { kind: "user" as const };
  return definition.subject === "installed"
    ? { version: 1 as const, subject: "installed" as const, scope, plugin: definition.plugin as never, selectedRevision: revision(index + 1) }
    : {
        version: 1 as const,
        subject: "marketplace-candidate" as const,
        scope,
        plugin: definition.plugin as never,
        registrationId: `marketplace-registration-v1:sha256:${(index + 20).toString(16).padStart(2, "0").repeat(32)}` as never,
        candidateId: `marketplace-candidate-v1:sha256:${(index + 40).toString(16).padStart(2, "0").repeat(32)}` as never,
        catalogSnapshot: `marketplace-snapshot-v1:sha256:${(index + 60).toString(16).padStart(2, "0").repeat(32)}` as never,
      };
}

export const SplitInspectorFixture = Object.freeze(definitions.map((definition, index) => {
  const identity = subject(definition, index);
  const detailId = deriveInspectionDetailId(identity, sha256);
  const diagnostics = definition.finding === undefined ? [] : compileNativeDiagnostics({ findings: [{ key: definition.finding, subjectId: detailId, ...(definition.mcp ? { componentId } : {}) }] }, sha256);
  const condition = deriveNativeInspectionCondition(diagnostics);
  const names = definition.plugin.split("@");
  const summary = NativeInspectionSummarySchema.parse({
    detailId,
    subject: definition.subject,
    scope: identity.scope,
    plugin: definition.plugin,
    name: definition.hostile ? safe(NativeInspectionLeakageCanaries.control) : safe(names[0]!),
    marketplace: safe(names[1]!),
    revision: definition.subject === "installed"
      ? { installed: safe(index === 0 ? "1.0.0" : String(index + 1)), immutable: revision(index + 1), resolution: "exact" }
      : { available: safe(index === 2 ? "2.0.0" : String(index + 1)), resolution: "exact" },
    condition,
    freshness: { status: definition.stale ? "stale" : "current", basis: definition.subject === "installed" ? "state" : "marketplace" },
    diagnosticCounts: countNativeDiagnostics(diagnostics),
  });
  const compatibility = {
    status: definition.incompatible ? "incompatible" as const : "activatable" as const,
    reportFingerprint: revision(index + 10),
    components: emptyComponents,
    requirements: [],
  };
  const installed = definition.subject === "installed";
  const activation = !installed ? undefined : {
    intent: definition.activation!,
    state: definition.transition === "recovery-required" ? "recovery-required" as const : definition.activation === "disabled" ? "inactive" as const : definition.finding === "projectUntrusted" ? "blocked" as const : "active" as const,
    selectedRevision: revision(index + 1),
    projectionDigest: revision(index + 70),
    participants: [{ participant: "skills-hooks" as const, status: "matching" as const, contributionDigest: revision(index + 80) }, { participant: "mcp" as const, status: "matching" as const, contributionDigest: revision(index + 90) }],
  };
  const mcpHealth = definition.mcp || definition.hostile ? {
    localRegistration: "matching" as const,
    servers: [{
      componentId,
      serverKey,
      nativeKey: safe(definition.hostile ? NativeInspectionLeakageCanaries.control : "remote"),
      authority: "current" as const,
      transport: "stdio" as const,
      state: definition.mcp ? "failed" as const : "connected" as const,
      ...(definition.mcp ? { errorCode: "ADAPTER_FAILED" as const } : { toolCount: 3 }),
    }],
  } : undefined;
  const detail = NativeInspectionDetailSchema.parse({
    snapshotId,
    summary,
    source,
    provenance: [],
    compatibility,
    trust: definition.trust,
    configuration: [],
    lifecycle: { installed, ...(installed ? { activationIntent: definition.activation } : {}), transition: definition.transition ?? "none", update: definition.update },
    ...(activation === undefined ? {} : { activation }),
    ...(mcpHealth === undefined ? {} : { mcpHealth }),
    diagnostics,
  });
  return Object.freeze({ key: definition.key, summary, detail });
}));

export const SplitInspectorPageFixture = NativeInspectionPageSchema.parse({
  snapshotId,
  condition: "blocked",
  items: SplitInspectorFixture.map((entry) => entry.summary),
  observations: [
    { scope: { kind: "user" }, status: "ready", generation: 0, corruptionCodes: [] },
    { scope: { kind: "project", projectKey }, status: "ready", generation: 0, corruptionCodes: [] },
  ],
});

export const SplitInspectorDetailFixtures = Object.freeze(Object.fromEntries(SplitInspectorFixture.map((entry) => [entry.key, entry.detail])));
