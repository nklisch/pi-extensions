// The package barrel is deliberately explicit. Domain modules can grow
// internal helpers without silently expanding the supported package API.
export {
  JsonValueSchema,
  nonEmptyReadonly,
  schemaValues,
} from "./domain/schema.js";
export type { JsonValue } from "./domain/schema.js";

export {
  MarketplaceNameSchema,
  PluginNameSchema,
  PluginKeySchema,
  PluginIdentitySchema,
  formatPluginKey,
  parsePluginKey,
  createPluginIdentity,
} from "./domain/identity.js";
export type {
  MarketplaceName,
  PluginName,
  PluginKey,
  PluginIdentity,
} from "./domain/identity.js";

export {
  MarketplaceSourceVariantRegistry,
  MarketplaceSourceSchema,
  PluginSourceVariantRegistry,
  PluginSourceSchema,
  GitRevisionSchema,
  NpmIntegritySchema,
  CanonicalSourceSchema,
  SourceHashSchema,
  ResolvedMarketplaceSourceSchema,
  ResolvedPluginSourceVariantRegistry,
  ResolvedPluginSourceSchema,
  serializeMarketplaceSource,
  serializePluginSource,
  hashCanonicalSource,
  createResolvedMarketplaceSource,
  verifyResolvedMarketplaceSource,
  createResolvedPluginSource,
  verifyResolvedPluginSource,
} from "./domain/source.js";
export type {
  MarketplaceSource,
  PluginSource,
  GitRevision,
  NpmIntegrity,
  CanonicalSource,
  SourceHash,
  ResolvedMarketplaceSource,
  ResolvedPluginSource,
  Sha256,
} from "./domain/source.js";

export {
  NativeHostSchema,
  SourceDocumentKindSchema,
  SourceLocationSchema,
  ProvenanceSchema,
  ClaimedSchema,
  claim,
  mergeEquivalentClaims,
} from "./domain/provenance.js";
export type {
  NativeHost,
  SourceDocumentKind,
  SourceLocation,
  Provenance,
  Claimed,
} from "./domain/provenance.js";

export {
  AdoptionDocumentKindRegistry,
  AdoptionDocumentKindSchema,
  AdoptionCandidateIdSchema,
  AdoptionDeclarationSchema,
  AdoptionCandidateSchema,
  deriveAdoptionCandidateId,
  reconcileAdoptionDeclarations,
} from "./domain/adoption.js";
export type {
  AdoptionDocumentKind,
  AdoptionCandidateId,
  AdoptionDeclaration,
  AdoptionCandidate,
} from "./domain/adoption.js";

export {
  ConfigurationValueKindRegistry,
  ConfigurationValueSchema,
  ConfigurationOptionSchema,
  ConfigurationKeySchema,
  PluginConfigurationSchema,
} from "./domain/configuration.js";
export type {
  ConfigurationValue,
  ConfigurationValueKind,
  ConfigurationOption,
  PluginConfiguration,
} from "./domain/configuration.js";

export {
  CanonicalConfigurationPathSchema,
  ConfiguredValueSchemaRegistry,
  ConfiguredValueSchema,
  SecretLocatorSchema,
  ConfigurationWriteIdSchema,
  PluginConfigurationDocumentSchemaV1,
  digestConfigurationDescriptors,
  deriveSecretLocator,
  createPluginConfigurationDocument,
  verifyPluginConfigurationDocument,
} from "./domain/configured-values.js";
export type {
  CanonicalConfigurationPath,
  ConfiguredValue,
  ConfiguredValueKind,
  SecretLocator,
  ConfigurationWriteId,
  PluginConfigurationDocument,
} from "./domain/configured-values.js";

export {
  ComponentKindRegistry,
  ComponentIdSchema,
  RetainedMetadataSchema,
  HookHandlerVariantRegistry,
  HookHandlerSchema,
  SkillComponentSchema,
  HookComponentSchema,
  McpServerComponentSchema,
  ForeignComponentSchema,
  ComponentSchema,
  PluginComponentsSchema,
  flattenComponents,
} from "./domain/components.js";
export type {
  ComponentId,
  RetainedMetadata,
  HookHandler,
  SkillComponent,
  HookComponent,
  McpServerComponent,
  ForeignComponent,
  Component,
  PluginComponents,
} from "./domain/components.js";

export {
  ExecutableSurfaceKindRegistry,
  ExecutableSurfaceEntrySchema,
  ExecutableSurfaceSchema,
  SkillTrustEntrySchema,
  HookTrustEntrySchema,
  McpTrustEntrySchema,
  ConfigurationTrustEntrySchema,
  createExecutableSurface,
  digestExecutableSurface,
  verifyExecutableSurface,
} from "./domain/executable-surface.js";
export type {
  ExecutableSurfaceEntry,
  ExecutableSurface,
} from "./domain/executable-surface.js";

export {
  TrustCandidateSchema,
  TrustDecisionSchema,
  TrustChangeDescriptionSchema,
  createTrustCandidate,
  verifyTrustCandidate,
  evaluateTrust,
  grantTrust,
  revokeTrust,
  describeTrustChange,
} from "./domain/trust-policy.js";
export type {
  TrustCandidate,
  TrustDecision,
  TrustChangeDescription,
  TrustSurfaceSummary,
  TrustSurfaceChange,
} from "./domain/trust-policy.js";

export {
  ComponentIdVersionRegistry,
  ComponentLogicalIdentitySchema,
  deriveComponentId,
  verifyComponentId,
} from "./domain/component-identity.js";
export type { ComponentLogicalIdentity } from "./domain/component-identity.js";

export {
  ComponentLocatorAuthorityRegistry,
  ComponentLocatorAuthoritySchema,
  ComponentLocatorSourceRegistry,
  ComponentLocatorSourceSchema,
  ComponentLocatorTargetSchema,
  ComponentLocatorClaimSchema,
  ForeignComponentDeclarationSchema,
  PluginManifestClaimsSchema,
} from "./domain/bundle-ingestion.js";
export type {
  ComponentLocatorAuthority,
  ComponentLocatorSource,
  ComponentLocatorTarget,
  ComponentLocatorClaim,
  ForeignComponentDeclaration,
  PluginManifestClaims,
} from "./domain/bundle-ingestion.js";

export { NormalizedPluginSchema } from "./domain/plugin.js";
export type { NormalizedPlugin } from "./domain/plugin.js";

export {
  MarketplaceAvailabilityRegistry,
  MarketplaceAvailabilitySchema,
  MarketplaceInstallationPolicySchema,
  MarketplaceAuthoritySchema,
  MarketplaceDeclarationCategoryRegistry,
  MarketplaceEntryDeclarationSchema,
  NormalizedMarketplaceEntrySchema,
  NormalizedMarketplaceSchema,
  MarketplaceReadResultSchema,
} from "./domain/marketplace.js";
export type {
  MarketplaceAvailability,
  MarketplaceInstallationPolicy,
  MarketplaceAuthority,
  MarketplaceEntryDeclaration,
  NormalizedMarketplaceEntry,
  NormalizedMarketplace,
  MarketplaceReadResult,
} from "./domain/marketplace.js";

export {
  MarketplaceRegistrationIdSchema,
  MarketplaceCandidateIdSchema,
  MarketplaceSnapshotTokenSchema,
  MarketplaceCursorSchema,
  MarketplaceScopeSelectionSchema,
  deriveMarketplaceRegistrationId,
  deriveMarketplaceSnapshotToken,
  deriveMarketplaceCandidateId,
} from "./domain/marketplace-registration.js";
export type {
  MarketplaceRegistrationId,
  MarketplaceCandidateId,
  MarketplaceSnapshotToken,
  MarketplaceCursor,
  MarketplaceScopeSelection,
} from "./domain/marketplace-registration.js";

export {
  UpdateCandidateKeySchema,
  RefreshClaimIdSchema,
  UpdateSchedulerLeaseIdSchema,
  UpdateNoticeIdSchema,
  UpdatePolicyPreviewIdSchema,
  UpdatePolicyConsentIdSchema,
  StableSourceIdentitySchema,
  UpdateApplicationModeSchema,
  UpdateApplicationOverrideSchema,
  UpdateCadenceRegistry,
  UpdateCadenceSchema,
  UpdatePolicyTargetSchema,
  UpdatePolicyChangeSchema,
  UpdateScheduleMemorySchema,
  UpdateSchedulerLeaseSchema,
  AutomaticUpdateReasonSchema,
  AutomaticUpdateAttemptMemorySchema,
  UpdateNoticeDispositionSchema,
  UpdateNoticeResolutionKindSchema,
  UpdateNoticeSchema,
  PluginUpdatePolicyOverrideSchema,
  AvailableRevisionSchema,
  MarketplaceRegistrationOriginSchema,
  MarketplaceRefreshAttemptSchema,
  MarketplaceRefreshMemorySchema,
  MarketplaceRegistrationRecordSchema,
  MarketplaceUpdateRecordSchema,
  refreshDueAt,
  deriveMarketplaceSourceIdentity,
  derivePluginSourceIdentity,
  deriveUpdateCandidateKey,
  compareInstalledRevision,
  backoffDelayMs,
  createMarketplaceConfigurationRecord,
  replaceMarketplaceConfigurationSource,
  displayVersion,
  selectDeclaredVersion,
} from "./domain/update-policy.js";
export type {
  UpdateCandidateKey,
  RefreshClaimId,
  UpdateSchedulerLeaseId,
  UpdateNoticeId,
  UpdatePolicyPreviewId,
  UpdatePolicyConsentId,
  StableSourceIdentity,
  UpdateApplicationMode,
  UpdateApplicationOverride,
  UpdateCadence,
  UpdatePolicyTarget,
  UpdatePolicyChange,
  UpdateScheduleMemory,
  UpdateSchedulerLease,
  AutomaticUpdateReason,
  AutomaticUpdateAttemptMemory,
  UpdateNoticeDisposition,
  UpdateNoticeResolutionKind,
  UpdateNotice,
  PluginUpdatePolicyOverride,
  AvailableRevision,
  MarketplaceRegistrationOrigin,
  MarketplaceRefreshAttempt,
  MarketplaceRefreshMemory,
  MarketplaceRegistrationRecord,
  MarketplaceUpdateRecord,
  RevisionComparison,
  InstalledRevisionDescriptor,
} from "./domain/update-policy.js";

