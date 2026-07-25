/**
 * Shared prepared candidate seam used by trusted install and manual update.
 * Trusted-install names remain source-compatible aliases; there is one
 * acquisition/materialization/inspection implementation.
 */
export {
  createTrustedInstallCandidateService as createPreparedLifecycleCandidateService,
  acquireTrustedInstallCandidate as acquirePreparedLifecycleCandidate,
} from "./trusted-install-candidate.js";
export type {
  TrustedInstallCandidate as PreparedLifecycleCandidate,
  TrustedInstallCandidateDependencies as PreparedLifecycleCandidateDependencies,
  TrustedInstallCandidateService as PreparedLifecycleCandidateService,
  TrustedInstallCandidateResult as PreparedLifecycleCandidateResult,
} from "./trusted-install-candidate.js";
