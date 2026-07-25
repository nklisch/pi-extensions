import { createHash } from "node:crypto";
import {
  TrustedInstallActivationResultSchema,
  TrustedInstallConsentDisclosureSchema,
  TrustedInstallSessionViewSchema,
} from "../../../src/application/trusted-install-contract.js";
import { deriveInspectionDetailId, deriveInspectionSnapshotId } from "../../../src/application/native-inspection-identifiers.js";
import { compileNativeDiagnostics } from "../../../src/application/native-diagnostic-compiler.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const safe = (text: string) => ({ text, escaped: false, truncated: false });
const digest = (value: string) => `sha256:${value.repeat(64)}` as never;
const plugin = "bundle@community" as never;
const scope = { kind: "user" as const };
const revision = digest("1");
const registrationId = `marketplace-registration-v1:sha256:${"2".repeat(64)}` as never;
const candidateId = `marketplace-candidate-v1:sha256:${"3".repeat(64)}` as never;
const catalogSnapshot = `marketplace-snapshot-v1:sha256:${"4".repeat(64)}` as never;
const detailId = deriveInspectionDetailId({ version: 1, subject: "marketplace-candidate", scope, plugin, registrationId, candidateId, catalogSnapshot }, sha256);
const snapshotId = deriveInspectionSnapshotId({ catalogSnapshot, capability: digest("5"), projectEpoch: digest("6") }, sha256);
const inspectionDiagnostics = compileNativeDiagnostics({ findings: [
  { key: "trustRequired", subjectId: detailId },
  { key: "configurationRequired", subjectId: detailId },
] }, sha256);
const componentId = (kind: string, value: string) => `component-v1:${kind}:${value.repeat(64)}`;
const components = {
  counts: { skills: 1, hooks: 1, mcpServers: 1, foreign: 0 },
  skills: [{ kind: "skill", componentId: componentId("skill", "1"), verdict: "supported", requirementIds: [], provenance: [], name: safe("bundle-skill"), root: safe("skills/bundle") }],
  hooks: [{ kind: "hook", componentId: componentId("hook", "2"), verdict: "supported", requirementIds: [], provenance: [], event: safe("SubagentStart"), matcher: safe("Agent"), handler: { kind: "exec", command: safe("bundle-hook"), args: [safe("--check")], timeoutMs: 5000 } }],
  mcpServers: [{ kind: "mcp-server", componentId: componentId("mcp-server", "3"), verdict: "supported", requirementIds: [], provenance: [], nativeKey: safe("bundle"), transport: "stdio", command: safe("bundle-mcp"), args: [safe("--stdio")], environmentNames: [safe("MCP_TOKEN")], headerNames: [], authentication: "none", toolPolicy: { allowed: [safe("read")], denied: [safe("admin")], approval: "required" }, startupTimeoutMs: 5000, toolTimeoutMs: 30000 }],
  foreign: [],
} as const;
const source = { kind: "git" as const, identity: digest("7"), endpoint: { scheme: "https" as const, host: safe("example.invalid"), path: safe("/bundle.git"), queryPresent: true, fragmentPresent: false }, revision: safe("a".repeat(40)) };
const binding = {
  scope, registrationId, candidateId, catalogSnapshot, plugin, sourceIdentity: digest("7"), immutableRevision: revision,
  contentDigest: digest("8"), compatibilityFingerprint: digest("9"), configurationDescriptorDigest: digest("a"), consentDisclosureDigest: digest("f"),
  configurationRef: `plugin-configuration-v1:sha256:${"b".repeat(64)}` as never,
  trustSubject: `trust-subject-v1:sha256:${"c".repeat(64)}` as never,
  executableSurfaceDigest: digest("d"), capabilityDigest: digest("5"),
};
const fields = [
  { key: "NAME", label: safe("Name"), kind: "string", required: true, sensitive: false, defaultPresent: true, default: { kind: "string", value: safe("bundle") }, constraints: { pattern: safe("^[a-z]+$") }, state: "defaulted" },
  { key: "ROOT", label: safe("Root"), kind: "directory", required: true, sensitive: false, defaultPresent: false, constraints: { mustExist: true }, state: "missing" },
  { key: "TOKEN", label: safe("Token"), kind: "string", required: true, sensitive: true, defaultPresent: false, constraints: {}, state: "missing" },
] as const;
const consent = TrustedInstallConsentDisclosureSchema.parse({
  consentId: `trusted-install-consent-v1:sha256:${"e".repeat(64)}`,
  source, immutableRevision: revision, executableSurfaceDigest: binding.executableSurfaceDigest, components,
  requirements: [], persistentData: true,
  configurationEnvironmentNames: [safe("CLAUDE_PLUGIN_OPTION_NAME"), safe("CLAUDE_PLUGIN_OPTION_ROOT"), safe("CLAUDE_PLUGIN_OPTION_TOKEN")],
  subagentInterception: "available", remoteMcpDiscovery: "not-performed",
  statement: safe("Grant trust to this exact revision and executable surface."),
});
const detail = {
  snapshotId,
  summary: { detailId, subject: "marketplace-candidate", scope, plugin, name: safe("bundle"), marketplace: safe("community"), revision: { available: safe("1.0.0"), immutable: revision, resolution: "exact" }, condition: "blocked", freshness: { status: "current", basis: "marketplace" }, diagnosticCounts: { error: 2, warning: 0, info: 0 } },
  source, provenance: [], compatibility: { status: "activatable", reportFingerprint: binding.compatibilityFingerprint, components, requirements: [] },
  trust: "required", configuration: fields.map((field) => ({ key: field.key, label: field.label, valueKind: field.kind, required: field.required, sensitive: field.sensitive, defaultPresent: field.defaultPresent, state: field.state })),
  lifecycle: { installed: false, transition: "none", update: "not-applicable" }, diagnostics: inspectionDiagnostics,
} as const;
const token = `trusted-install-session-v1:2d6737b6-7482-4a50-9310-cd35ce7ddcad.${"f".repeat(64)}` as never;
const candidateProgress = [{ sequence: 0, phase: "candidate-acquisition", state: "completed", plugin, scope, revision }] as const;
const session = TrustedInstallSessionViewSchema.parse({ token, version: 0, state: "awaiting-input", expiresAt: 60_000, binding, candidate: detail, fields, consent, progress: candidateProgress, retained: { configuration: false, trust: false } });
const completedProgress = [
  ...candidateProgress,
  { sequence: 1, phase: "input-validation", state: "completed", plugin, scope, revision },
  { sequence: 2, phase: "configuration-custody", state: "completed", plugin, scope, revision },
  { sequence: 3, phase: "trust-decision", state: "completed", plugin, scope, revision },
  { sequence: 4, phase: "activation-transaction", state: "completed", plugin, scope, revision },
  { sequence: 5, phase: "activation-observation", state: "completed", plugin, scope, revision },
  { sequence: 6, phase: "completed", state: "completed", plugin, scope, revision },
] as const;

