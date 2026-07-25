import { compareUtf8 } from "../domain/canonical-json.js";
import { PluginKeySchema } from "../domain/identity.js";
import { createTrustStateDocument, type TrustStateRecord } from "../domain/state/trust-state.js";
import { createScopeContext, toScopeReference, type ScopeContext } from "../domain/state/scope.js";
import { grantTrust, verifyTrustCandidate, type TrustCandidate } from "../domain/trust-policy.js";
import { parseStateMutation } from "./state-contract.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import { CommittedMutationCleanupError } from "./generation-mutation-coordinator.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { ProjectRootAuthorityPort, TrustedProjectRoot } from "./ports/project-root-authority.js";
import { ProjectTrustAssessmentSchema, type ProjectTrustPort } from "./ports/project-trust.js";
import type { Sha256 } from "../domain/source.js";
import type { Generation } from "../domain/state/config-state.js";
import type { TrustSubjectRef } from "../domain/state/references.js";

export type ExactTrustGrantResult =
  | Readonly<{ kind: "recorded" | "already-recorded"; subject: TrustSubjectRef; generation: Generation }>
  | Readonly<{ kind: "stale"; expected: Generation; actual: Generation }>
  | Readonly<{ kind: "project-untrusted" | "project-stale"; recorded?: true; generation?: Generation }>
  | Readonly<{ kind: "recovery-required"; subject: TrustSubjectRef; committed?: Generation }>;

export interface ExactTrustGrantService {
  grant(request: Readonly<{ candidate: TrustCandidate; scope: ScopeContext; projectRoot?: TrustedProjectRoot }>, signal: AbortSignal): Promise<ExactTrustGrantResult>;
}

export type ExactTrustGrantDependencies = Readonly<{
  state: LifecycleStateStore;
  mutations: GenerationMutationCoordinator;
  projectTrust: ProjectTrustPort;
  projectRoots: ProjectRootAuthorityPort;
  sha256: Sha256;
}>;

class AlreadyRecorded extends Error {
  constructor(readonly generation: Generation) { super("exact trust grant is already recorded"); }
}

function sameScope(left: ReturnType<typeof toScopeReference>, right: TrustCandidate["evidence"]["scope"]): boolean {
  return left.kind === right.kind && (left.kind === "user" || (right.kind === "project" && left.projectKey === right.projectKey));
}

async function projectStatus(
  candidate: TrustCandidate,
  scope: ScopeContext,
  root: TrustedProjectRoot | undefined,
  dependencies: ExactTrustGrantDependencies,
  signal: AbortSignal,
): Promise<"trusted" | "project-untrusted" | "project-stale"> {
  if (scope.kind === "user") return "trusted";
  if (root === undefined) return "project-stale";
  try {
    dependencies.projectRoots.verify(root, scope);
    if (dependencies.projectRoots.revalidate !== undefined) await dependencies.projectRoots.revalidate(root, scope, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return "project-stale";
  }
  try {
    const assessment = ProjectTrustAssessmentSchema.parse(await dependencies.projectTrust.assess(scope.projectKey, signal));
    return assessment.kind === "trusted" ? "trusted" : "project-untrusted";
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return "project-stale";
  }
}

function exactGranted(records: readonly TrustStateRecord[], candidate: TrustCandidate): boolean {
  const record = records.find((entry) => entry.subject === candidate.subject);
  return record?.status === "granted" && JSON.stringify(record.evidence) === JSON.stringify(candidate.evidence);
}

export function createExactTrustGrantService(dependencies: ExactTrustGrantDependencies): ExactTrustGrantService {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") throw new TypeError("exact trust grant dependencies are required");
  const service: ExactTrustGrantService = {
    async grant(request, signal) {
      signal.throwIfAborted();
      let candidate: TrustCandidate;
      let scope: ScopeContext;
      try {
        candidate = verifyTrustCandidate(request.candidate, dependencies.sha256);
        scope = createScopeContext(request.scope, dependencies.sha256);
        PluginKeySchema.parse(candidate.evidence.plugin);
        if (!sameScope(toScopeReference(scope), candidate.evidence.scope)) return { kind: "project-stale" };
      } catch {
        return { kind: "recovery-required", subject: request.candidate.subject };
      }
      const status = await projectStatus(candidate, scope, request.projectRoot, dependencies, signal);
      if (status !== "trusted") return { kind: status };

      let loaded;
      try { loaded = await dependencies.state.read({ kind: "user" }, signal); }
      catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        return { kind: "recovery-required", subject: candidate.subject };
      }
      if (!loaded.ok || !("trust" in loaded.snapshot)) return { kind: "recovery-required", subject: candidate.subject };
      if (exactGranted(loaded.snapshot.trust.records, candidate)) {
        return { kind: "already-recorded", subject: candidate.subject, generation: loaded.snapshot.generation };
      }
      const expected = loaded.snapshot.generation;
      try {
        const result = await dependencies.mutations.runPreparedMutation(
          { scope: { kind: "user" }, plugins: [candidate.evidence.plugin], expectedGeneration: expected },
          async (context) => {
            if (!("trust" in context.snapshot)) throw new Error("trust authority is not user state");
            if (exactGranted(context.snapshot.trust.records, candidate)) throw new AlreadyRecorded(context.snapshot.generation);
            const record = grantTrust(candidate, dependencies.sha256);
            const records = [
              ...context.snapshot.trust.records.filter((entry) => entry.subject !== candidate.subject),
              record,
            ].sort((left, right) => compareUtf8(left.subject, right.subject));
            const trust = createTrustStateDocument({
              schemaVersion: 1,
              generation: context.snapshot.generation,
              records,
            }, dependencies.sha256);
            return {
              mutation: parseStateMutation({
                scope: { kind: "user" },
                expectedGeneration: context.snapshot.generation,
                replace: { trust },
              }, dependencies.sha256),
              value: candidate.subject,
              ...(scope.kind === "project" ? {
                beforeCommit: async () => {
                  const current = await projectStatus(candidate, scope, request.projectRoot, dependencies, signal);
                  if (current !== "trusted") throw Object.assign(new Error(current), { code: current });
                },
              } : {}),
            };
          },
          signal,
        );
        if (result.kind === "committed") {
          const finalStatus = await projectStatus(candidate, scope, request.projectRoot, dependencies, signal);
          if (finalStatus !== "trusted") return { kind: finalStatus, recorded: true, generation: result.snapshot.generation };
          return { kind: "recorded", subject: candidate.subject, generation: result.snapshot.generation };
        }
        if (result.kind === "stale-generation" || result.kind === "commit-failed") {
          return { kind: "stale", expected: result.expected, actual: result.actual };
        }
        return { kind: "recovery-required", subject: candidate.subject, ...(result.actual === undefined ? {} : { committed: result.actual }) };
      } catch (error) {
        if (error instanceof AlreadyRecorded) return { kind: "already-recorded", subject: candidate.subject, generation: error.generation };
        if (error instanceof CommittedMutationCleanupError) {
          return { kind: "recovery-required", subject: candidate.subject, committed: error.committed.snapshot.generation };
        }
        if (signal.aborted) throw signal.reason ?? error;
        if (error !== null && typeof error === "object" && "code" in error) {
          const code = (error as { code?: unknown }).code;
          if (code === "project-untrusted" || code === "project-stale") return { kind: code };
        }
        return { kind: "recovery-required", subject: candidate.subject };
      }
    },
  };
  return Object.freeze(service);
}
