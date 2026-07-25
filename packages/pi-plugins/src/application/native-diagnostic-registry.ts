import { z } from "zod";

/**
 * One registry owns every public diagnostic variant and its behavior. Upstream
 * messages are intentionally absent: callers select a key and supply only
 * schema-whitelisted facts.
 */
export const NativeDiagnosticRegistry = Object.freeze({
  stateCorrupt: { code: "STATE_CORRUPT", category: "integrity", severity: "error", rank: 100, blocks: true, unavailable: false, action: "run-recovery", summary: "Authoritative plugin state is corrupt." },
  recordCorrupt: { code: "RECORD_CORRUPT", category: "integrity", severity: "error", rank: 110, blocks: true, unavailable: false, action: "run-recovery", summary: "An authoritative plugin record is corrupt." },
  recoveryRequired: { code: "RECOVERY_REQUIRED", category: "recovery", severity: "error", rank: 200, blocks: true, unavailable: false, action: "run-recovery", summary: "A lifecycle operation requires recovery." },
  transitionPending: { code: "TRANSITION_PENDING", category: "recovery", severity: "error", rank: 210, blocks: true, unavailable: false, action: "run-recovery", summary: "A lifecycle transition is still pending." },
  recoveryDeferred: { code: "RECOVERY_DEFERRED", category: "recovery", severity: "warning", rank: 220, blocks: true, unavailable: false, action: "run-recovery", summary: "Recovery was deferred." },
  recoveryBlocked: { code: "RECOVERY_BLOCKED", category: "recovery", severity: "error", rank: 230, blocks: true, unavailable: false, action: "run-recovery", summary: "Recovery cannot currently complete." },
  startupBlocked: { code: "HOST_STARTUP_BLOCKED", category: "recovery", severity: "error", rank: 240, blocks: true, unavailable: false, action: "reload-runtime", summary: "Packaged host startup did not establish a usable runtime." },
  projectUntrusted: { code: "PROJECT_UNTRUSTED", category: "trust", severity: "error", rank: 300, blocks: true, unavailable: false, action: "trust-project", summary: "The current project is not trusted." },
  incompatible: { code: "COMPATIBILITY_INCOMPATIBLE", category: "compatibility", severity: "error", rank: 400, blocks: true, unavailable: false, action: "inspect-source", summary: "The plugin is incompatible with this host." },
  requirementUnavailable: { code: "RUNTIME_REQUIREMENT_UNAVAILABLE", category: "capability", severity: "error", rank: 410, blocks: true, unavailable: false, action: "reload-runtime", summary: "A required runtime capability is unavailable." },
  capabilityUnavailable: { code: "CAPABILITY_EVIDENCE_UNAVAILABLE", category: "capability", severity: "warning", rank: 420, blocks: false, unavailable: true, action: "retry-read", summary: "Runtime capability evidence is unavailable." },
  trustRequired: { code: "TRUST_REQUIRED", category: "trust", severity: "error", rank: 500, blocks: true, unavailable: false, action: "review-trust", summary: "This exact plugin revision requires trust approval." },
  trustRevoked: { code: "TRUST_REVOKED", category: "trust", severity: "error", rank: 501, blocks: true, unavailable: false, action: "review-trust", summary: "Trust for this exact plugin revision was revoked." },
  trustInvalid: { code: "TRUST_EVIDENCE_INVALID", category: "trust", severity: "error", rank: 502, blocks: true, unavailable: false, action: "review-trust", summary: "Plugin trust evidence is invalid." },
  configurationRequired: { code: "CONFIGURATION_REQUIRED", category: "configuration", severity: "error", rank: 510, blocks: true, unavailable: false, action: "provide-configuration", summary: "Required plugin configuration is missing." },
  configurationInvalid: { code: "CONFIGURATION_INVALID", category: "configuration", severity: "error", rank: 511, blocks: true, unavailable: false, action: "provide-configuration", summary: "Plugin configuration evidence is invalid." },
  secretCustodyUnavailable: { code: "SECRET_CUSTODY_UNAVAILABLE", category: "configuration", severity: "error", rank: 512, blocks: true, unavailable: false, action: "provide-configuration", summary: "Secure custody for required sensitive configuration is unavailable." },
  revisionUnavailable: { code: "REVISION_UNAVAILABLE", category: "activation", severity: "error", rank: 590, blocks: true, unavailable: false, action: "run-recovery", summary: "The selected immutable revision is unavailable." },
  projectionUnavailable: { code: "PROJECTION_UNAVAILABLE", category: "activation", severity: "warning", rank: 595, blocks: false, unavailable: true, action: "reload-runtime", summary: "Runtime projection evidence is unavailable." },
  activationMismatch: { code: "ACTIVATION_EVIDENCE_MISMATCH", category: "activation", severity: "error", rank: 600, blocks: true, unavailable: false, action: "reload-runtime", summary: "Local runtime activation evidence does not match authority." },
  runtimeMissing: { code: "RUNTIME_EVIDENCE_MISSING", category: "activation", severity: "warning", rank: 605, blocks: false, unavailable: true, action: "reload-runtime", summary: "Expected local runtime evidence is missing." },
  mcpRegistrationMismatch: { code: "MCP_REGISTRATION_MISMATCH", category: "activation", severity: "error", rank: 610, blocks: true, unavailable: false, action: "reload-runtime", summary: "Local MCP registration does not match the selected plugin revision." },
  mcpRegistrationMissing: { code: "MCP_REGISTRATION_MISSING", category: "activation", severity: "warning", rank: 615, blocks: false, unavailable: true, action: "reload-runtime", summary: "Expected local MCP registration evidence is missing." },
  runtimeUnavailable: { code: "RUNTIME_EVIDENCE_UNAVAILABLE", category: "activation", severity: "warning", rank: 620, blocks: false, unavailable: true, action: "reload-runtime", summary: "Local runtime evidence is unavailable." },
  mcpAuthRequired: { code: "MCP_REMOTE_AUTH_REQUIRED", category: "live-health", severity: "warning", rank: 690, blocks: false, unavailable: false, action: "retry-read", summary: "An MCP server requires remote authentication." },
  mcpRemoteFailed: { code: "MCP_REMOTE_HEALTH_FAILED", category: "live-health", severity: "warning", rank: 700, blocks: false, unavailable: false, action: "retry-read", summary: "An MCP server reports failed live health." },
  updateAvailable: { code: "UPDATE_AVAILABLE", category: "update", severity: "info", rank: 800, blocks: false, unavailable: false, action: "review-update", summary: "An update is available." },
  updateApprovalRequired: { code: "UPDATE_APPROVAL_REQUIRED", category: "update", severity: "info", rank: 810, blocks: false, unavailable: false, action: "review-update", summary: "An update requires approval." },
  updateManualRequired: { code: "UPDATE_MANUAL_REQUIRED", category: "update", severity: "info", rank: 820, blocks: false, unavailable: false, action: "review-update", summary: "An update requires a manual decision." },
  updateAutomaticPending: { code: "UPDATE_AUTOMATIC_PENDING", category: "update", severity: "info", rank: 821, blocks: false, unavailable: false, action: "review-update", summary: "An automatic update is waiting for a safe host operation context." },
  updateConfigurationBlocked: { code: "UPDATE_CONFIGURATION_BLOCKED", category: "update", severity: "warning", rank: 822, blocks: false, unavailable: false, action: "provide-configuration", summary: "An automatic update is blocked by required configuration." },
  updateCapabilityBlocked: { code: "UPDATE_CAPABILITY_BLOCKED", category: "update", severity: "warning", rank: 823, blocks: false, unavailable: false, action: "reload-runtime", summary: "An automatic update is blocked by an unavailable runtime capability." },
  updateClockRegressed: { code: "UPDATE_CLOCK_REGRESSED", category: "update", severity: "warning", rank: 824, blocks: false, unavailable: false, action: "retry-read", summary: "Scheduled updates are paused because the wall clock moved backward." },
  updateRecoveryRequired: { code: "UPDATE_RECOVERY_REQUIRED", category: "update", severity: "error", rank: 830, blocks: true, unavailable: false, action: "run-recovery", summary: "An update requires recovery." },
  updateFailed: { code: "UPDATE_FAILED", category: "update", severity: "warning", rank: 840, blocks: false, unavailable: false, action: "refresh-marketplace", summary: "The latest update check failed." },
  catalogCorrupt: { code: "CATALOG_CORRUPT", category: "integrity", severity: "error", rank: 895, blocks: true, unavailable: false, action: "refresh-marketplace", summary: "Published marketplace catalog content is corrupt." },
  catalogStale: { code: "CATALOG_STALE", category: "freshness", severity: "warning", rank: 900, blocks: false, unavailable: false, action: "refresh-marketplace", summary: "Marketplace catalog evidence is stale." },
  catalogUnavailable: { code: "CATALOG_UNAVAILABLE", category: "freshness", severity: "warning", rank: 910, blocks: false, unavailable: true, action: "refresh-marketplace", summary: "Marketplace catalog evidence is unavailable." },
  candidateMissing: { code: "CANDIDATE_MISSING", category: "freshness", severity: "warning", rank: 920, blocks: false, unavailable: true, action: "refresh-marketplace", summary: "The exact marketplace candidate is unavailable." },
  sourceUnavailable: { code: "SOURCE_UNAVAILABLE", category: "evidence", severity: "warning", rank: 930, blocks: false, unavailable: true, action: "retry-read", summary: "Plugin source content is unavailable." },
  sourceInvalid: { code: "SOURCE_INVALID", category: "integrity", severity: "error", rank: 940, blocks: true, unavailable: false, action: "inspect-source", summary: "Plugin source content is invalid." },
  // Specific, user-presentable source failures. Provenance carries the host
  // document (.claude-plugin/... vs .codex-plugin/...) and pointer; the
  // `reason` fact is a fixed vocabulary the presenter maps to plain language.
  sourceDocumentInvalid: { code: "SOURCE_DOCUMENT_INVALID", category: "integrity", severity: "error", rank: 941, blocks: true, unavailable: false, action: "inspect-source", summary: "A plugin document is invalid." },
  sourceDeclarationConflict: { code: "SOURCE_DECLARATION_CONFLICT", category: "integrity", severity: "error", rank: 942, blocks: true, unavailable: false, action: "inspect-source", summary: "Two plugin declarations disagree." },
  sourceContentUnsafe: { code: "SOURCE_CONTENT_UNSAFE", category: "integrity", severity: "error", rank: 943, blocks: true, unavailable: false, action: "inspect-source", summary: "The plugin source is not safe to install." },
  adoptionUnreadable: { code: "ADOPTION_DOCUMENT_UNREADABLE", category: "adoption", severity: "warning", rank: 950, blocks: false, unavailable: false, action: "retry-read", summary: "A foreign adoption document is unreadable." },
  adoptionChanged: { code: "ADOPTION_DOCUMENT_CHANGED", category: "adoption", severity: "warning", rank: 951, blocks: false, unavailable: false, action: "retry-read", summary: "A foreign adoption document changed during inspection." },
  evidenceUnavailable: { code: "EVIDENCE_UNAVAILABLE", category: "evidence", severity: "warning", rank: 1000, blocks: false, unavailable: true, action: "retry-read", summary: "Required inspection evidence is unavailable." },
} as const);

type RegistryEntry = (typeof NativeDiagnosticRegistry)[keyof typeof NativeDiagnosticRegistry];
const values = Object.values(NativeDiagnosticRegistry);

export const NativeDiagnosticCodeSchema = z.enum(values.map((entry) => entry.code) as [RegistryEntry["code"], ...RegistryEntry["code"][]]);
export const NativeDiagnosticCategorySchema = z.enum([...new Set(values.map((entry) => entry.category))] as [RegistryEntry["category"], ...RegistryEntry["category"][]]);
export const NativeDiagnosticActionSchema = z.enum([...new Set(values.map((entry) => entry.action))] as [RegistryEntry["action"], ...RegistryEntry["action"][]]);

export type NativeDiagnosticCode = z.infer<typeof NativeDiagnosticCodeSchema>;
export type NativeDiagnosticCategory = z.infer<typeof NativeDiagnosticCategorySchema>;
export type NativeDiagnosticAction = z.infer<typeof NativeDiagnosticActionSchema>;
export type NativeDiagnosticRegistryKey = keyof typeof NativeDiagnosticRegistry;