export {
  HostPrecedenceSchema,
  DEFAULT_HOST_PRECEDENCE,
  hostRank,
} from "./domain/host-precedence.js";
export type { HostPrecedence } from "./domain/host-precedence.js";

export {
  ComponentVerdictRegistry,
  RuntimeRequirementStatusRegistry,
  RuntimeRequirementIdSchema,
  RuntimeRequirementSchema,
  RuntimeRequirementStatusSchema,
  RuntimeRequirementAssessmentSchema,
  ComponentVerdictSchema,
  ComponentAssessmentSchema,
  CompatibilityReportSchema,
  deriveActivatable,
  createCompatibilityReport,
} from "./domain/compatibility.js";
export type {
  RuntimeRequirementId,
  RuntimeRequirement,
  RuntimeRequirementStatus,
  RuntimeRequirementAssessment,
  ComponentVerdict,
  ComponentAssessment,
  CompatibilityReport,
} from "./domain/compatibility.js";

export {
  RuntimeCapabilityRegistry,
  RuntimeCapabilityIdSchema,
  RuntimeCapabilityAvailabilitySchema,
  RuntimeCapabilitySnapshotSchema,
  RuntimeCapabilityStatusRegistry,
  RuntimeCapabilityStatusSchema,
  CompatibilityPolicyRegistry,
  CompatibilityPolicyRuleRegistry,
  CompatibilityPolicyRuleSchema,
  CompatibilityPolicyRulesSchema,
  RuntimeCapabilityRegistrySchema,
  HookEventSchema,
  MCPTransportSchema,
  MCPFeatureSchema,
} from "./domain/compatibility-policy.js";
export type {
  RuntimeCapabilityId,
  RuntimeCapabilityAvailability,
  RuntimeCapabilitySnapshot,
  CompatibilityPolicySurface,
  CompatibilityPolicyDisposition,
  CompatibilityPolicyRule,
  CompatibilityPolicyRegistryType,
  HookEvent,
  MCPTransport,
  MCPFeature,
} from "./domain/compatibility-policy.js";

export {
  McpCanonicalTransportSchema,
  McpCanonicalAuthSchema,
  McpCanonicalOptionsSchemaV1,
  McpCompatibilityPlanSchemaV1,
  analyzeMcpCompatibility,
} from "./domain/mcp-compatibility-plan.js";
export type {
  McpCanonicalTransport,
  McpCanonicalAuth,
  McpCanonicalOptions,
  McpCompatibilityPlan,
  McpCompatibilityRequirementUse,
  McpCompatibilityAnalysis,
} from "./domain/mcp-compatibility-plan.js";

export {
  CompatibilityEvaluationInputSchema,
  evaluateCompatibility,
} from "./domain/compatibility-evaluator.js";
export type { CompatibilityEvaluationInput } from "./domain/compatibility-evaluator.js";

export { createCompatibilityService } from "./application/compatibility-service.js";
export { McpEndpointSecuritySchema, analyzeMcpEndpoint } from "./domain/mcp-endpoint-security.js";
export type { McpEndpointSecurity, McpEndpointAnalysis } from "./domain/mcp-endpoint-security.js";
export { createMcpRuntimeCapabilityProbe } from "./application/mcp-runtime-capability-probe.js";
export { createSubagentLifecycleCapabilityProbe } from "./application/subagent-lifecycle-capability-probe.js";
export { registerSubagentHookRuntime } from "./application/subagent-hook-runtime.js";
export type { RegisteredSubagentHookRuntime } from "./application/subagent-hook-runtime.js";
export {
  McpEnvironmentNameSchema,
  McpHeaderNameSchema,
  McpLaunchTemplateSchemaV1,
  McpLaunchTemplateError,
  createMcpLaunchTemplate,
} from "./domain/mcp-launch-template.js";
export type {
  McpLateValue,
  McpLaunchTemplate,
} from "./domain/mcp-launch-template.js";
export type {
  CompatibilityAssessmentRequest,
  CompatibilityService,
} from "./application/compatibility-service.js";
export type { RuntimeCapabilityProbe } from "./application/ports/runtime-capability-probe.js";

export {
  SUBAGENT_LIFECYCLE_CAPABILITY_ID,
  SUBAGENT_LIFECYCLE_CONTRACT_VERSION,
  SUBAGENT_LIFECYCLE_CONFORMANCE_SUITE_VERSION,
  SubagentExecutionIdentitySchemaV1,
  SubagentExecutionPathSchemaV1,
  SubagentStartDecisionSchemaV1,
  SubagentCompletionDecisionSchemaV1,
  SubagentLifecycleSemanticsSchemaV1,
  SubagentLifecycleCoverageSchemaV1,
  SubagentLifecycleConformanceReceiptSchemaV1,
  SubagentLifecycleProviderSchemaV1,
  SubagentLifecycleCapabilitiesSchemaV1,
  SubagentLifecycleRegistrationEvidenceSchemaV1,
} from "./application/ports/subagent-lifecycle.js";
export type {
  SubagentExecutionIdentity,
  SubagentExecutionPath,
  SubagentStartRequest,
  SubagentStartDecision,
  SubagentCompletionOutcome,
  SubagentCompletionRequest,
  SubagentCompletionDecision,
  SubagentLifecycleSemantics,
  SubagentLifecycleCoverage,
  SubagentLifecycleConformanceReceipt,
  SubagentLifecycleProvider,
  SubagentLifecycleCapabilities,
  SubagentLifecycleRegistrationEvidence,
  SubagentLifecycleInterceptor,
  SubagentLifecycleRegistrationRequest,
  SubagentLifecyclePort,
} from "./application/ports/subagent-lifecycle.js";
export { HOOK_SUBAGENT_CONTINUATION_BUDGET } from "./domain/hook-runtime-limits.js";

export {
  McpBridgeTransportSchema,
  McpSourceIdentitySchemaV1,
  McpRuntimeServerKeySchemaV1,
  deriveMcpRuntimeServerKey,
  McpToolAliasSegmentSchema,
  McpToolAliasTemplateSchemaV1,
  McpSourceProjectionBindingSchemaV1,
  McpSourceServerSchemaV1,
  McpConfigSourceSchemaV1,
  McpSourceRegistrationSchemaV1,
  McpSourcePreconditionSchemaV1,
  McpRuntimeServerBindingSchemaV1,
  McpLaunchValueRequestSchema,
  McpSourceServerStatusSchema,
  McpSourceStatusSchema,
  McpRuntimeCapabilitiesSchemaV1,
  McpSourceValidationResultSchema,
  McpSourceReplaceResultSchema,
  McpSourceRemoveResultSchema,
} from "./application/ports/mcp-runtime.js";
export type {
  McpBridgeTransport,
  McpSourceIdentity,
  McpRuntimeServerKey,
  McpToolAliasSegment,
  McpToolAliasTemplate,
  McpSourceProjectionBinding,
  McpSourceServer,
  McpConfigSource,
  McpSourceRegistration,
  McpSourcePrecondition,
  McpRuntimeServerBinding,
  McpLaunchValueRequest,
  McpLaunchValues,
  McpLaunchValueProvider,
  McpRuntimeLease,
  McpRuntimeLeaseProvider,
  McpSourceServerStatus,
  McpSourceStatus,
  McpRuntimeCapabilities,
  McpSourceValidationResult,
  McpSourceReplaceResult,
  McpSourceRemoveResult,
  McpSourceReplaceRequest,
  McpRuntimePort,
} from "./application/ports/mcp-runtime.js";
export {
  createMcpSourceRegistration,
  verifyMcpSourceRegistration,
} from "./application/mcp-source-registration.js";

export {
  PluginMcpLaunchTemplateSchemaV1,
  PluginMcpAliasOmissionCodeSchema,
  PluginMcpAliasOmissionSchema,
  PluginMcpProjectionSchemaV1,
  createPluginMcpProjection,
  verifyPluginMcpProjection,
} from "./application/mcp-plugin-projection.js";
export type {
  PluginMcpLaunchTemplate,
  PluginMcpAliasOmissionCode,
  PluginMcpAliasOmission,
  PluginMcpProjection,
} from "./application/mcp-plugin-projection.js";
export {
  McpLaunchBindingSchemaV1,
  McpLaunchErrorCodes,
  McpLaunchContextError,
} from "./application/ports/mcp-launch-context.js";
export type {
  McpLaunchBinding,
  McpLaunchActiveSelection,
  McpLaunchActiveSelectionPort,
  ResolvedMcpLaunchContext,
  McpLaunchContextPort,
  McpLaunchConfigurationDependencies,
  McpLaunchContextPortDependencies,
} from "./application/ports/mcp-launch-context.js";
export type {
  ResolvedMcpLaunchEnvironment,
  McpLaunchEnvironmentPort,
} from "./application/ports/mcp-launch-environment.js";
export { createMcpLaunchContextPort } from "./application/mcp-launch-context.js";
export {
  McpProcessEnvironmentPlatformSchema,
  createTrustedMcpLaunchValueProvider,
} from "./runtime/mcp/launch-value-provider.js";
export type { McpProcessEnvironmentPlatform } from "./runtime/mcp/launch-value-provider.js";
export { classifyMcpLaunchFailure } from "./runtime/mcp/launch-error.js";
export { PluginLaunchRootRegistry } from "./runtime/plugin-launch-roots.js";
export type { PluginLaunchRootName, PluginLaunchRootValues } from "./runtime/plugin-launch-roots.js";

