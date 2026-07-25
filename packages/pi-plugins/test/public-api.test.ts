import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sourceApi from "../src/index.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  AdoptionCandidateIdSchema,
  AdoptionCandidateSchema,
  AdoptionDeclarationSchema,
  AdoptionDiscoveryResultSchema,
  AdoptionDocumentKindRegistry,
  AdoptionDocumentKindSchema,
  AdoptionDocumentStatusSchema,
  AdoptionImportOutcomeSchema,
  AdoptionImportResultSchema,
  AdoptionSelectionRequestSchema,
  CollectionReadResultSchema,
  ForeignStateFileObservationSchema,
  MarketplaceRegistrationRequestSchema,
  MarketplaceRegistrationResultSchema,
  createAdoptionService,
  createNodeAdoptionService,
  deriveAdoptionCandidateId,
  reconcileAdoptionDeclarations,
  BoundaryError,
  BundleDocumentLimits,
  BundleDocumentLimitsSchema,
  BundleInspectionInputSchema,
  BundleInspectionResultSchema,
  CanonicalSourceSchema,
  ComponentIdVersionRegistry,
  ComponentLogicalIdentitySchema,
  ComponentLocatorAuthorityRegistry,
  ComponentLocatorAuthoritySchema,
  ComponentLocatorClaimSchema,
  ComponentLocatorSourceRegistry,
  ComponentLocatorSourceSchema,
  ComponentLocatorTargetSchema,
  ContentDigestSchema,
  ContentManifestEntrySchema,
  ContentManifestSchema,
  ContentStoreIdentitySchema,
  ContentStoreKeySchema,
  ContentStoreKindRegistry,
  MarketplaceStoreIdentitySchema,
  PluginStoreIdentitySchema,
  createCompatibilityService,
  createMcpRuntimeCapabilityProbe,
  createContentIndex,
  createNodePluginInspector,
  createPluginInspectionService,
  reconcilePluginBundle,
  DEFAULT_MATERIALIZATION_LIMITS,
  ClaimConflictError,
  ClaimedSchema,
  CompatibilityEvaluationInputSchema,
  CompatibilityPolicyRegistry,
  CompatibilityPolicyRuleRegistry,
  CompatibilityPolicyRuleSchema,
  CompatibilityPolicyRulesSchema,
  CompatibilityReportSchema,
  ComponentAssessmentSchema,
  ComponentIdSchema,
  ComponentKindRegistry,
  ComponentSchema,
  ComponentVerdictRegistry,
  ComponentVerdictSchema,
  ConfigurationOptionSchema,
  ConfigurationValueKindRegistry,
  ConfigurationValueSchema,
  DiagnosticSchema,
  DomainContractError,
  ErrorCodeRegistry,
  ErrorCodeSchema,
  FatalBoundaryCodeSchema,
  ForeignComponentDeclarationSchema,
  ForeignComponentSchema,
  GitRevisionSchema,
  HookComponentSchema,
  HookEventSchema,
  HookHandlerSchema,
  HookHandlerVariantRegistry,
  JsonValueSchema,
  MCPFeatureSchema,
  MCPTransportSchema,
  MarketplaceAvailabilityRegistry,
  MarketplaceAvailabilitySchema,
  MarketplaceAuthoritySchema,
  MarketplaceDeclarationCategoryRegistry,
  MarketplaceEntryDeclarationSchema,
  MarketplaceInstallationPolicySchema,
  MarketplaceNameSchema,
  MarketplaceReadResultSchema,
  MarketplaceUpdatePreferenceResultSchema,
  MarketplaceSourceSchema,
  MarketplaceSourceVariantRegistry,
  McpServerComponentSchema,
  NativeHostSchema,
  NormalizedMarketplaceEntrySchema,
  NormalizedMarketplaceSchema,
  NormalizedPluginSchema,
  NpmIntegritySchema,
  PluginComponentsSchema,
  PluginConfigurationSchema,
  PluginIdentitySchema,
  PluginKeySchema,
  PluginManifestClaimsSchema,
  PluginNameSchema,
  PluginSourceSchema,
  PluginSourceVariantRegistry,
  ProvenanceSchema,
  ReadResultSchema,
  ResolvedMarketplaceSourceSchema,
  ResolvedPluginSourceSchema,
  ResolvedPluginSourceVariantRegistry,
  RetainedMetadataSchema,
  McpBridgeTransportSchema,
  McpCanonicalTransportSchema,
  McpCanonicalAuthSchema,
  McpCanonicalOptionsSchemaV1,
  McpCompatibilityPlanSchemaV1,
  analyzeMcpCompatibility,
  McpConfigSourceSchemaV1,
  McpSourceRegistrationSchemaV1,
  McpSourcePreconditionSchemaV1,
  McpRuntimeServerBindingSchemaV1,
  McpLaunchValueRequestSchema,
  McpRuntimeCapabilitiesSchemaV1,
  McpRuntimeServerKeySchemaV1,
  McpToolAliasSegmentSchema,
  McpToolAliasTemplateSchemaV1,
  McpSourceIdentitySchemaV1,
  McpSourceProjectionBindingSchemaV1,
  McpSourceRemoveResultSchema,
  McpSourceReplaceResultSchema,
  McpSourceServerSchemaV1,
  McpSourceServerStatusSchema,
  McpSourceStatusSchema,
  McpSourceValidationResultSchema,
  PluginMcpLaunchTemplateSchemaV1,
  PluginMcpAliasOmissionCodeSchema,
  PluginMcpAliasOmissionSchema,
  PluginMcpProjectionSchemaV1,
  deriveMcpRuntimeServerKey,
  createPluginMcpProjection,
  verifyPluginMcpProjection,
  createMcpSourceRegistration,
  verifyMcpSourceRegistration,
  RuntimeCapabilityAvailabilitySchema,
  RuntimeCapabilityIdSchema,
  RuntimeCapabilityRegistry,
  RuntimeCapabilityRegistrySchema,
  RuntimeCapabilitySnapshotSchema,
  RuntimeCapabilityStatusRegistry,
  RuntimeCapabilityStatusSchema,
  RuntimeRequirementAssessmentSchema,
  RuntimeRequirementIdSchema,
  RuntimeRequirementSchema,
  RuntimeRequirementStatusRegistry,
  RuntimeRequirementStatusSchema,
  SkillComponentSchema,
  SourceDocumentKindSchema,
  SourceHashSchema,
  SourceLocationSchema,
  assertVerifiedPromotionPlan,
  contentStoreKeyDigest,
  contentStoreKeySchema,
  createCompatibilityReport,
  deriveComponentId,
  createContentManifest,
  createMarketplaceStoreIdentity,
  createMarketplaceStoreIdentityFromEvidence,
  createMarketplaceUpdatePolicyService,
  createNodeMarketplaceRefreshServices,
  createNodeMarketplaceUpdateServices,
  createNodeContentStore,
  createNodeSourceMaterializers,
  createPluginIdentity,
  createPluginStoreIdentity,
  createPluginStoreIdentityFromEvidence,
  createPromotionPlan,
  createSourceMaterializers,
  createResolvedMarketplaceSource,
  createResolvedPluginSource,
  deriveActivatable,
  diagnosticFromZodError,
  evaluateCompatibility,
  flattenComponents,
  verifyComponentId,
  formatPluginKey,
  hashCanonicalSource,
  hashContent,
  mergeEquivalentClaims,
  SourceMaterializationError,
  verifyContentManifest,
  verifyContentStoreIdentity,
  verifyResolvedMarketplaceSource,
  verifyResolvedPluginSource,
  nonEmptyReadonly,
  parsePluginKey,
  schemaValues,
  serializeMarketplaceSource,
  serializePluginSource,
  claim,
  ActivationIntentSchema,
  CanonicalProjectRootSchema,
  DEFAULT_HOST_PRECEDENCE,
  GenerationSchema,
  HostConfigDocumentSchema,
  HostPrecedenceSchema,
  hostRank,
  ImmutableRevisionEvidenceSchema,
  InstalledPluginRecordSchema,
  InstalledRevisionRecordSchema,
  InstalledUserStateDocumentSchema,
  MarketplaceConfigurationRecordSchema,
  MarketplaceContentRefSchema,
  MarketplaceSnapshotRecordSchema,
  PendingTransitionRefSchema,
  ProjectionRootRefSchema,
  PluginConfigurationRefSchema,
  PluginContentRefSchema,
  PluginDataRefSchema,
  PointerDocumentKindSchema,
  PortableMarketplaceDeclarationSchema,
  PortableMarketplaceSourceSchema,
  PortablePluginConstraintSchema,
  PortablePluginDeclarationSchema,
  PortablePluginSourceSchema,
  PortableProjectDeclarationSchema,
  ProjectIdentitySchema,
  ProjectKeySchema,
  ProjectLocalStateDocumentSchema,
  ProjectStateMutationInputSchema,
  ProjectStateMutationSchema,
  ReferenceIdentitySchema,
  ScopeContextSchema,
  ScopeReferenceSchema,
  StateBlobRefSchema,
  StateCodecError,
  StateVersionCutoverError,
  StateCorruptionCodeSchema,
  StateCorruptionSchema,
  StateDocumentKindRegistry,
  StateDocumentKindSchema,
  StateDocumentPointerSchema,
  StateDocumentRegistry,
  StateLoadFailureSchema,
  StateMutationInputSchema,
  StateMutationSchema,
  StatePointersDocumentSchema,
  StateReferenceKindRegistry,
  StateReferenceSchema,
  TrustDecisionStatusSchema,
  TrustStateDocumentSchema,
  TrustStateRecordSchema,
  TrustSubjectEvidenceSchema,
  TrustSubjectRefSchema,
  UpdateApplicationPreferenceSchema,
  UserStateMutationInputSchema,
  UserStateMutationSchema,
  assertPortableProjectDeclarationSafe,
  createInstalledPluginRecord,
  createInstalledRevisionRecord,
  createInstalledUserStateDocument,
  createMarketplaceSnapshotRecord,
  createProjectLocalStateDocument,
  createScopeContext,
  createStatePointersDocument,
  createTrustStateDocument,
  createTrustStateRecord,
  decodeInstalledPluginRecords,
  decodeInstalledUserPlugins,
  decodePortableProjectDeclaration,
  decodeProjectPlugins,
  decodeStateDocument,
  deriveMarketplaceContentRef,
  derivePendingTransitionRef,
  derivePluginConfigurationRef,
  deriveProjectionRootRef,
  deriveStablePluginDataRef,
  derivePluginContentRef,
  derivePluginDataRef,
  deriveProjectKey,
  deriveStateBlobRef,
  deriveTrustSubject,
  deriveTrustSubjectRef,
  encodeStateDocument,
  getStateDocumentDefinition,
  hashStateDocument,
  isSafePortableRelativePath,
  parsePortableProjectDeclaration,
  isVerifiedStateMutation,
  MutationSubjectSchema,
  createKeyedMutationScheduler,
  CommittedMutationCleanupError,
  MutationCleanupError,
  createGenerationMutationCoordinator,
  createLifecycleRecoveryService,
  createLifecycleTransitionReconciler,
  parseStateMutation,
  stateDocumentKinds,
  toScopeReference,
  validateStateMutation,
  verifyMarketplaceContentRef,
  verifyPendingTransitionRef,
  verifyPluginConfigurationRef,
  verifyPluginContentRef,
  verifyPluginDataRef,
  verifyProjectionRootRef,
  verifyStateBlobRef,
  verifyStatePointersScope,
  verifyTrustStateRecord,
  verifyTrustSubjectRef,
  type AgentSkillReader,
  type LifecycleStateStore,
  type LifecycleStateInventoryPort,
  type RecoveryArtifactsPort,
  type LifecycleTransitionReconciler,
  type LifecycleTransitionReconcilerDependencies,
  type LifecycleRecoveryServiceDependencies,
  type ScopeLockLease,
  type ScopeLockManager,
  type KeyedMutationScheduler,
  type MutationSubject,
  type GenerationMutationCoordinator,
  type GenerationMutationCoordinatorDependencies,
  type GenerationMutationResult,
  type PreparedMutation,
  type PreparedMutationContext,
  type PreparedMutationRequest,
  type Generation,
  type GenerationSnapshot,
  type ScopeContext,
  type HostConfigDocument,
  type InstalledUserStateDocument,
  type ProjectLocalStateDocument,
  type PortableProjectDeclaration,
  type StateDocumentByKind,
  type UserStateMutationInput,
  type ProjectStateMutationInput,
  type StateMutationInput,
  type UnverifiedStateMutation,
  type VerifiedStateMutation,
  type StateMutation,
  type StateCommitResult,
  type StateLoadResult,
  type StatePointersDocument,
  type TrustStateDocument,
  type UserGenerationSnapshot,
  type ProjectGenerationSnapshot,
  type BundleDocumentLimitsContract,
  type BundleInspectionInput,
  type BundleInspectionResult,
  type BundleReaderSet,
  type CompatibilityAssessmentRequest,
  type CompatibilityService,
  type PluginInspectionDependencies,
  type PluginInspectionService,
  type BundleReconciliationInput,
  type CompatibilityEvaluationInput,
  type CompatibilityPolicyDisposition,
  type CompatibilityPolicyRegistryType,
  type CompatibilityPolicyRule,
  type CompatibilityPolicySurface,
  type CompatibilityReport,
  type ComponentLocatorClaim,
  type ComponentLogicalIdentity,
  type ContentIndex,
  type ContentReadPort,
  type ContentDigest,
  type ContentManifest,
  type ContentStoreIdentity,
  type ContentManifestEntry,
  type Component,
  type ComponentAssessment,
  type ComponentId,
  type ComponentVerdict,
  type ConfigurationOption,
  type ConfigurationValue,
  type Diagnostic,
  type DomainContractError as DomainContractErrorType,
  type ErrorCode,
  type FatalBoundaryCode,
  type ForeignComponent,
  type ForeignComponentDeclaration,
  type GitRevision,
  type HookComponent,
  type HookHandler,
  type JsonValue,
  type MarketplaceAuthority,
  type MarketplaceAvailability,
  type MarketplaceEntryDeclaration,
  type MarketplaceInstallationPolicy,
  type MarketplaceName,
  type MarketplaceReadResult,
  type MarketplaceUpdatePolicyService,
  type NodeMarketplaceRefreshServices,
  type NodeMarketplaceRefreshServicesOptions,
  type NodeMarketplaceUpdateServices,
  type NodeMarketplaceUpdateServicesOptions,
  type MarketplaceSource,
  type McpServerComponent,
  type NativeHost,
  type NormalizedMarketplace,
  type NormalizedMarketplaceEntry,
  type NormalizedPlugin,
  type NpmIntegrity,
  type PluginComponents,
  type PluginConfiguration,
  type PluginIdentity,
  type PluginKey,
  type PluginManifestClaims,
  type PluginName,
  type PluginSource,
  type Provenance,
  type ReadResult,
  type ResolvedMarketplaceSource,
  type ResolvedPluginSource,
  type RetainedMetadata,
  type McpBridgeTransport,
  type McpCanonicalTransport,
  type McpCanonicalAuth,
  type McpCanonicalOptions,
  type McpCompatibilityPlan,
  type McpCompatibilityAnalysis,
  type McpConfigSource,
  type McpSourceRegistration,
  type McpSourcePrecondition,
  type McpRuntimeServerBinding,
  type McpRuntimeLeaseProvider,
  type McpLaunchValueProvider,
  type McpLaunchValueRequest,
  type McpLaunchValues,
  type McpRuntimeCapabilities,
  type McpRuntimePort,
  type McpRuntimeServerKey,
  type McpToolAliasSegment,
  type McpToolAliasTemplate,
  type McpSourceIdentity,
  type McpSourceProjectionBinding,
  type McpSourceRemoveResult,
  type McpSourceReplaceRequest,
  type McpSourceReplaceResult,
  type McpSourceServer,
  type McpSourceServerStatus,
  type McpSourceStatus,
  type McpSourceValidationResult,
  type PluginMcpLaunchTemplate,
  type PluginMcpAliasOmissionCode,
  type PluginMcpAliasOmission,
  type PluginMcpProjection,
  type RuntimeCapabilityAvailability,
  type RuntimeCapabilityId,
  type RuntimeCapabilityProbe,
  type RuntimeCapabilitySnapshot,
  type RuntimeRequirement,
  type RuntimeRequirementAssessment,
  type RuntimeRequirementId,
  type RuntimeRequirementStatus,
  type SkillComponent,
  type HookDocumentReader,
  type McpDocumentReader,
  type PluginManifestReader,
  type Sha256,
  type SourceContext,
  type SourceMaterializationDependencies,
  type StagingSlot,
  type ContentStorePort,
  type PromotionResult,
  type SourceDocumentKind,
  type SourceHash,
  type SourceLocation,
  type Claimed,
  type CollectionReadResult,
} from "../src/index.js";

