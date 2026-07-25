import {
  BoundaryError,
  ErrorCodeRegistry,
} from "../domain/errors.js";
import {
  evaluateTrust,
  verifyTrustCandidate,
  type TrustCandidate,
  type TrustDecision,
} from "../domain/trust-policy.js";
import type { ProjectTrustPort } from "./ports/project-trust.js";
import type { Sha256 } from "../domain/source.js";
import {
  createScopeContext,
  type ProjectKey,
  type ScopeContext,
  type ScopeReference,
} from "../domain/state/scope.js";
import type { TrustStateRecord } from "../domain/state/trust-state.js";
import { ProjectTrustAssessmentSchema } from "./ports/project-trust.js";
import { isAbortRejection } from "./abort-rejection.js";

export type TrustAuthorizationResult =
  | Readonly<{ kind: "authorized"; subject: TrustCandidate["subject"] }>
  | Readonly<{
      kind: "denied";
      code: "PROJECT_UNTRUSTED" | "TRUST_ABSENT" | "TRUST_REVOKED" | "TRUST_EVIDENCE_INVALID";
    }>;

function adapterFailure(): BoundaryError {
  // Deliberately omit the native cause. Credential/project adapters may put
  // sensitive paths or account material in their errors.
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation: "assessProjectTrust",
    message: "project trust assessment failed",
  });
}

function projectScope(scope: ScopeReference): ProjectKey | undefined {
  return scope.kind === "project" ? scope.projectKey : undefined;
}

function mapDecision(decision: TrustDecision): TrustAuthorizationResult {
  if (decision.kind === "authorized") return decision;
  switch (decision.reason) {
    case "ABSENT": return { kind: "denied", code: "TRUST_ABSENT" };
    case "REVOKED": return { kind: "denied", code: "TRUST_REVOKED" };
    case "EVIDENCE_MISMATCH": return { kind: "denied", code: "TRUST_EVIDENCE_INVALID" };
    default: return assertNever(decision.reason);
  }
}

/**
 * Check project trust before plugin trust. User-scope candidates intentionally
 * never call the project port, preserving the separate trust boundary.
 */
export async function authorizeTrustCandidate(
  request: Readonly<{
    candidate: TrustCandidate;
    records: readonly TrustStateRecord[];
    /** Optional runtime provenance for callers that have a full project context. */
    scope?: ScopeContext;
  }>,
  dependencies: Readonly<{
    projectTrust: ProjectTrustPort;
    sha256: Sha256;
  }>,
  signal: AbortSignal,
): Promise<TrustAuthorizationResult> {
  signal.throwIfAborted();

  let candidate: TrustCandidate;
  try {
    candidate = verifyTrustCandidate(request.candidate, dependencies.sha256);
  } catch {
    return { kind: "denied", code: "TRUST_EVIDENCE_INVALID" };
  }

  const projectKey = projectScope(candidate.evidence.scope);
  if (projectKey !== undefined) {
    let assessment: Awaited<ReturnType<ProjectTrustPort["assess"]>>;
    try {
      assessment = ProjectTrustAssessmentSchema.parse(await dependencies.projectTrust.assess(projectKey, signal));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (isAbortRejection(error)) throw error;
      throw adapterFailure();
    }
    signal.throwIfAborted();
    if (request.scope !== undefined) {
      let verifiedScope: ScopeContext;
      try {
        verifiedScope = createScopeContext(request.scope, dependencies.sha256);
      } catch {
        return { kind: "denied", code: "TRUST_EVIDENCE_INVALID" };
      }
      if (verifiedScope.kind !== "project" || verifiedScope.projectKey !== projectKey) {
        return { kind: "denied", code: "TRUST_EVIDENCE_INVALID" };
      }
    }
    if (assessment.kind !== "trusted") {
      return { kind: "denied", code: "PROJECT_UNTRUSTED" };
    }
  }

  return mapDecision(evaluateTrust(candidate, request.records, dependencies.sha256));
}

function assertNever(value: never): never {
  throw new Error(`unhandled trust decision: ${String(value)}`);
}