export {
  AutomaticUpdateEligibilityReasonRegistry,
  AutomaticUpdateEligibilityReasonSchema,
  AutomaticUpdateEligibilitySchema,
} from "./application/automatic-update-eligibility.js";
export type {
  AutomaticUpdateEligibilityReason,
  AutomaticUpdateEligibility,
} from "./application/automatic-update-eligibility.js";
export { createAutomaticUpdateCoordinator } from "./application/automatic-update-coordinator.js";
export type {
  AutomaticUpdateCoordinator,
  AutomaticUpdateCoordinatorDependencies,
} from "./application/automatic-update-coordinator.js";
export type {
  AutomaticUpdateAuthoritySnapshot,
  AutomaticUpdateLifecycleResult,
  AutomaticUpdateLifecyclePort,
} from "./application/ports/automatic-update-lifecycle.js";
export type { UpdateActivationContextPort } from "./application/ports/update-activation-context.js";

export { authorizeTrustCandidate } from "./application/trust-service.js";
export type { TrustAuthorizationResult } from "./application/trust-service.js";
export {
  ProjectTrustAssessmentSchema,
  CurrentProjectRuntimeContextSchema,
} from "./application/ports/project-trust.js";
export type {
  ProjectTrustAssessment,
  CurrentProjectRuntimeContext,
  ProjectTrustPort,
} from "./application/ports/project-trust.js";

export {
  savePluginConfiguration,
  removePluginConfiguration,
  ConfigurationCleanupError,
} from "./application/configuration-service.js";
export type {
  SavePluginConfigurationRequest,
  RemovePluginConfigurationRequest,
  ConfigurationCleanup,
  ConfigurationReconciliation,
  ConfigurationRecoveryCapability,
  ConfigurationRecoverySettlement,
  ConfigurationSaveResult,
  ConfigurationRemovalResult,
} from "./application/configuration-service.js";
export type { ConfigurationPathContext, ConfigurationPathPort } from "./application/ports/configuration-path.js";
export type { ProjectRootAuthorityPort, TrustedProjectRoot } from "./application/ports/project-root-authority.js";
export type { PluginConfigurationStore } from "./application/ports/plugin-configuration-store.js";
export type { SecretStore } from "./application/ports/secret-store.js";
export type { ConfigurationWriteIdPort } from "./application/ports/configuration-write-id.js";
export { SensitiveValue } from "./application/sensitive-value.js";
export {
  withResolvedPluginConfiguration,
  ConfigurationResolutionError,
} from "./application/configuration-resolver.js";
export type { ResolvedConfiguration } from "./application/resolved-configuration.js";

export {
  ErrorCodeRegistry,
  ErrorCodeSchema,
  FatalBoundaryCodeSchema,
  DiagnosticSchema,
  ReadResultSchema,
  CollectionReadResultSchema,
  DomainContractError,
  BoundaryError,
  ClaimConflictError,
  diagnosticFromZodError,
} from "./domain/errors.js";
export type {
  ErrorCode,
  FatalBoundaryCode,
  Diagnostic,
  ReadResult,
  CollectionReadResult,
} from "./domain/errors.js";

export {
  ForeignStateFileObservationSchema,
  AdoptionDocumentStatusSchema,
  AdoptionDiscoveryResultSchema,
  AdoptionPreviewRequestSchema,
  AdoptionPreviewCandidateSchema,
  AdoptionPreviewResultSchema,
  MarketplaceRegistrationRequestSchema,
  MarketplaceRegistrationResultSchema,
  AdoptionSelectionRequestSchema,
  AdoptionImportRequestSchema,
  AdoptionImportOutcomeSchema,
  AdoptionImportResultSchema,
} from "./application/adoption-contract.js";
export type {
  ForeignStateFileObservation,
  AdoptionDocumentStatus,
  AdoptionDiscoveryResult,
  AdoptionPreviewRequest,
  AdoptionPreviewCandidate,
  AdoptionPreviewResult,
  MarketplaceRegistrationRequest,
  MarketplaceRegistrationResult,
  AdoptionSelectionRequest,
  AdoptionImportRequest,
  AdoptionImportOutcome,
  AdoptionImportResult,
  AdoptionReader,
  AdoptionReaderRegistry,
} from "./application/adoption-contract.js";
export { createAdoptionService } from "./application/adoption-service.js";
export type {
  AdoptionService,
  AdoptionServiceDependencies,
  MarketplaceAdoptionRegistryPort,
} from "./application/adoption-service.js";
export type { ForeignStateFilesPort } from "./application/ports/foreign-state-files.js";
export type { MarketplaceRegistrationPort } from "./application/ports/marketplace-registration.js";
export { createNodeAdoptionService } from "./composition/create-adoption-service.js";
export type { NodeAdoptionServiceOptions } from "./composition/create-adoption-service.js";

export {
  ContentDigestSchema,
  ContentManifestEntrySchema,
  ContentManifestSchema,
  DEFAULT_CONTENT_MANIFEST_LIMITS,
  createContentManifest,
  createMaterializationBinding,
  hashContent,
  verifyContentManifest,
} from "./domain/content-manifest.js";
export type {
  ContentDigest,
  ContentManifestEntry,
  ContentManifest,
  ContentManifestLimits,
} from "./domain/content-manifest.js";

export {
  ContentStoreKindRegistry,
  ContentStoreKeySchema,
  MarketplaceStoreKeySchema,
  PluginStoreKeySchema,
  ContentStoreIdentitySchema,
  MarketplaceStoreIdentitySchema,
  PluginStoreIdentitySchema,
  createMarketplaceStoreIdentity,
  createPluginStoreIdentity,
  createMarketplaceStoreIdentityFromEvidence,
  createPluginStoreIdentityFromEvidence,
  verifyContentStoreIdentity,
  contentStoreKeyDigest,
  contentStoreKeySchema,
} from "./domain/content-store.js";
export type {
  ContentStoreKind,
  ContentStoreKey,
  ContentStoreIdentity,
  MarketplaceStoreIdentity,
  PluginStoreIdentity,
  MarketplaceStoreKey,
  PluginStoreKey,
} from "./domain/content-store.js";

export {
  DEFAULT_MATERIALIZATION_LIMITS,
  SourceMaterializationError,
  createSourceMaterializers,
} from "./application/source-materialization.js";
export type {
  ContentEntry,
  GitSourceAcquirer,
  MarketplaceMaterializer,
  MarketplacePathAcquirer,
  MaterializationFailureClassification,
  MaterializationLimits,
  MaterializedMarketplace,
  MaterializedPlugin,
  NpmSourceAcquirer,
  PluginMaterializer,
  SecureContentSession,
  SecureContentWriterFactory,
  SourceContext,
  SourceMaterializationDependencies,
  StagingSlot,
} from "./application/source-materialization.js";

export { createNodeSourceMaterializers } from "./infrastructure/source/create-source-materializers.js";
export type {
  ApprovedNetworkTarget,
  NetworkAddress,
  NetworkEgressPolicy,
  NetworkEgressPolicyOptions,
  NetworkLookup,
} from "./infrastructure/network/network-egress-policy.js";
export { createNodeContentStore } from "./infrastructure/filesystem/create-content-store.js";
export { verifyMaterializedContent } from "./infrastructure/filesystem/secure-content-writer.js";
export type { NodeSourceMaterializerOptions } from "./infrastructure/source/create-source-materializers.js";
export type { NodeContentStoreOptions } from "./infrastructure/filesystem/create-content-store.js";

export {
  BundleDocumentLimits,
  BundleDocumentLimitsSchema,
  BundleInspectionInputSchema,
  BundleInspectionResultSchema,
} from "./application/inspection-contract.js";
export type {
  BundleDocumentLimitsContract,
  BundleInspectionInput,
  BundleInspectionResult,
} from "./application/inspection-contract.js";
export { createContentIndex } from "./application/content-index.js";
export type { ContentIndex } from "./application/content-index.js";
export type {
  ContentReadPort,
  ManifestFileRef,
} from "./application/ports/content-read.js";
export type {
  AgentSkillReader,
  AgentSkillReaderContext,
  BundleReaderSet,
  HookDocumentReader,
  HookDocumentReaderContext,
  McpDocumentReader,
  McpDocumentReaderContext,
  PluginManifestReader,
  PluginManifestReaderContext,
  SkillPresentationReader,
} from "./application/ports/bundle-readers.js";

export { createPluginInspectionService } from "./application/inspection-service.js";
export type {
  PluginInspectionDependencies,
  PluginInspectionService,
} from "./application/inspection-service.js";