export const trustedInstallFlowFixture = Object.freeze({
  chooseInspect: detail,
  configureTrust: Object.freeze({ fields, consent }),
  activationResult: TrustedInstallActivationResultSchema.parse({ kind: "succeeded", plugin, scope, revision, projectionDigest: digest("0"), components: { skills: 1, hooks: 1, mcpServers: 1 }, progress: completedProgress, diagnostics: [], retained: { configuration: true, trust: true } }),
  states: Object.freeze({
    missingInput: TrustedInstallActivationResultSchema.parse({ kind: "needs-input", issues: [{ code: "CONFIG_REQUIRED", key: "ROOT" }, { code: "CONFIG_REQUIRED", key: "TOKEN" }, { code: "CONSENT_REQUIRED" }], session }),
    current: TrustedInstallActivationResultSchema.parse({ kind: "current-state", plugin, scope, revision, activation: "enabled", reason: "already-active", progress: completedProgress, retained: { configuration: true, trust: true } }),
    candidateStale: TrustedInstallActivationResultSchema.parse({ kind: "stale", reason: "candidate", progress: candidateProgress, retained: { configuration: false, trust: false } }),
    projectStale: TrustedInstallActivationResultSchema.parse({ kind: "stale", reason: "project", progress: candidateProgress, retained: { configuration: false, trust: false } }),
    conflict: TrustedInstallActivationResultSchema.parse({ kind: "conflict", reason: "concurrent-mutation", progress: completedProgress, retained: { configuration: true, trust: true } }),
    cancelled: TrustedInstallActivationResultSchema.parse({ kind: "cancelled", phase: "trust-decision", progress: completedProgress.slice(0, 4), retained: { configuration: true, trust: false } }),
    rolledBack: TrustedInstallActivationResultSchema.parse({ kind: "rolled-back", failure: "observation-mismatch", restored: true, progress: completedProgress, retained: { configuration: true, trust: true } }),
    recoveryRequired: TrustedInstallActivationResultSchema.parse({ kind: "recovery-required", transition: `pending-transition-v1:sha256:${"1".repeat(64)}`, committed: 4, action: "run-recovery", progress: completedProgress, retained: { configuration: true, trust: true } }),
    capabilityUnavailable: TrustedInstallActivationResultSchema.parse({ kind: "rejected", code: "INCOMPATIBLE", diagnostics: [], progress: candidateProgress, retained: { configuration: false, trust: false } }),
  }),
});