describe("explicit package API", () => {
  it("preserves exact update and refresh composition contracts", () => {
    expectTypeOf<NodeMarketplaceRefreshServices>()
      .toEqualTypeOf<NodeMarketplaceUpdateServices>();
    expectTypeOf<NodeMarketplaceRefreshServicesOptions>()
      .toEqualTypeOf<NodeMarketplaceUpdateServicesOptions>();
    expectTypeOf(createNodeMarketplaceRefreshServices)
      .toEqualTypeOf(createNodeMarketplaceUpdateServices);
  });

  it("keeps the source barrel on the compiled package allowlist", () => {
    const compiledTest = readFileSync(resolve(process.cwd(), "test/compiled-package-import.mjs"), "utf8");
    const start = compiledTest.indexOf("const expectedExports = [");
    const end = compiledTest.indexOf("].sort();", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const expected = [...compiledTest.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    expect(Object.keys(sourceApi).sort()).toEqual(expected);
  });

  it("exposes the complete intended domain contract without adapters", () => {
    const symbols = [
      AdoptionCandidateIdSchema,
      AdoptionCandidateSchema,
      AdoptionDeclarationSchema,
      AdoptionDiscoveryResultSchema,
      AdoptionDocumentKindRegistry,
      AdoptionDocumentKindSchema,
      AdoptionDocumentStatusSchema,
      AdoptionImportOutcomeSchema,
      AdoptionImportResultSchema,
      AdoptionSelectionRequestSchema,
      CollectionReadResultSchema,
      ForeignStateFileObservationSchema,
      MarketplaceRegistrationRequestSchema,
      MarketplaceRegistrationResultSchema,
      createAdoptionService,
      createNodeAdoptionService,
      deriveAdoptionCandidateId,
      reconcileAdoptionDeclarations,
      BoundaryError,
      BundleDocumentLimits,
      BundleDocumentLimitsSchema,
      BundleInspectionInputSchema,
      BundleInspectionResultSchema,
      CanonicalSourceSchema,
      ComponentIdVersionRegistry,
      ComponentLogicalIdentitySchema,
      ComponentLocatorAuthorityRegistry,
      ComponentLocatorAuthoritySchema,
      ComponentLocatorClaimSchema,
      ComponentLocatorSourceRegistry,
      ComponentLocatorSourceSchema,
      ComponentLocatorTargetSchema,
      ContentDigestSchema,
      ContentManifestEntrySchema,
      ContentManifestSchema,
      ContentStoreIdentitySchema,
      ContentStoreKeySchema,
      ContentStoreKindRegistry,
      MarketplaceStoreIdentitySchema,
      PluginStoreIdentitySchema,
      createCompatibilityService,
      createMcpRuntimeCapabilityProbe,
      createContentIndex,
      createNodePluginInspector,
      createPluginInspectionService,
      reconcilePluginBundle,
      DEFAULT_MATERIALIZATION_LIMITS,
      ClaimConflictError,
      ClaimedSchema,
      CompatibilityEvaluationInputSchema,
      CompatibilityPolicyRegistry,
      CompatibilityPolicyRuleRegistry,
      CompatibilityPolicyRuleSchema,
      CompatibilityPolicyRulesSchema,
      CompatibilityReportSchema,
      ComponentAssessmentSchema,
      ComponentIdSchema,
      ComponentKindRegistry,
      ComponentSchema,
      ComponentVerdictRegistry,
      ComponentVerdictSchema,
      ConfigurationOptionSchema,
      ConfigurationValueKindRegistry,
      ConfigurationValueSchema,
      DiagnosticSchema,
      DomainContractError,
      ErrorCodeRegistry,
      ErrorCodeSchema,
      FatalBoundaryCodeSchema,
      ForeignComponentDeclarationSchema,
      ForeignComponentSchema,
      GitRevisionSchema,
      HookComponentSchema,
      HookEventSchema,
      HookHandlerSchema,
      HookHandlerVariantRegistry,
      MCPFeatureSchema,
      MCPTransportSchema,
      MarketplaceAvailabilityRegistry,
      MarketplaceAvailabilitySchema,
      MarketplaceAuthoritySchema,
      MarketplaceDeclarationCategoryRegistry,
      MarketplaceEntryDeclarationSchema,
      MarketplaceInstallationPolicySchema,
      MarketplaceNameSchema,
      MarketplaceReadResultSchema,
      MarketplaceUpdatePreferenceResultSchema,
      MarketplaceSourceSchema,
      MarketplaceSourceVariantRegistry,
      McpServerComponentSchema,
      NativeHostSchema,
      NormalizedMarketplaceEntrySchema,
      NormalizedMarketplaceSchema,
      NormalizedPluginSchema,
      NpmIntegritySchema,
      PluginComponentsSchema,
      PluginConfigurationSchema,
      PluginIdentitySchema,
      PluginKeySchema,
      PluginManifestClaimsSchema,
      PluginNameSchema,
      PluginSourceSchema,
      PluginSourceVariantRegistry,
      ProvenanceSchema,
      ReadResultSchema,
      ResolvedMarketplaceSourceSchema,
      ResolvedPluginSourceSchema,
      ResolvedPluginSourceVariantRegistry,
      RetainedMetadataSchema,
      McpBridgeTransportSchema,
      McpCanonicalTransportSchema,
      McpCanonicalAuthSchema,
      McpCanonicalOptionsSchemaV1,
      McpCompatibilityPlanSchemaV1,
      analyzeMcpCompatibility,
      McpConfigSourceSchemaV1,
      McpSourceRegistrationSchemaV1,
      McpSourcePreconditionSchemaV1,
      McpRuntimeServerBindingSchemaV1,
      McpLaunchValueRequestSchema,
      McpRuntimeCapabilitiesSchemaV1,
      McpRuntimeServerKeySchemaV1,
      McpToolAliasSegmentSchema,
      McpToolAliasTemplateSchemaV1,
      McpSourceIdentitySchemaV1,
      McpSourceProjectionBindingSchemaV1,
      McpSourceRemoveResultSchema,
      McpSourceReplaceResultSchema,
      McpSourceServerSchemaV1,
      McpSourceServerStatusSchema,
      McpSourceStatusSchema,
      McpSourceValidationResultSchema,
      PluginMcpLaunchTemplateSchemaV1,
      PluginMcpAliasOmissionCodeSchema,
      PluginMcpAliasOmissionSchema,
      PluginMcpProjectionSchemaV1,
      deriveMcpRuntimeServerKey,
      createPluginMcpProjection,
      verifyPluginMcpProjection,
      createMcpSourceRegistration,
      verifyMcpSourceRegistration,
      RuntimeCapabilityAvailabilitySchema,
      RuntimeCapabilityIdSchema,
      RuntimeCapabilityRegistry,
      RuntimeCapabilityRegistrySchema,
      RuntimeCapabilitySnapshotSchema,
      RuntimeCapabilityStatusRegistry,
      RuntimeCapabilityStatusSchema,
      RuntimeRequirementAssessmentSchema,
      RuntimeRequirementIdSchema,
      RuntimeRequirementSchema,
      RuntimeRequirementStatusRegistry,
      RuntimeRequirementStatusSchema,
      SkillComponentSchema,
      SourceDocumentKindSchema,
      SourceHashSchema,
      SourceLocationSchema,
      assertVerifiedPromotionPlan,
      contentStoreKeyDigest,
      contentStoreKeySchema,
      createCompatibilityReport,
      deriveComponentId,
      createContentManifest,
      createMarketplaceStoreIdentity,
      createMarketplaceStoreIdentityFromEvidence,
      createMarketplaceUpdatePolicyService,
      createNodeMarketplaceRefreshServices,
      createNodeMarketplaceUpdateServices,
      createNodeContentStore,
      createNodeSourceMaterializers,
      createPluginIdentity,
      createPluginStoreIdentity,
      createPluginStoreIdentityFromEvidence,
      createPromotionPlan,
      createSourceMaterializers,
      createResolvedMarketplaceSource,
      createResolvedPluginSource,
      deriveActivatable,
      diagnosticFromZodError,
      evaluateCompatibility,
      flattenComponents,
      verifyComponentId,
      formatPluginKey,
      hashCanonicalSource,
      hashContent,
      mergeEquivalentClaims,
      SourceMaterializationError,
      verifyContentManifest,
      verifyContentStoreIdentity,
      verifyResolvedMarketplaceSource,
      verifyResolvedPluginSource,
      nonEmptyReadonly,
      parsePluginKey,
      schemaValues,
      serializeMarketplaceSource,
      serializePluginSource,
      claim,
      ActivationIntentSchema,
      CanonicalProjectRootSchema,
      DEFAULT_HOST_PRECEDENCE,
      GenerationSchema,
      HostConfigDocumentSchema,
      HostPrecedenceSchema,
      hostRank,
      ImmutableRevisionEvidenceSchema,
      InstalledPluginRecordSchema,
      InstalledRevisionRecordSchema,
      InstalledUserStateDocumentSchema,
      MarketplaceConfigurationRecordSchema,
      MarketplaceContentRefSchema,
      MarketplaceSnapshotRecordSchema,
      PendingTransitionRefSchema,
      ProjectionRootRefSchema,
      PluginConfigurationRefSchema,
      PluginContentRefSchema,
      PluginDataRefSchema,
      PointerDocumentKindSchema,
      PortableMarketplaceDeclarationSchema,
      PortableMarketplaceSourceSchema,
      PortablePluginConstraintSchema,
      PortablePluginDeclarationSchema,
      PortablePluginSourceSchema,
      ProjectIdentitySchema,
      ProjectKeySchema,
      ProjectLocalStateDocumentSchema,
      ProjectStateMutationInputSchema,
      ProjectStateMutationSchema,
      ReferenceIdentitySchema,
      ScopeContextSchema,
      ScopeReferenceSchema,
      StateBlobRefSchema,
      StateCodecError,
  StateVersionCutoverError,
      StateCorruptionCodeSchema,
      StateCorruptionSchema,
      StateDocumentKindRegistry,
      StateDocumentKindSchema,
      StateDocumentPointerSchema,
      StateDocumentRegistry,
      StateLoadFailureSchema,
      MutationSubjectSchema,
      createKeyedMutationScheduler,
      CommittedMutationCleanupError,
      MutationCleanupError,
      createGenerationMutationCoordinator,
      createLifecycleRecoveryService,
      createLifecycleTransitionReconciler,
      StateMutationInputSchema,
      StateMutationSchema,
      StateReferenceKindRegistry,
      StateReferenceSchema,
      TrustDecisionStatusSchema,
      TrustStateRecordSchema,
      TrustSubjectEvidenceSchema,
      TrustSubjectRefSchema,
      UpdateApplicationPreferenceSchema,
      UserStateMutationInputSchema,
      UserStateMutationSchema,
      assertPortableProjectDeclarationSafe,
      createInstalledPluginRecord,
      createInstalledRevisionRecord,
      createInstalledUserStateDocument,
      createMarketplaceSnapshotRecord,
      createProjectLocalStateDocument,
      createScopeContext,
      createStatePointersDocument,
      createTrustStateDocument,
      createTrustStateRecord,
      decodeInstalledPluginRecords,
      decodeInstalledUserPlugins,
      decodePortableProjectDeclaration,
      decodeProjectPlugins,
      decodeStateDocument,
      deriveMarketplaceContentRef,
      derivePendingTransitionRef,
      derivePluginConfigurationRef,
      deriveProjectionRootRef,
      deriveStablePluginDataRef,
      derivePluginContentRef,
      derivePluginDataRef,
      deriveProjectKey,
      deriveStateBlobRef,
      deriveTrustSubject,
      deriveTrustSubjectRef,
      encodeStateDocument,
      getStateDocumentDefinition,
      hashStateDocument,
      isSafePortableRelativePath,
      parsePortableProjectDeclaration,
      isVerifiedStateMutation,
      parseStateMutation,
      stateDocumentKinds,
      toScopeReference,
      validateStateMutation,
      verifyMarketplaceContentRef,
      verifyPendingTransitionRef,
      verifyPluginConfigurationRef,
      verifyPluginContentRef,
      verifyPluginDataRef,
      verifyProjectionRootRef,
      verifyStateBlobRef,
      verifyStatePointersScope,
      verifyTrustStateRecord,
      verifyTrustSubjectRef,
    ];

    for (const symbol of symbols) {
      expect(symbol).toBeDefined();
    }
  });

  it("exposes one lifecycle facade and narrow evidence ports", () => {
    expect(sourceApi.createNativeInspectionService).toBeDefined();
    expect(sourceApi.NativeInspectionPageSchema).toBeDefined();
    expect(sourceApi.NativeInspectionDetailResultSchema).toBeDefined();
    expect(sourceApi.NativeDiagnosticRegistry).toBeDefined();
    expect(sourceApi.toSafeDisplayField).toBeDefined();
    expect(sourceApi.createNativeLifecycleOperationService).toBeDefined();
    expect(sourceApi.NativeLifecycleOperationRequestSchema).toBeDefined();
    expect(sourceApi.NativeLifecycleOperationResultSchema).toBeDefined();
    expect(sourceApi.createPluginLifecycleService).toBeDefined();
    expect(sourceApi.createLifecycleRecoveryService).toBe(createLifecycleRecoveryService);
    expect(sourceApi.createLifecycleTransitionReconciler).toBe(createLifecycleTransitionReconciler);
    expect(sourceApi.PluginRuntimeProjectionSchemaV1).toBeDefined();
    expect(sourceApi.LifecycleTransitionRecordSchemaV1).toBeDefined();
    expect(sourceApi.ActivationObservationSchema).toBeDefined();
    expect(sourceApi.LoadedInstalledPluginSchema).toBeDefined();
    expect(sourceApi).not.toHaveProperty("preparePluginCandidate");
    expect(sourceApi).not.toHaveProperty("runPreparedMutation");
    expect(sourceApi).not.toHaveProperty("activateSkill");
  });

  it("exposes one complete projection cache and two-participant runtime evidence boundary", () => {
    expect(sourceApi.RuntimeProjectionCacheEnvelopeSchemaV1).toBeDefined();
    expect(sourceApi.CurrentProjectRuntimeContextSchema).toBeDefined();
    expect(sourceApi.RuntimeContributionObservationSchema).toBeDefined();
    expect(sourceApi.SkillHookContributionObservationSchema).toBeDefined();
    expect(sourceApi.McpRegistrationObservationSchema).toBeDefined();
    expect(sourceApi.McpContributionObservationSchema).toBeDefined();
    expect(sourceApi.SkillHookSnapshotObservationSchema).toBeDefined();
    expect(sourceApi.SkillResourceContributionObservationSchema).toBeDefined();
    expect(sourceApi.composeSkillHookContributionObservation).toBeDefined();
    expect(sourceApi.createSkillResourceDiscoveryRuntime).toBeDefined();
    expect(sourceApi.composeActivationObservation).toBeDefined();
    expect(sourceApi.createSkillHookSnapshotLoader).toBeDefined();
    expect(sourceApi.createSkillHookRuntimeParticipant).toBeDefined();
    expect(sourceApi.McpLifecycleReconcileResultSchema).toBeDefined();
    expect(sourceApi.McpLifecycleObservationResultSchema).toBeDefined();
    expect(sourceApi.McpLifecycleStatusResultSchema).toBeDefined();
    expect(sourceApi.createMcpLifecycleParticipant).toBeDefined();
    expect(sourceApi.createMcpRevisionLeaseProvider).toBeDefined();
    expect(sourceApi).not.toHaveProperty("encodeRuntimeProjectionCache");
    expect(sourceApi).not.toHaveProperty("decodeRuntimeProjectionCache");
    expect(sourceApi).not.toHaveProperty("createRuntimeProjectionCache");
    expect(sourceApi).not.toHaveProperty("createSkillHookRuntimeCatalog");
    expect(sourceApi).not.toHaveProperty("createManifestSkillPathVerifier");
    expect(sourceApi).not.toHaveProperty("createMcpLifecycleStateStore");
    expect(sourceApi).not.toHaveProperty("createMcpLifecycleJournal");
    expect(sourceApi).not.toHaveProperty("registerSkillResourceDiscovery");
  });

  it("exposes only the portable subagent lifecycle contract and registration boundary", () => {
    expect(sourceApi.SubagentExecutionIdentitySchemaV1).toBeDefined();
    expect(sourceApi.SubagentExecutionPathSchemaV1).toBeDefined();
    expect(sourceApi.SubagentLifecycleCapabilitiesSchemaV1).toBeDefined();
    expect(sourceApi.SubagentLifecycleRegistrationEvidenceSchemaV1).toBeDefined();
    expect(sourceApi.createSubagentLifecycleCapabilityProbe).toBeDefined();
    expect(sourceApi.registerSubagentHookRuntime).toBeDefined();
    expect(sourceApi).not.toHaveProperty("FakeSubagentLifecycle");
    expect(sourceApi).not.toHaveProperty("defineSubagentLifecycleContract");
    expect(sourceApi).not.toHaveProperty("createSubagentHookCoordinator");
    expect(sourceApi).not.toHaveProperty("createPiSubagentsLifecyclePort");
  });

  it("exports portable trusted MCP launch contracts without a production capability claim", () => {
    expect(sourceApi.McpLaunchTemplateSchemaV1).toBeDefined();
    expect(sourceApi.McpLaunchBindingSchemaV1).toBeDefined();
    expect(sourceApi.McpSourceRegistrationSchemaV1).toBeDefined();
    expect(sourceApi.McpSourcePreconditionSchemaV1).toBeDefined();
    expect(sourceApi.McpRuntimeServerBindingSchemaV1).toBeDefined();
    expect(sourceApi.createMcpSourceRegistration).toBeDefined();
    expect(sourceApi.verifyMcpSourceRegistration).toBeDefined();
    expect(sourceApi.createMcpLaunchTemplate).toBeDefined();
    expect(sourceApi.createMcpLaunchContextPort).toBeDefined();
    expect(sourceApi.createTrustedMcpLaunchValueProvider).toBeDefined();
    expect(sourceApi.classifyMcpLaunchFailure).toBeDefined();
    expect(sourceApi).not.toHaveProperty("createProductionMcpRuntime");
    expect(sourceApi).not.toHaveProperty("FakeMcpRuntime");
    expect(sourceApi).not.toHaveProperty("FakeMcpLaunchEnvironment");
  });

  it("keeps secret custody and policy boundaries out of the public surface", () => {
    expect(sourceApi.SensitiveValue).toBeDefined();
    expect(sourceApi.withResolvedPluginConfiguration).toBeDefined();
    expect(sourceApi.savePluginConfiguration).toBeDefined();
    expect(sourceApi.authorizeTrustCandidate).toBeDefined();
    expect(sourceApi).not.toHaveProperty("withSensitiveValue");
    expect(sourceApi).not.toHaveProperty("validateConfigurationSubmission");
    expect(sourceApi).not.toHaveProperty("createResolvedConfiguration");
  });

  it("keeps public types inferred from the exported schemas", () => {
    expectTypeOf<BundleDocumentLimitsContract>().toEqualTypeOf<z.infer<typeof BundleDocumentLimitsSchema>>();
    expectTypeOf<PluginInspectionService>().toMatchTypeOf<{ inspect: Function }>();
    expectTypeOf<PluginInspectionDependencies>().toMatchTypeOf<{ sha256: Function }>();
    expectTypeOf<BundleReconciliationInput>().toMatchTypeOf<{ manifestClaims: readonly unknown[] }>();
    expectTypeOf<BundleInspectionInput>().toEqualTypeOf<z.infer<typeof BundleInspectionInputSchema>>();
    expectTypeOf<BundleInspectionResult>().toEqualTypeOf<z.infer<typeof BundleInspectionResultSchema>>();
    expectTypeOf<ComponentLocatorClaim>().toEqualTypeOf<z.infer<typeof ComponentLocatorClaimSchema>>();
    expectTypeOf<ForeignComponentDeclaration>().toEqualTypeOf<z.infer<typeof ForeignComponentDeclarationSchema>>();
    expectTypeOf<ContentDigest>().toEqualTypeOf<z.infer<typeof ContentDigestSchema>>();
    expectTypeOf<ContentManifestEntry>().toEqualTypeOf<z.infer<typeof ContentManifestEntrySchema>>();
    expectTypeOf<ContentManifest>().toEqualTypeOf<z.infer<typeof ContentManifestSchema>>();
    expectTypeOf<ContentStoreIdentity>().toEqualTypeOf<z.infer<typeof ContentStoreIdentitySchema>>();
    expectTypeOf<ContentStorePort>().toMatchTypeOf<{ promote: Function; allocateStaging: Function }>();
    expectTypeOf<PromotionResult>().toMatchTypeOf<{ kind: "promoted" | "already-present" }>();
    expectTypeOf<SourceContext>().toMatchTypeOf<{ kind: "external" } | { kind: "marketplace" }>();
    expectTypeOf<SourceMaterializationDependencies>().toMatchTypeOf<{ sha256: Sha256 }>();
    expectTypeOf<StagingSlot>().toMatchTypeOf<{ root: string }>();
    expectTypeOf<Component>().toMatchTypeOf<z.infer<typeof ComponentSchema>>();
    expectTypeOf<ComponentAssessment>().toEqualTypeOf<z.infer<typeof ComponentAssessmentSchema>>();
    expectTypeOf<CompatibilityReport>().toEqualTypeOf<z.infer<typeof CompatibilityReportSchema>>();
    expectTypeOf<CompatibilityEvaluationInput>().toEqualTypeOf<z.infer<typeof CompatibilityEvaluationInputSchema>>();
    expectTypeOf<CompatibilityAssessmentRequest>().toMatchTypeOf<{ plugin: NormalizedPlugin }>();
    expectTypeOf<CompatibilityService>().toMatchTypeOf<{ assess: Function }>();
    expectTypeOf<RuntimeCapabilityProbe>().toMatchTypeOf<{ snapshot: Function }>();
    expectTypeOf<McpBridgeTransport>().toEqualTypeOf<z.infer<typeof McpBridgeTransportSchema>>();
    expectTypeOf<McpCanonicalTransport>().toEqualTypeOf<z.infer<typeof McpCanonicalTransportSchema>>();
    expectTypeOf<McpCanonicalAuth>().toEqualTypeOf<z.infer<typeof McpCanonicalAuthSchema>>();
    expectTypeOf<McpCanonicalOptions>().toEqualTypeOf<z.infer<typeof McpCanonicalOptionsSchemaV1>>();
    expectTypeOf<McpCompatibilityPlan>().toEqualTypeOf<z.infer<typeof McpCompatibilityPlanSchemaV1>>();
    expectTypeOf<McpCompatibilityAnalysis>().toMatchTypeOf<{ kind: "supported" | "incompatible" }>();
    expectTypeOf<McpConfigSource>().toEqualTypeOf<z.infer<typeof McpConfigSourceSchemaV1>>();
    expectTypeOf<McpSourceRegistration>().toEqualTypeOf<z.infer<typeof McpSourceRegistrationSchemaV1>>();
    expectTypeOf<McpSourcePrecondition>().toEqualTypeOf<z.infer<typeof McpSourcePreconditionSchemaV1>>();
    expectTypeOf<McpRuntimeServerBinding>().toEqualTypeOf<z.infer<typeof McpRuntimeServerBindingSchemaV1>>();
    expectTypeOf<McpRuntimeCapabilities>().toEqualTypeOf<z.infer<typeof McpRuntimeCapabilitiesSchemaV1>>();
    expectTypeOf<McpRuntimeServerKey>().toEqualTypeOf<z.infer<typeof McpRuntimeServerKeySchemaV1>>();
    expectTypeOf<McpToolAliasSegment>().toEqualTypeOf<z.infer<typeof McpToolAliasSegmentSchema>>();
    expectTypeOf<McpToolAliasTemplate>().toEqualTypeOf<z.infer<typeof McpToolAliasTemplateSchemaV1>>();
    expectTypeOf<McpSourceIdentity>().toEqualTypeOf<z.infer<typeof McpSourceIdentitySchemaV1>>();
    expectTypeOf<McpSourceProjectionBinding>().toEqualTypeOf<z.infer<typeof McpSourceProjectionBindingSchemaV1>>();
    expectTypeOf<McpSourceServer>().toEqualTypeOf<z.infer<typeof McpSourceServerSchemaV1>>();
    expectTypeOf<McpSourceServerStatus>().toEqualTypeOf<z.infer<typeof McpSourceServerStatusSchema>>();
    expectTypeOf<McpSourceStatus>().toEqualTypeOf<z.infer<typeof McpSourceStatusSchema>>();
    expectTypeOf<McpSourceValidationResult>().toMatchTypeOf<{ ok: boolean }>();
    expectTypeOf<PluginMcpLaunchTemplate>().toEqualTypeOf<z.infer<typeof PluginMcpLaunchTemplateSchemaV1>>();
    expectTypeOf<PluginMcpAliasOmissionCode>().toEqualTypeOf<z.infer<typeof PluginMcpAliasOmissionCodeSchema>>();
    expectTypeOf<PluginMcpAliasOmission>().toEqualTypeOf<z.infer<typeof PluginMcpAliasOmissionSchema>>();
    expectTypeOf<PluginMcpProjection>().toEqualTypeOf<z.infer<typeof PluginMcpProjectionSchemaV1>>();
    expectTypeOf<McpSourceReplaceResult>().toMatchTypeOf<{ kind: "applied" | "stale" | "rejected" }>();
    expectTypeOf<McpSourceRemoveResult>().toMatchTypeOf<{ kind: "removed" | "absent" | "ownership-mismatch" }>();
    expectTypeOf<McpLaunchValueRequest>().toEqualTypeOf<z.infer<typeof McpLaunchValueRequestSchema>>();
    expectTypeOf<McpLaunchValues>().not.toEqualTypeOf<McpConfigSource>();
    expectTypeOf<McpLaunchValueProvider>().toMatchTypeOf<{ resolve: Function; dispose: Function }>();
    expectTypeOf<McpRuntimeLeaseProvider>().toMatchTypeOf<{ acquire: Function; release: Function; drain: Function }>();
    expectTypeOf<McpSourceReplaceRequest>().toMatchTypeOf<{
      registration: McpSourceRegistration;
      expected: McpSourcePrecondition;
      launchValues: McpLaunchValueProvider;
      runtimeLeases: McpRuntimeLeaseProvider;
    }>();
    expectTypeOf<McpRuntimePort>().toMatchTypeOf<{ capabilities: Function; replaceSource: Function }>();
    expectTypeOf<RuntimeCapabilityAvailability>().toEqualTypeOf<z.infer<typeof RuntimeCapabilityAvailabilitySchema>>();
    expectTypeOf<RuntimeCapabilityId>().toEqualTypeOf<z.infer<typeof RuntimeCapabilityIdSchema>>();
    expectTypeOf<RuntimeCapabilitySnapshot>().toEqualTypeOf<z.infer<typeof RuntimeCapabilitySnapshotSchema>>();
    expectTypeOf<CompatibilityPolicyRule>().toEqualTypeOf<z.infer<typeof CompatibilityPolicyRuleSchema>>();
    expectTypeOf<CompatibilityPolicyDisposition>().toEqualTypeOf<z.infer<typeof CompatibilityPolicyRuleSchema>["disposition"]>();
    expectTypeOf<CompatibilityPolicySurface>().toEqualTypeOf<z.infer<typeof CompatibilityPolicyRuleSchema>["surface"]>();
    expectTypeOf<CompatibilityPolicyRegistryType>().toEqualTypeOf<typeof import("../src/index.js").CompatibilityPolicyRegistry>();
    expectTypeOf<ConfigurationOption>().toEqualTypeOf<z.infer<typeof ConfigurationOptionSchema>>();
    expectTypeOf<ConfigurationValue>().toEqualTypeOf<z.infer<typeof ConfigurationValueSchema>>();
    expectTypeOf<Diagnostic>().toEqualTypeOf<z.infer<typeof DiagnosticSchema>>();
    expectTypeOf<DomainContractErrorType>().toMatchTypeOf<DomainContractError>();
    expectTypeOf<ErrorCode>().toEqualTypeOf<z.infer<typeof ErrorCodeSchema>>();
    expectTypeOf<FatalBoundaryCode>().toEqualTypeOf<z.infer<typeof FatalBoundaryCodeSchema>>();
    expectTypeOf<ForeignComponent>().toEqualTypeOf<z.infer<typeof ForeignComponentSchema>>();
    expectTypeOf<GitRevision>().toEqualTypeOf<z.infer<typeof GitRevisionSchema>>();
    expectTypeOf<HookComponent>().toEqualTypeOf<z.infer<typeof HookComponentSchema>>();
    expectTypeOf<HookHandler>().toEqualTypeOf<z.infer<typeof HookHandlerSchema>>();
    expectTypeOf<JsonValue>().toEqualTypeOf<z.infer<typeof JsonValueSchema>>();
    expectTypeOf<MarketplaceAuthority>().toEqualTypeOf<z.infer<typeof MarketplaceAuthoritySchema>>();
    expectTypeOf<MarketplaceAvailability>().toEqualTypeOf<z.infer<typeof MarketplaceAvailabilitySchema>>();
    expectTypeOf<MarketplaceEntryDeclaration>().toEqualTypeOf<z.infer<typeof MarketplaceEntryDeclarationSchema>>();
    expectTypeOf<MarketplaceInstallationPolicy>().toEqualTypeOf<z.infer<typeof MarketplaceInstallationPolicySchema>>();
    expectTypeOf<MarketplaceName>().toEqualTypeOf<z.infer<typeof MarketplaceNameSchema>>();
    expectTypeOf<MarketplaceReadResult>().toEqualTypeOf<z.infer<typeof MarketplaceReadResultSchema>>();
    expectTypeOf<MarketplaceUpdatePolicyService>().toMatchTypeOf<{ setApplicationPreference: Function }>();
    expectTypeOf<MarketplaceSource>().toEqualTypeOf<z.infer<typeof MarketplaceSourceSchema>>();
    expectTypeOf<McpServerComponent>().toEqualTypeOf<z.infer<typeof McpServerComponentSchema>>();
    expectTypeOf<NativeHost>().toEqualTypeOf<z.infer<typeof NativeHostSchema>>();
    expectTypeOf<NormalizedMarketplace>().toEqualTypeOf<z.infer<typeof NormalizedMarketplaceSchema>>();
    expectTypeOf<NormalizedMarketplaceEntry>().toEqualTypeOf<z.infer<typeof NormalizedMarketplaceEntrySchema>>();
    expectTypeOf<NormalizedPlugin>().toEqualTypeOf<z.infer<typeof NormalizedPluginSchema>>();
    expectTypeOf<NpmIntegrity>().toEqualTypeOf<z.infer<typeof NpmIntegritySchema>>();
    expectTypeOf<PluginComponents>().toEqualTypeOf<z.infer<typeof PluginComponentsSchema>>();
    expectTypeOf<PluginConfiguration>().toEqualTypeOf<z.infer<typeof PluginConfigurationSchema>>();
    expectTypeOf<PluginIdentity>().toEqualTypeOf<z.infer<typeof PluginIdentitySchema>>();
    expectTypeOf<PluginKey>().toEqualTypeOf<z.infer<typeof PluginKeySchema>>();
    expectTypeOf<PluginName>().toEqualTypeOf<z.infer<typeof PluginNameSchema>>();
    expectTypeOf<PluginSource>().toEqualTypeOf<z.infer<typeof PluginSourceSchema>>();
    expectTypeOf<Provenance>().toEqualTypeOf<z.infer<typeof ProvenanceSchema>>();
    expectTypeOf<ReadResult<unknown>>().toMatchTypeOf<ReadResult<unknown>>();
    expectTypeOf<ResolvedMarketplaceSource>().toEqualTypeOf<z.infer<typeof ResolvedMarketplaceSourceSchema>>();
    expectTypeOf<ResolvedPluginSource>().toEqualTypeOf<z.infer<typeof ResolvedPluginSourceSchema>>();
    expectTypeOf<RetainedMetadata>().toEqualTypeOf<z.infer<typeof RetainedMetadataSchema>>();
    expectTypeOf<RuntimeRequirement>().toEqualTypeOf<z.infer<typeof RuntimeRequirementSchema>>();
    expectTypeOf<RuntimeRequirementAssessment>().toEqualTypeOf<z.infer<typeof RuntimeRequirementAssessmentSchema>>();
    expectTypeOf<RuntimeRequirementId>().toEqualTypeOf<z.infer<typeof RuntimeRequirementIdSchema>>();
    expectTypeOf<RuntimeRequirementStatus>().toEqualTypeOf<z.infer<typeof RuntimeRequirementStatusSchema>>();
    expectTypeOf<SkillComponent>().toEqualTypeOf<z.infer<typeof SkillComponentSchema>>();
    expectTypeOf<SourceDocumentKind>().toEqualTypeOf<z.infer<typeof SourceDocumentKindSchema>>();
    expectTypeOf<SourceHash>().toEqualTypeOf<z.infer<typeof SourceHashSchema>>();
    expectTypeOf<SourceLocation>().toEqualTypeOf<z.infer<typeof SourceLocationSchema>>();
    expectTypeOf<ComponentId>().toEqualTypeOf<z.infer<typeof ComponentIdSchema>>();
    expectTypeOf<Claimed<string>>().toMatchTypeOf<{ value: string }>();
    expectTypeOf<CollectionReadResult<unknown>>().toMatchTypeOf<{ items: readonly unknown[] }>();
    expectTypeOf<Sha256>().toBeFunction();
    expectTypeOf<HostConfigDocument>().toEqualTypeOf<z.infer<typeof HostConfigDocumentSchema>>();
    expectTypeOf<InstalledUserStateDocument>().toEqualTypeOf<z.infer<typeof InstalledUserStateDocumentSchema>>();
    expectTypeOf<ProjectLocalStateDocument>().toEqualTypeOf<z.infer<typeof ProjectLocalStateDocumentSchema>>();
    expectTypeOf<PortableProjectDeclaration>().toEqualTypeOf<z.infer<typeof PortableProjectDeclarationSchema>>();
    expectTypeOf<StatePointersDocument>().toEqualTypeOf<z.infer<typeof StatePointersDocumentSchema>>();
    expectTypeOf<TrustStateDocument>().toEqualTypeOf<z.infer<typeof TrustStateDocumentSchema>>();
    expectTypeOf<StateDocumentByKind<"hostConfig">>().toEqualTypeOf<HostConfigDocument>();
    expectTypeOf<UnverifiedStateMutation>().toEqualTypeOf<z.infer<typeof StateMutationInputSchema>>();
    expectTypeOf<StateMutationInput>().toEqualTypeOf<UnverifiedStateMutation>();
    expectTypeOf<StateMutation>().toEqualTypeOf<VerifiedStateMutation>();
    expectTypeOf<UnverifiedStateMutation>().not.toMatchTypeOf<StateMutation>();
    expectTypeOf<StateCommitResult>().toMatchTypeOf<{ kind: "committed" | "stale-generation" }>();
    expectTypeOf<StateLoadResult>().toMatchTypeOf<{ ok: boolean }>();
    expectTypeOf<UserGenerationSnapshot>().toMatchTypeOf<{ generation: Generation }>();
    expectTypeOf<ProjectGenerationSnapshot>().toMatchTypeOf<{ generation: Generation }>();
    expectTypeOf<LifecycleStateStore>().toMatchTypeOf<{ read: Function; commit: Function }>();
    expectTypeOf<LifecycleStateInventoryPort>().toMatchTypeOf<{ discover: Function }>();
    expectTypeOf<RecoveryArtifactsPort>().toMatchTypeOf<{ scan: Function; remove: Function }>();
    expectTypeOf<LifecycleTransitionReconciler>().toMatchTypeOf<{ completeCommittedTransition: Function; recoverInterruptedTransition: Function }>();
    expectTypeOf<LifecycleTransitionReconcilerDependencies>().toMatchTypeOf<{
      mutations: { runPreparedMutation: Function };
      state: { read: Function };
      reload: { reload: Function; observe: Function };
      transitions: { prepare: Function; settle: Function };
      sha256: Function;
    }>();
    expectTypeOf<LifecycleRecoveryServiceDependencies["reconciler"]>().toEqualTypeOf<LifecycleTransitionReconciler>();
    expectTypeOf<ScopeLockLease>().toMatchTypeOf<{ assertOwned: Function; release: Function }>();
    expectTypeOf<ScopeLockManager>().toMatchTypeOf<{ acquire: Function }>();
    expectTypeOf<KeyedMutationScheduler>().toMatchTypeOf<{ run: Function }>();
    expectTypeOf<MutationSubject>().toEqualTypeOf<z.infer<typeof MutationSubjectSchema>>();
    expectTypeOf<GenerationMutationCoordinator>().toMatchTypeOf<{ runPreparedMutation: Function }>();
    expectTypeOf<GenerationMutationCoordinatorDependencies>().toMatchTypeOf<{ scheduler: KeyedMutationScheduler }>();
    expectTypeOf<GenerationMutationResult<unknown>>().toMatchTypeOf<{ kind: "committed" | "stale-generation" | "commit-failed" | "commit-ambiguous" }>();
    expectTypeOf<PreparedMutation<unknown>>().toMatchTypeOf<{ mutation: VerifiedStateMutation }>();
    expectTypeOf<PreparedMutationContext>().toMatchTypeOf<{ snapshot: GenerationSnapshot; assertOwned: Function }>();
    expectTypeOf<PreparedMutationRequest>().toMatchTypeOf<{ scope: ScopeContext; expectedGeneration: Generation }>();
  });
});