export {
  NativeInspectionSubjectKindSchema,
  NativeInspectionConditionSchema,
  NativeInspectionFreshnessSchema,
  InspectionSnapshotIdSchema,
  InspectionDetailIdSchema,
  InspectionCursorSchema,
  SafeDisplayFieldSchema,
  NativeProvenanceViewSchema,
  NativeRedactedUrlSchema,
  NativeMcpEndpointSchema,
  NativeSourceViewSchema,
  NativeSkillComponentViewSchema,
  NativeHookComponentViewSchema,
  NativeMcpComponentViewSchema,
  NativeForeignComponentViewSchema,
  NativeComponentInventoryViewSchema,
  NativeConfigurationOptionViewSchema,
  NativeTrustReadinessSchema,
  NativeRuntimeRequirementViewSchema,
  NativeCompatibilityViewSchema,
  NativeLifecycleViewSchema,
  NativeActivationViewSchema,
  NativeMcpHealthViewSchema,
  NativeDiagnosticFactSchema,
  NativeDiagnosticSchema,
  NativeInspectionListRequestSchema,
  NativeInspectionSummarySchema,
  NativeScopeObservationSchema,
  NativeInspectionPageSchema,
  NativeInspectionDetailRequestSchema,
  NativeInspectionDetailSchema,
  NativeInspectionDetailResultSchema,
  NativeDiagnosisRequestSchema,
  NativeDiagnosticReportSchema,
} from "./application/native-inspection-contract.js";
export type {
  NativeInspectionSubjectKind,
  NativeInspectionCondition,
  NativeInspectionFreshness,
  InspectionSnapshotId,
  InspectionDetailId,
  InspectionCursor,
  SafeDisplayField,
  NativeProvenanceView,
  NativeMcpEndpoint,
  NativeSourceView,
  NativeComponentInventoryView,
  NativeConfigurationOptionView,
  NativeTrustReadiness,
  NativeCompatibilityView,
  NativeLifecycleView,
  NativeActivationView,
  NativeMcpHealthView,
  NativeDiagnostic,
  NativeInspectionListRequest,
  NativeInspectionSummary,
  NativeScopeObservation,
  NativeInspectionPage,
  NativeInspectionDetailRequest,
  NativeInspectionDetail,
  NativeInspectionDetailResult,
  NativeDiagnosisRequest,
  NativeDiagnosticReport,
  NativeInspectionService,
} from "./application/native-inspection-contract.js";
export {
  NativeDisplayLimits,
  toSafeDisplayField,
} from "./application/native-inspection-display.js";
export {
  projectRedactedUrl,
  projectSafeSource,
  projectSafeProvenance,
  projectSafeComponents,
} from "./application/native-inspection-disclosure.js";

export {
  InstalledInspectionDetailSubjectSchema,
  CandidateInspectionDetailSubjectSchema,
  InspectionDetailSubjectSchema,
  InspectionCursorPayloadSchema,
  deriveInspectionSnapshotId,
  deriveInspectionEvidenceSnapshotId,
  deriveInspectionDetailId,
  decodeInspectionDetailId,
  verifyInspectionDetailId,
  encodeInspectionCursor,
  decodeInspectionCursor,
  verifyInspectionCursor,
  deriveInspectionFilterHash,
} from "./application/native-inspection-identifiers.js";
export type {
  InstalledInspectionDetailSubject,
  CandidateInspectionDetailSubject,
  InspectionDetailSubject,
  InspectionCursorPayload,
  InspectionCursorDecodeResult,
} from "./application/native-inspection-identifiers.js";
export {
  NativeDiagnosticRegistry,
  NativeDiagnosticCodeSchema,
  NativeDiagnosticCategorySchema,
  NativeDiagnosticActionSchema,
} from "./application/native-diagnostic-registry.js";
export type {
  NativeDiagnosticCode,
  NativeDiagnosticCategory,
  NativeDiagnosticAction,
  NativeDiagnosticRegistryKey,
} from "./application/native-diagnostic-registry.js";
export {
  createNativeInspectionService,
  NativeInspectionError,
} from "./application/native-inspection-service.js";

export {
  compileNativeDiagnostics,
  deriveNativeInspectionCondition,
  countNativeDiagnostics,
  unavailableEvidenceFinding,
} from "./application/native-diagnostic-compiler.js";
export type { NativeDiagnosticInput } from "./application/native-diagnostic-compiler.js";
export { reconcilePluginBundle } from "./application/bundle-reconciler.js";
export type { BundleReconciliationInput } from "./application/bundle-reconciler.js";
export { createNodePluginInspector } from "./composition/create-plugin-inspector.js";
export type { NodePluginInspectorOptions } from "./composition/create-plugin-inspector.js";

// Lifecycle state is a public contract, not a storage implementation. Export
// only schema-derived values, pure identity/codec helpers, and the adapter
// port; physical paths, locks, secret stores, projections, and operations stay
// outside the package boundary.
export {
  CanonicalProjectRootSchema,
  ProjectIdentitySchema,
  ProjectKeySchema,
  ScopeReferenceSchema,
  ScopeContextSchema,
  deriveProjectKey,
  createScopeContext,
  toScopeReference,
} from "./domain/state/scope.js";
export type {
  CanonicalProjectRoot,
  ProjectIdentity,
  ProjectKey,
  ScopeReference,
  ScopeContext,
} from "./domain/state/scope.js";
export type { ProjectRootResolutionPort } from "./application/ports/project-root-authority.js";

export {
  StateReferenceKindRegistry,
  StateBlobRefSchema,
  MarketplaceContentRefSchema,
  PluginContentRefSchema,
  PluginDataRefSchema,
  PluginConfigurationRefSchema,
  TrustSubjectRefSchema,
  PendingTransitionRefSchema,
  ProjectionRootRefSchema,
  StateReferenceSchema,
  ReferenceIdentitySchema,
  deriveStateBlobRef,
  deriveMarketplaceContentRef,
  derivePluginContentRef,
  derivePluginDataRef,
  derivePluginConfigurationRef,
  deriveTrustSubjectRef,
  derivePendingTransitionRef,
  deriveProjectionRootRef,
  verifyStateBlobRef,
  verifyMarketplaceContentRef,
  verifyPluginContentRef,
  verifyPluginDataRef,
  verifyPluginConfigurationRef,
  verifyTrustSubjectRef,
  verifyPendingTransitionRef,
  verifyProjectionRootRef,
} from "./domain/state/references.js";
export type {
  StateReferenceKind,
  StateReferenceTag,
  StateBlobRef,
  MarketplaceContentRef,
  PluginContentRef,
  PluginDataRef,
  PluginConfigurationRef,
  TrustSubjectRef,
  PendingTransitionRef,
  ProjectionRootRef,
  StateReference,
  ReferenceIdentity,
} from "./domain/state/references.js";

export {
  GenerationSchema,
  UpdateApplicationPreferenceSchema,
  MarketplaceConfigurationRecordSchema,
  HostUpdateGlobalPolicySchema,
  HostUpdateScopePolicySchema,
  HostConfigDocumentSchema,
} from "./domain/state/config-state.js";
export type {
  Generation,
  UpdateApplicationPreference,
  MarketplaceConfigurationRecord,
  HostUpdateGlobalPolicy,
  HostUpdateScopePolicy,
  HostConfigDocument,
} from "./domain/state/config-state.js";

export {
  PortableMarketplaceSourceSchema,
  PortablePluginSourceSchema,
  PortablePluginConstraintSchema,
  PortableMarketplaceDeclarationSchema,
  PortablePluginDeclarationSchema,
  PortableProjectDeclarationSchema,
  isSafePortableRelativePath,
  assertPortableProjectDeclarationSafe,
  parsePortableProjectDeclaration,
  decodePortableProjectDeclaration,
} from "./domain/state/portable-project-declaration.js";
export type {
  PortableMarketplaceSource,
  PortablePluginSource,
  PortablePluginConstraint,
  PortableMarketplaceDeclaration,
  PortablePluginDeclaration,
  PortableProjectDeclaration,
} from "./domain/state/portable-project-declaration.js";

export {
  ActivationIntentSchema,
  InstalledPluginIdentitySchema,
  InstalledSourceEvidenceSchema,
  InstalledComponentEvidenceSchema,
  InstalledCompatibilityEvidenceSchema,
  InstalledTrustEvidenceSchema,
  InstalledEvidenceSummarySchema,
  MarketplaceSourceEvidenceSchema,
  MarketplaceSnapshotRecordSchema,
  InstalledRevisionRecordSchema,
  InstalledPluginRecordSchema,
  InstalledUserStateDocumentSchema,
  createMarketplaceSnapshotRecord,
  createInstalledRevisionRecord,
  deriveStablePluginDataRef,
  verifyInstalledRevisionRecord,
  verifyInstalledPluginRecord,
  createInstalledPluginRecord,
  createInstalledUserStateDocument,
  decodeInstalledPluginRecords,
  decodeInstalledUserPlugins,
} from "./domain/state/installed-state.js";
export type {
  ActivationIntent,
  ComponentEvidenceKind,
  InstalledPluginIdentity,
  InstalledSourceEvidence,
  InstalledComponentEvidence,
  InstalledCompatibilityEvidence,
  InstalledTrustEvidence,
  InstalledEvidenceSummary,
  MarketplaceSourceEvidence,
  MarketplaceSnapshotRecord,
  InstalledRevisionRecord,
  InstalledPluginRecord,
  InstalledUserStateDocument,
  InstalledRecordQuarantine,
  InstalledRecordCollectionDecode,
} from "./domain/state/installed-state.js";

export {
  ProjectLocalStateDocumentSchema,
  createProjectLocalStateDocument,
  decodeProjectPlugins,
} from "./domain/state/project-state.js";
export type {
  ProjectLocalStateDocument,
  ProjectPluginRecordCollectionDecode,
} from "./domain/state/project-state.js";

export {
  StateDocumentKindRegistry,
  StateDocumentKindSchema,
  PointerDocumentKindSchema,
  StateDocumentPointerSchema,
  StatePointersDocumentSchema,
  createStatePointersDocument,
  verifyStatePointersScope,
} from "./domain/state/pointers.js";
export type {
  StateDocumentKind,
  PointerDocumentKind,
  StateDocumentPointer,
  StatePointersDocument,
} from "./domain/state/pointers.js";

export {
  TrustDecisionStatusSchema,
  ImmutableRevisionEvidenceSchema,
  TrustSubjectEvidenceSchema,
  TrustStateRecordSchema,
  TrustStateDocumentSchema,
  createTrustStateRecord,
  verifyTrustStateRecord,
  createTrustStateDocument,
  deriveTrustSubject,
} from "./domain/state/trust-state.js";
export type {
  TrustDecisionStatus,
  ImmutableRevisionEvidence,
  TrustSubjectEvidence,
  TrustStateRecord,
  TrustStateDocument,
} from "./domain/state/trust-state.js";

export {
  StateDocumentRegistry,
  getStateDocumentDefinition,
  stateDocumentKinds,
} from "./domain/state/registry.js";
export type {
  StateDocumentIsolation,
  RegisteredStateDocument,
  StateDocumentByKind,
  StateDocumentFor,
} from "./domain/state/registry.js";

export {
  StateCorruptionCodeRegistry,
  StateCorruptionCodeSchema,
  StateCorruptionSummarySchema,
  StateCorruptionFieldRegistry,
  StateCorruptionFieldIdSchema,
  StateCorruptionPointerSchema,
  StateCorruptionLocationSchema,
  StateCorruptionSchema,
  StateCodecError,
  StateVersionCutoverError,
  hashStateDocument,
  decodeStateDocument,
  encodeStateDocument,
} from "./domain/state/codec.js";
export type {
  StateCorruptionCode,
  StateCorruptionSummary,
  StateCorruptionFieldId,
  StateCorruptionPointer,
  StateCorruptionLocation,
  StateCorruption,
  StateCodecContext,
  DecodedDocument,
} from "./domain/state/codec.js";

export {
  UserStateMutationInputSchema,
  ProjectStateMutationInputSchema,
  StateMutationInputSchema,
  // These compatibility names are structural input schemas, not verified
  // mutation constructors.
  UserStateMutationSchema,
  ProjectStateMutationSchema,
  StateMutationSchema,
  parseStateMutation,
  validateStateMutation,
  isVerifiedStateMutation,
  StateLoadFailureSchema,
} from "./application/state-contract.js";
export type {
  UserScopeContext,
  ProjectScopeContext,
  UserGenerationSnapshot,
  ProjectGenerationSnapshot,
  GenerationSnapshot,
  UserStateMutationInput,
  ProjectStateMutationInput,
  StateMutationInput,
  UnverifiedStateMutation,
  VerifiedStateMutation,
  StateMutation,
  StateCommitResult,
  StateLoadResult,
} from "./application/state-contract.js";
export type { LifecycleStateStore } from "./application/ports/lifecycle-state-store.js";

export { createLifecycleTransitionReconciler } from "./application/lifecycle-transition-reconciler.js";
export type {
  LifecycleTransitionReconciler,
  LifecycleTransitionReconcilerDependencies,
} from "./application/lifecycle-transition-reconciler.js";
export type { LifecycleStateInventoryPort } from "./application/ports/lifecycle-state-inventory.js";
export type { RecoveryArtifactsPort } from "./application/ports/recovery-artifacts.js";

export {
  createPromotionPlan,
  assertVerifiedPromotionPlan,
} from "./application/content-promotion.js";
export type {
  PromotionPlanInput,
  VerifiedPromotionPlan,
} from "./application/content-promotion.js";
export type {
  ContentStoreCapabilities,
  ContentStorePort,
  PromotionResult,
  ResolvedContentRoot,
  StableDataRootRequest,
  WritableDataRoot,
  ProjectionRootRequest,
  ProjectionRootAllocation,
  ResolvedProjectionRoot,
  StagingAllocation,
} from "./application/ports/content-store.js";

export {
  RuntimeProjectionCacheEnvelopeSchemaV1,
} from "./application/runtime-projection-cache.js";
export type {
  RuntimeProjectionCacheEnvelope,
  PreparedRuntimeProjection,
  RuntimeProjectionCacheReadResult,
  RuntimeProjectionCacheReaderPort,
  RuntimeProjectionCachePort,
} from "./application/runtime-projection-cache.js";

// Mutation coordination is a portable application contract. The SQLite
// adapter, physical lock roots, retry timers, and protocol schema remain an
// infrastructure composition detail.
export { MutationSubjectSchema } from "./application/mutation-coordination.js";
export type {
  KeyedMutationScheduler,
  MutationSubject,
} from "./application/mutation-coordination.js";
export {
  createKeyedMutationScheduler,
  RecursiveMutationAcquisitionError,
} from "./infrastructure/state/keyed-mutation-scheduler.js";
export type {
  ScopeLockLease,
  ScopeLockManager,
} from "./application/ports/scope-lock.js";
export {
  CommittedMutationCleanupError,
  MutationCleanupError,
  createGenerationMutationCoordinator,
} from "./application/generation-mutation-coordinator.js";
export type {
  GenerationMutationCoordinator,
  GenerationMutationCoordinatorDependencies,
  GenerationMutationResult,
  PreparedMutation,
  PreparedMutationContext,
  PreparedMutationRequest,
} from "./application/generation-mutation-coordinator.js";

// Whole-plugin lifecycle is exposed as one facade plus narrow, adapter-neutral
// evidence ports. Candidate preparation and guarded mutation helpers stay
// private so callers cannot bypass transaction policy.
export {
  LifecycleOperationRegistry,
  LifecycleOperationSchema,
  LifecycleOriginRegistry,
  LifecycleOriginSchema,
  LifecycleRetainedDataRegistry,
  LifecycleRetainedDataSchema,
  LifecycleRejectionCodeRegistry,
  LifecycleRejectionCodeSchema,
  LifecycleOutcomeRegistry,
  LifecycleOutcomeSchema,
  LifecyclePluginStateSchema,
  LifecyclePluginReferenceSchema,
  PendingTransitionIdentitySchema,
  LifecyclePluginRequestSchema,
  LifecycleRecoveryEvidenceSchema,
  deriveLifecyclePendingTransitionRef,
} from "./application/plugin-lifecycle-contract.js";
export type {
  LifecycleOperation,
  LifecycleOrigin,
  LifecycleRetainedData,
  LifecycleRejectionCode,
  LifecycleOutcome,
  LifecyclePluginState,
  LifecyclePluginReference,
  PendingTransitionIdentity,
  LifecyclePluginRequest,
  LifecycleRecoveryEvidence,
} from "./application/plugin-lifecycle-contract.js";

export {
  RuntimePluginComponentsSchema,
  PluginRuntimeProjectionSchemaV1,
  ProjectionExpectationSchema,
  createPluginRuntimeProjection,
  createActiveProjectionExpectation,
  createInactiveProjectionExpectation,
  verifyProjectionExpectation,
} from "./application/ports/runtime-projection.js";
export type {
  RuntimePluginComponents,
  PluginRuntimeProjection,
  ProjectionExpectation,
  RuntimeProjectionPort,
} from "./application/ports/runtime-projection.js";

export {
  ActivationObservationSchema,
  RuntimeContributionParticipantSchema,
  RuntimeContributionObservationSchema,
  SkillHookContributionObservationSchema,
  McpRegistrationObservationSchema,
  McpContributionObservationSchema,
  LifecycleReloadResultSchemaRegistry,
  LifecycleReloadResultSchema,
  LifecycleReloadRequestSchema,
  LifecycleObservationRequestSchema,
  composeActivationObservation,
  verifyActivationObservation,
} from "./application/ports/lifecycle-reload.js";
export type {
  ActivationObservation,
  RuntimeContributionParticipant,
  RuntimeContributionObservation,
  SkillHookContributionObservation,
  McpRegistrationObservation,
  McpContributionObservation,
  LifecycleReloadResult,
  LifecycleReloadRequest,
  LifecycleObservationRequest,
  LifecycleReloadPort,
} from "./application/ports/lifecycle-reload.js";

export {
  McpLifecycleFailureCodeSchema,
  McpLifecycleAmbiguityCodeSchema,
  McpLifecycleReconcileResultSchema,
  McpLifecycleObservationResultSchema,
  McpLifecycleStatusResultSchema,
  createMcpLifecycleParticipant,
} from "./runtime/mcp/lifecycle-participant.js";
export type {
  McpLifecycleState,
  McpLifecycleTransitionRequest,
  McpLifecycleFailureCode,
  McpLifecycleAmbiguityCode,
  McpLifecycleReconcileResult,
  McpLifecycleObservationResult,
  McpLifecycleOwner,
  McpLifecycleStatusResult,
  McpLifecycleParticipant,
} from "./runtime/mcp/lifecycle-participant.js";
export { createMcpRevisionLeaseProvider } from "./runtime/mcp/revision-lease-provider.js";

export {
  createSkillHookSnapshotLoader,
} from "./runtime/skill-hook/runtime-snapshot.js";
export type {
  RuntimeProjectionSelection,
  SkillHookRuntimeSnapshot,
  SkillHookSnapshotResult,
} from "./runtime/skill-hook/runtime-snapshot.js";
export {
  createSkillHookRuntimeParticipant,
} from "./runtime/skill-hook/lifecycle-participant.js";
export type {
  SkillHookRuntimeCatalog,
  SkillHookRuntimeSetRequest,
  SkillHookReconcileResult,
  SkillHookLifecycleParticipant,
  SkillHookSnapshotParticipant,
  SkillHookSnapshotObservationResult,
} from "./runtime/skill-hook/lifecycle-participant.js";
export {
  SkillHookSnapshotObservationSchema,
  SkillResourceContributionObservationSchema,
  composeSkillHookContributionObservation,
} from "./runtime/skills/contribution-observation.js";
export type {
  SkillHookSnapshotObservation,
  SkillResourceContributionObservation,
} from "./runtime/skills/contribution-observation.js";
export { createSkillResourceDiscoveryRuntime } from "./runtime/skills/resource-discovery.js";
export type {
  SkillResourceDiscoveryPort,
  SkillResourceDiscoveryRequest,
  SkillResourceDiscoveryResult,
  SkillResourceTargetFailure,
  SkillResourceContributionObservationResult,
  SkillHookContributionObservationResult,
} from "./runtime/skills/resource-discovery.js";

export {
  LifecycleTransitionRecordSchemaV1,
  LifecycleTransitionStatusSchema,
  LifecycleTransitionJournalEntrySchemaV1,
  LifecycleTransitionJournalEntrySchemaV2,
  LifecycleUninstallCleanupStatusSchema,
  migrateLifecycleTransitionJournalEntryV1,
  LifecycleTransitionPrepareResultSchema,
  LifecycleTransitionOutcomeSchema,
  LifecycleTransitionSettleRequestSchema,
  TransitionJournalReadResultSchema,
  createLifecycleTransitionRecord,
} from "./application/ports/lifecycle-transition-store.js";
export type {
  LifecycleTransitionRecord,
  LifecycleTransitionPrepareResult,
  LifecycleTransitionStatus,
  LifecycleTransitionJournalEntryV1,
  LifecycleTransitionJournalEntry,
  LifecycleUninstallCleanupStatus,
  LifecycleTransitionOutcome,
  LifecycleTransitionSettleRequest,
  TransitionJournalReadResult,
  LifecycleTransitionStore,
} from "./application/ports/lifecycle-transition-store.js";

export {
  LifecycleOperationIdSchema,
  parseLifecycleOperationId,
} from "./application/ports/lifecycle-operation-id.js";
export type {
  LifecycleOperationId,
  LifecycleOperationIdPort,
} from "./application/ports/lifecycle-operation-id.js";

export {
  LoadedInstalledPluginSchema,
  InstalledPluginLoaderRequestSchema,
  verifyLoadedInstalledPlugin,
} from "./application/ports/installed-plugin-loader.js";
export type {
  LoadedInstalledPlugin,
  InstalledPluginLoaderRequest,
  InstalledPluginLoader,
} from "./application/ports/installed-plugin-loader.js";

export {
  createPluginLifecycleService,
  PluginLifecycleResultSchema,
} from "./application/plugin-lifecycle-service.js";
export type {
  InstallPluginRequest,
  UpdatePluginRequest,
  EnablePluginRequest,
  DisablePluginRequest,
  UninstallPluginRequest,
  LifecycleActivationFailure,
  LifecycleCleanupIntent,
  PluginLifecycleResult,
  PluginLifecycleService,
  PluginLifecycleServiceDependencies,
} from "./application/plugin-lifecycle-service.js";

export { EpochMillisecondsSchema } from "./application/ports/lifecycle-clock.js";
export type { EpochMilliseconds, LifecycleClock } from "./application/ports/lifecycle-clock.js";

export {
  MarketplaceRefreshRequestSchema,
  UpdateDispositionSchema,
  NotificationIntentSchema,
  PluginUpdateOutcomeSchema,
  MarketplaceRefreshOutcomeSchema,
  MarketplaceRefreshResultSchema,
} from "./application/update-contract.js";
export type {
  MarketplaceRefreshRequest,
  UpdateDisposition,
  NotificationIntent,
  PluginUpdateOutcome,
  MarketplaceRefreshOutcome,
  MarketplaceRefreshResult,
} from "./application/update-contract.js";
export {
  MarketplaceManagementContractRegistry,
  MarketplaceCacheStatusSchema,
  MarketplaceSelectedSnapshotViewSchema,
  MarketplaceRegistrationViewSchema,
  MarketplaceAddRequestSchema,
  MarketplaceAddResultSchema,
  MarketplaceRemoveRequestSchema,
  MarketplaceRemoveResultSchema,
  MarketplaceRegistrationListRequestSchema,
  MarketplaceRegistrationPageSchema,
} from "./application/marketplace-management-contract.js";
export type {
  MarketplaceCacheStatus,
  MarketplaceSelectedSnapshotView,
  MarketplaceRegistrationView,
  MarketplaceAddRequest,
  MarketplaceAddResult,
  MarketplaceRemoveRequest,
  MarketplaceRemoveResult,
  MarketplaceRegistrationListRequest,
  MarketplaceRegistrationPage,
} from "./application/marketplace-management-contract.js";
export { createMarketplaceRegistrationService } from "./application/marketplace-registration-service.js";
export type {
  MarketplaceRegistrationService,
  MarketplaceRegistrationServiceDependencies,
} from "./application/marketplace-registration-service.js";

export {
  MarketplaceCatalogSearchRequestSchema,
  CatalogClaimOriginSchema,
  CatalogAvailableRevisionSchema,
  MarketplaceCandidateSummarySchema,
  MarketplaceCatalogObservationSchema,
  MarketplaceCatalogPageSchema,
  MarketplaceCandidateDetailSchema,
  MarketplaceCandidateDetailResultSchema,
  MarketplaceCatalogError,
} from "./application/marketplace-catalog-contract.js";
export type {
  MarketplaceCatalogSearchRequest,
  CatalogClaimOrigin,
  CatalogAvailableRevision,
  MarketplaceCandidateSummary,
  MarketplaceCatalogObservation,
  MarketplaceCatalogPage,
  MarketplaceCandidateDetail,
  MarketplaceCandidateDetailResult,
} from "./application/marketplace-catalog-contract.js";

export {
  UpdatePolicyWinningLevelSchema,
  EffectiveUpdatePolicySchema,
  NativeUpdatePolicyPreviewSchema,
  NativeUpdatePolicyPreviewResultSchema,
  NativeUpdatePolicyApplyRequestSchema,
  NativeUpdatePolicyApplyResultSchema,
  NativeUpdateStatusRequestSchema,
  NativeUpdatePolicyStatusSchema,
  NativeUpdateStatusSchema,
  NativeUpdateNotificationListRequestSchema,
  NativeUpdateNotificationViewSchema,
  NativeUpdateNotificationPageSchema,
  NativeUpdateAcknowledgmentRequestSchema,
  NativeUpdateAcknowledgmentResultSchema,
  NativeAutomaticUpdateRunRequestSchema,
  NativeAutomaticUpdateRunResultSchema,
} from "./application/native-update-contract.js";
export type {
  UpdatePolicyWinningLevel,
  EffectiveUpdatePolicy,
  NativeUpdatePolicyPreview,
  NativeUpdatePolicyPreviewResult,
  NativeUpdatePolicyApplyRequest,
  NativeUpdatePolicyApplyResult,
  NativeUpdateStatusRequest,
  NativeUpdatePolicyStatus,
  NativeUpdateStatus,
  NativeUpdateNotificationListRequest,
  NativeUpdateNotificationView,
  NativeUpdateNotificationPage,
  NativeUpdateAcknowledgmentRequest,
  NativeUpdateAcknowledgmentResult,
  NativeAutomaticUpdateRunRequest,
  NativeAutomaticUpdateRunResult,
} from "./application/native-update-contract.js";
export {
  deriveUpdateNoticeId,
  deriveUpdatePolicyPreviewId,
  deriveUpdatePolicyConsentId,
} from "./application/native-update-identifiers.js";
export { resolveEffectiveUpdatePolicy } from "./application/update-policy-resolution.js";
export type { UpdatePolicyResolutionInput } from "./application/update-policy-resolution.js";
export { createNativeUpdatePolicyService } from "./application/native-update-policy-service.js";
export type {
  NativeUpdatePolicyService,
  NativeUpdatePolicyServiceDependencies,
} from "./application/native-update-policy-service.js";
export type { UpdatePolicyAuthorityPort } from "./application/ports/update-policy-authority.js";
export {
  HostPrecedenceOrderSchema,
  NativeHostPrecedenceRequestSchema,
  NativeHostPrecedenceResultSchema,
} from "./application/host-precedence-contract.js";
export type {
  HostPrecedenceOrder,
  NativeHostPrecedenceRequest,
  NativeHostPrecedenceResult,
} from "./application/host-precedence-contract.js";
export {
  createHostPrecedenceProvider,
  createHostPrecedenceService,
} from "./application/host-precedence-service.js";
export type {
  HostPrecedenceService,
  HostPrecedenceServiceDependencies,
} from "./application/host-precedence-service.js";
export { createNativeUpdateManagementService } from "./application/native-update-management-service.js";
export type { NativeUpdateManagementService } from "./application/native-update-management-service.js";
export { createNativeUpdateManagementComposition } from "./composition/create-native-update-management-service.js";
export { createAutomaticUpdateLifecycleAdapter } from "./composition/automatic-update-lifecycle-adapter.js";
export {
  UpdateNoticeRetentionPolicy,
  pruneUpdateNotices,
  createUpdateNotificationService,
} from "./application/update-notification-service.js";
export type {
  ExactUpdateDiscovery,
  UpdateNotificationDispatchResult,
  NativeUpdateNoticeReconciliationResult,
  UpdateNotificationService,
  UpdateNotificationServiceDependencies,
} from "./application/update-notification-service.js";
export type {
  UpdateNotificationEvent,
  UpdateNotificationPublisherPort,
} from "./application/ports/update-notification-publisher.js";

export type { RefreshClaimIdPort } from "./application/ports/refresh-claim-id.js";
export type { UpdateDelayPort } from "./application/ports/update-delay.js";
export {
  MarketplaceUpdatePreferenceResultSchema,
  createMarketplaceUpdatePolicyService,
} from "./application/marketplace-update-policy-service.js";
export type {
  MarketplaceUpdatePreferenceResult,
  MarketplaceUpdatePolicyService,
} from "./application/marketplace-update-policy-service.js";
export {
  DefaultMarketplaceUpdatePolicy,
  createMarketplaceRefreshService,
} from "./application/marketplace-refresh-service.js";
export type {
  MarketplacePluginProbeResult,
  MarketplacePluginProbePort,
  MarketplaceRefreshService,
  MarketplaceRefreshServiceDependencies,
} from "./application/marketplace-refresh-service.js";
export {
  DEFAULT_INVENTORY_POLL_MS,
  DEFAULT_LEASE_MS,
  createMarketplaceUpdateScheduler,
} from "./application/marketplace-update-scheduler.js";
export type {
  UpdateSchedulerStatus,
  MarketplaceUpdateScheduler,
  MarketplaceUpdateSchedulerDependencies,
} from "./application/marketplace-update-scheduler.js";
export {
  deriveUpdateSchedule,
  scheduleClockState,
} from "./application/update-schedule.js";
export type { UpdateScheduleRequest } from "./application/update-schedule.js";
export { createStateUpdateSchedulerLeasePort } from "./application/update-scheduler-lease-state.js";
export type {
  UpdateSchedulerScopePlan,
  UpdateSchedulerLeasePort,
} from "./application/ports/update-scheduler-lease.js";
export type { UpdateSchedulerLeaseIdPort } from "./application/ports/update-scheduler-lease-id.js";
export {
  createNodeMarketplaceRefreshServices,
} from "./composition/create-marketplace-refresh-services.js";
export type {
  NodeMarketplaceRefreshServices,
  NodeMarketplaceRefreshServicesOptions,
} from "./composition/create-marketplace-refresh-services.js";
export { createNodeMarketplaceUpdateServices } from "./composition/create-marketplace-update-services.js";
export type {
  NodeMarketplaceUpdateServices,
  NodeMarketplaceUpdateServicesOptions,
} from "./composition/create-marketplace-update-services.js";
export { createNodeMarketplaceDiscoveryServices } from "./composition/create-marketplace-discovery-services.js";
export type {
  MarketplaceDiscoveryServices,
  NodeMarketplaceDiscoveryServicesOptions,
} from "./composition/create-marketplace-discovery-services.js";

export {
  DefaultLifecycleRecoveryPolicy,
  RecoveryDiagnosticCodeSchema,
  RecoveryPolicySchema,
  TransitionRecoveryResultSchema,
  LifecycleRecoveryResultSchema,
  RecoveryEvidenceSchema,
  RecoveryClassificationSchema,
} from "./application/recovery-contract.js";
export type {
  RecoveryDiagnosticCode,
  RecoveryPolicy,
  TransitionRecoveryResult,
  LifecycleRecoveryResult,
  RecoveryEvidence,
  RecoveryClassification,
} from "./application/recovery-contract.js";
export { createLifecycleRecoveryService } from "./application/recovery-service.js";
export type {
  LifecycleRecoveryService,
  LifecycleRecoveryServiceDependencies,
  LifecycleRecoveryServiceRequest,
} from "./application/recovery-service.js";

export {
  RetainedArtifactRefSchema,
  RevisionArtifactKindSchema,
} from "./application/ports/revision-artifact-store.js";
export type {
  RetainedArtifactRef,
  RevisionArtifactKind,
  RevisionArtifactCandidate,
  RevisionArtifactCollection,
  RevisionArtifactStore,
} from "./application/ports/revision-artifact-store.js";
export { DefaultRevisionCollectionPolicy, RevisionCollectionPolicySchema, RevisionCollectionResultSchema } from "./application/revision-collection-service.js";
export {
  RevisionLeaseSchema,
  RevisionLeaseOwnerStatusSchema,
  RevisionLeaseCollectionSchema,
} from "./application/ports/revision-lease-store.js";
export type { RevisionLease, RevisionLeaseOwnerStatus, RevisionLeaseCollection, RevisionLeaseStore } from "./application/ports/revision-lease-store.js";
export { RevisionRetentionMarkSchema, RevisionRetentionSnapshotSchema } from "./application/ports/revision-retention-store.js";
export type { RevisionRetentionMark, RevisionRetentionSnapshot, RevisionRetentionStore } from "./application/ports/revision-retention-store.js";
export { PersistentDataRemovalPlanSchema } from "./application/ports/persistent-data-removal.js";
export type { PersistentDataRemovalPlan, PersistentDataRemovalPort } from "./application/ports/persistent-data-removal.js";
export { createRevisionCollectionService } from "./application/revision-collection-service.js";
export type { RevisionCollectionPolicy, RevisionCollectionResult, RevisionCollectionDependencies } from "./application/revision-collection-service.js";
export { ConfirmedUninstallCleanupResultSchema, createConfirmedUninstallCleanup } from "./application/confirmed-uninstall-cleanup.js";
export type { ConfirmedUninstallCleanupResult, ConfirmedUninstallCleanupDependencies, ConfirmedUninstallCleanupRequest } from "./application/confirmed-uninstall-cleanup.js";
export { createNativeUninstallCleanupService } from "./application/native-uninstall-cleanup.js";
export type { NativeUninstallCleanupResult, NativeUninstallCleanupService } from "./application/native-uninstall-cleanup.js";
export { createNodeRecoveryAdapters } from "./infrastructure/recovery/create-node-recovery-adapters.js";
export type { NodeRecoveryAdapterOptions, NodeRecoveryAdapters } from "./infrastructure/recovery/create-node-recovery-adapters.js";

export {
  TrustedInstallSessionPolicy,
  TrustedInstallSessionTokenSchema,
  TrustedInstallSessionVersionSchema,
  TrustedInstallConsentIdSchema,
  PreparedLifecycleCandidateBindingSchema,
  TrustedInstallCandidateBindingSchema,
  TrustedInstallSessionStateRegistry,
  TrustedInstallSessionStateSchema,
  TrustedInstallConstraintViewSchema,
  TrustedInstallConfigurationFieldSchema,
  TrustedInstallConsentDisclosureSchema,
  TrustedInstallProgressPhaseRegistry,
  TrustedInstallProgressEventSchema,
  TrustedInstallSessionViewSchema,
  TrustedInstallOpenRequestSchema,
  TrustedInstallSubmissionSchema,
  TrustedInstallInputIssueRegistry,
  TrustedInstallInputIssueSchema,
  TrustedInstallStaleReasonSchema,
  TrustedInstallConflictReasonSchema,
  TrustedInstallOpenResultSchema,
  TrustedInstallActivationResultSchema,
  TrustedInstallStatusResultSchema,
  TrustedInstallCancellationResultSchema,
} from "./application/trusted-install-contract.js";
export type {
  TrustedInstallSessionState,
  TrustedInstallSessionToken,
  TrustedInstallConsentId,
  PreparedLifecycleCandidateBinding,
  TrustedInstallCandidateBinding,
  TrustedInstallConfigurationField,
  TrustedInstallConsentDisclosure,
  TrustedInstallProgressEvent,
  TrustedInstallSessionView,
  TrustedInstallOpenRequest,
  TrustedInstallSubmission,
  TrustedInstallInputIssue,
  TrustedInstallOpenResult,
  TrustedInstallActivationResult,
  TrustedInstallStatusResult,
  TrustedInstallCancellationResult,
  TrustedInstallDecisionProvider,
  TrustedInstallExecutionOptions,
  TrustedInstallRunOptions,
  TrustedInstallationService,
} from "./application/trusted-install-contract.js";
export {
  createTrustedInstallSessionToken,
  verifyTrustedInstallSessionToken,
  deriveTrustedInstallConsentDisclosureDigest,
  deriveTrustedInstallConsentId,
} from "./application/trusted-install-identifiers.js";
export { createTrustedInstallationService } from "./application/trusted-install-service.js";
export type { TrustedInstallationServiceDependencies } from "./application/trusted-install-service.js";

export {
  NativeLifecycleOperationSessionPolicy,
  NativeLifecycleOperationRegistry,
  NativeLifecycleOperationKindSchema,
  NativeLifecycleProgressPhaseRegistry,
  NativeLifecycleProgressPhaseSchema,
  NativeLifecycleStableCodeRegistry,
  NativeLifecycleStableCodeSchema,
  NativeLifecycleOperationTokenSchema,
  NativeLifecyclePreviewIdSchema,
  NativeLifecycleSessionVersionSchema,
  NativeInstalledOperationTargetRequestSchema,
  NativeLifecycleOperationRequestSchema,
  LifecycleTargetExpectationSchema,
  NativeLifecycleTargetBindingSchema,
  NativeLifecycleOperationPreviewSchema,
  NativeLifecycleProgressEventSchema,
  NativeLifecycleEffectSchema,
  NativeLifecycleRetainedPreflightEvidenceSchema,
  NativeLifecycleOperationResultSchema,
  NativeLifecycleOperationSessionStateSchema,
  NativeLifecycleOperationSessionViewSchema,
  NativeLifecycleOperationPreviewResultSchema,
  NativeUpdateConfirmationInputSchema,
  NativeLifecycleOperationConfirmationSchema,
  NativeLifecycleOperationStatusResultSchema,
  NativeLifecycleOperationCancellationResultSchema,
} from "./application/native-lifecycle-operation-contract.js";
export type {
  NativeLifecycleOperationKind,
  NativeLifecycleStableCode,
  NativeLifecycleOperationToken,
  NativeLifecyclePreviewId,
  NativeLifecycleSessionVersion,
  NativeInstalledOperationTargetRequest,
  NativeLifecycleOperationRequest,
  LifecycleTargetExpectation,
  NativeLifecycleTargetBinding,
  NativeLifecycleOperationPreview,
  NativeLifecycleProgressPhase,
  NativeLifecycleProgressEvent,
  NativeLifecycleEffect,
  NativeLifecycleRetainedPreflightEvidence,
  NativeLifecycleOperationResult,
  NativeLifecycleOperationSessionState,
  NativeLifecycleOperationSessionView,
  NativeLifecycleOperationPreviewResult,
  NativeUpdateConfirmationInput,
  NativeLifecycleOperationConfirmation,
  NativeLifecycleOperationStatusResult,
  NativeLifecycleOperationCancellationResult,
  NativeLifecycleProgressSink,
  NativeLifecycleDecisionProvider,
  NativeLifecycleExecutionOptions,
  NativeLifecycleRunOptions,
  NativeLifecycleOperationService,
} from "./application/native-lifecycle-operation-contract.js";
export {
  ProjectSyncModeRegistry,
  ProjectSyncModeSchema,
  ProjectSyncActionKindRegistry,
  ProjectSyncActionKindSchema,
  ProjectSyncRequiredActionKindRegistry,
  ProjectSyncRequiredActionKindSchema,
  ProjectIntentObservationIdSchema,
  ProjectSyncActionIdSchema,
  ProjectSyncConflictIdSchema,
  ProjectSyncActionSchema,
  ProjectSyncRequiredActionSchema,
  ProjectSyncConflictValueSchema,
  ProjectSyncConflictSchema,
  ProjectSyncConflictResolutionSchema,
  ProjectSyncPlanSchema,
  VerifiedProjectSyncContextSchema,
} from "./application/project-sync-contract.js";
export type {
  ProjectSyncMode,
  ProjectIntentObservationId,
  ProjectSyncActionId,
  ProjectSyncConflictId,
  ProjectSyncAction,
  ProjectSyncRequiredAction,
  ProjectSyncConflictValue,
  ProjectSyncConflict,
  ProjectSyncConflictResolution,
  ProjectSyncPlan,
  VerifiedProjectSyncContext,
} from "./application/project-sync-contract.js";
export {
  createProjectSyncPlanningContext,
  resolveProjectSyncConflicts,
  ProjectSyncPlanningError,
} from "./application/project-sync-planner.js";
export type {
  ProjectSyncPlannerFile,
  ProjectSyncPlannerContext,
} from "./application/project-sync-planner.js";
export { deriveProjectSyncReadinessDigest, projectProjectSyncMachineState } from "./application/project-sync-projection.js";
export type { ProjectPluginSyncReadiness, ProjectSyncReadinessSnapshot, ProjectSyncMachineProjection } from "./application/project-sync-projection.js";

export { ProjectIntentWriteIdSchema } from "./application/ports/project-intent-write-id.js";
export type { ProjectIntentWriteId, ProjectIntentWriteIdPort } from "./application/ports/project-intent-write-id.js";
export type {
  VerifiedProjectIntentObservation,
  ProjectIntentReadResult,
  ProjectIntentReplaceResult,
  ProjectIntentFilePort,
} from "./application/ports/project-intent-file.js";
export { encodeProjectIntentDeclaration, decodeProjectIntentBytes } from "./application/project-intent-codec.js";
export type { ProjectIntentDecodeResult } from "./application/project-intent-codec.js";

export { createNativeLifecycleOperationService } from "./application/native-lifecycle-operation-service.js";
export type { NativeLifecycleOperationServiceDependencies } from "./application/native-lifecycle-operation-service.js";

export {
  createNativeLifecycleOperationToken,
  verifyNativeLifecycleOperationToken,
  deriveNativeLifecyclePreviewId,
  deriveProjectIntentObservationId,
  deriveProjectSyncActionId,
  deriveProjectSyncConflictId,
} from "./application/native-lifecycle-operation-identifiers.js";

export {
  HostCapabilityStatusSchema,
  HostCapabilitiesSchema,
  HostBlockedPluginSchema,
  HostReadinessStatusSchema,
  HostStartupResultSchema,
  HostStatusSnapshotSchema,
} from "./application/host-observation-contract.js";
export type {
  HostCapabilities,
  HostBlockedPluginObservation,
  HostReadinessStatus,
  HostStatusSnapshot,
} from "./application/host-observation-contract.js";
export { createHostStatusService } from "./composition/host-status-service.js";
export type { HostStatusService, MutableHostStatus } from "./composition/host-status-service.js";
export { createBackgroundUpdateCoordinator } from "./composition/background-update-coordinator.js";
export type { BackgroundUpdateCoordinator } from "./composition/background-update-coordinator.js";
export { createPackagedHostStartup } from "./composition/packaged-host-startup.js";
export type { PackagedHostStartup } from "./composition/packaged-host-startup.js";

export {
  NativeControlGrammarVersionSchema,
  NativeControlInputChannelSchema,
  NativeControlInvocationSchema,
  NativeControlCommandRegistry,
  NativeControlCommandIdSchema,
  NativeControlCommandSchema,
  nativeControlCommandIds,
} from "./application/native-control-registry.js";
export type {
  NativeControlGrammarVersion,
  NativeControlInputChannel,
  NativeControlInvocation,
  NativeControlOptionKind,
  NativeControlOptionDefinition,
  NativeControlPositionalDefinition,
  NativeControlCommandDefinition,
  NativeControlCommandId,
  NativeControlCommand,
  NativeControlPolicyChange,
} from "./application/native-control-registry.js";
export { NativeControlPolicyChangeSchema } from "./application/native-control-registry.js";
export {
  NativeControlEnvelopeVersionSchema,
  NativeControlExecutionIdSchema,
  NativeControlExitRegistry,
  NativeControlExitSchema,
  NativeControlStatusSchema,
  NativeControlDiagnosticSchema,
  NativeControlOperationHandleSchema,
  NativeControlPageSchema,
  NativeControlEnvelopeSchema,
  nativeControlExit,
  nativeControlStatusExit,
  createNativeControlEnvelope,
} from "./application/native-control-contract.js";
export type {
  NativeControlExecutionId,
  NativeControlExitKey,
  NativeControlExit,
  NativeControlStatus,
  NativeControlDiagnostic,
  NativeControlOperationHandle,
  NativeControlEnvelope,
} from "./application/native-control-contract.js";
export {
  NativeControlArgvSchema,
  NativeControlLexTokenSchema,
  NativeControlLexResultSchema,
  lexNativeControlText,
  validateNativeControlScalar,
} from "./application/native-control-lexer.js";
export type { NativeControlArgv, NativeControlLexToken, NativeControlLexResult } from "./application/native-control-lexer.js";
export {
  NativeControlHelpCommandSchema,
  NativeControlHelpSchema,
  NativeControlExpectationSchema,
  NativeControlCompletionRequestSchema,
  NativeControlCompletionResultSchema,
  createNativeControlHelp,
  nativeControlGrammarMetadata,
} from "./application/native-control-help.js";
export type {
  NativeControlHelp,
  NativeControlExpectation,
  NativeControlCompletionRequest,
  NativeControlCompletionResult,
} from "./application/native-control-help.js";
export {
  NativeControlParseResultSchema,
  createNativeControlParser,
} from "./application/native-control-parser.js";
export type { NativeControlParseResult, NativeControlParser } from "./application/native-control-parser.js";
export type {
  NativeControlInputPurpose,
  NativeControlInputRequest,
  NativeControlExactDecision,
  NativeControlInputIssue,
  NativeControlInputResult,
  NativeControlInputPort,
} from "./application/ports/native-control-input.js";
export {
  unavailableNativeControlInput,
  validateNativeControlInput,
  collectNativeControlInput,
  toTrustedInstallSubmission,
  inputRequiredIssues,
} from "./application/native-control-input.js";
export {
  projectNativeControlJson,
  assertNativeControlJsonSafe,
  nativeControlContainsForbiddenValue,
} from "./application/native-control-redaction.js";
export { createNodeControlInput } from "./infrastructure/control/node-control-input.js";
export type { NodeControlInputOptions } from "./infrastructure/control/node-control-input.js";
export {
  NativeControlScopeSchema,
  NativeControlPluginSelectorSchema,
  NativeControlCandidateSelectorSchema,
  NativeControlUpdateSelectorSchema,
  createNativeControlSelectionService,
} from "./application/native-control-selection.js";
export type {
  NativeControlScope,
  NativeControlPluginSelector,
  NativeControlCandidateSelector,
  NativeControlUpdateSelector,
  NativeControlSelectionFailure,
  NativeControlInstalledSelectionResult,
  NativeControlCandidateSelectionResult,
  NativeControlUpdateSelectionResult,
  NativeControlCurrentProjectResult,
  NativeControlCurrentProjectPort,
  NativeControlSelectionService,
} from "./application/native-control-selection.js";
export type { NativeControlDispatchResult } from "./application/native-control-projection.js";
export {
  NativeControlFrameSchema,
  NativeControlDeliveryClosedError,
  createNativeControlProgressController,
} from "./application/native-control-progress.js";
export type { NativeControlFrame, NativeControlProgressController } from "./application/native-control-progress.js";
export {
  parseNativeControlOperationHandle,
  createNativeControlOperationRouter,
} from "./application/native-control-operation.js";
export {
  NativeControlAdmissionError,
  createNativeControlExecutionCoordinator,
} from "./application/native-control-execution.js";
export type {
  NativeControlDispatchFunction,
  NativeControlExecutionCoordinator,
} from "./application/native-control-execution.js";
export type {
  NativeControlFrameSink,
  NativeControlExecutionIdPort,
  NativeControlTimeoutPort,
  NativeControlExecutionReport,
  NativeControlExecutionCoreOptions,
  NativeControlProgressSink,
  NativeControlDispatchExecutionContext,
} from "./application/ports/native-control-execution.js";
export { classifyNativeControlError } from "./application/native-control-error.js";
export type { NativeControlErrorClassification } from "./application/native-control-error.js";
export { createNativeControlHumanProjector } from "./application/native-control-human.js";
export type { NativeControlHumanProjector } from "./application/native-control-human.js";
export { createNativeControlResultProjector } from "./application/native-control-result.js";
export type { NativeControlResultProjector } from "./application/native-control-result.js";
export { createNodeJsonLinesSink } from "./infrastructure/control/node-json-lines-sink.js";
export type { NodeJsonLinesSinkOptions } from "./infrastructure/control/node-json-lines-sink.js";
export { runNodeNativeControlHeadless } from "./infrastructure/control/node-control-headless-runner.js";
export type {
  NodeControlSignalSource,
  NodeControlHeadlessRunnerOptions,
} from "./infrastructure/control/node-control-headless-runner.js";
export { createNativeControlService } from "./composition/create-native-control-service.js";
export type {
  NativeControlExecutionOptions,
  NativePluginControlService,
} from "./application/native-control-service.js";
export { createNodeControlTimeoutPort } from "./infrastructure/node/node-control-timeout.js";
