import { createProjectLocalStateDocument } from "../domain/state/project-state.js";
import type { ContentDigest } from "../domain/content-manifest.js";
import type { ProjectScopeContext, ProjectGenerationSnapshot } from "./state-contract.js";
import { parseStateMutation } from "./state-contract.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import type { Sha256 } from "../domain/source.js";

export type ProjectSyncDigestCommitResult =
  | Readonly<{ kind: "committed" | "unchanged"; snapshot: ProjectGenerationSnapshot }>
  | Readonly<{ kind: "stale"; actual: number }>
  | Readonly<{ kind: "recovery-required"; committed?: number }>;

export async function commitProjectSyncDeclarationDigest(input: Readonly<{
  snapshot: ProjectGenerationSnapshot;
  digest: ContentDigest;
  mutations: GenerationMutationCoordinator;
  sha256: Sha256;
}>, signal: AbortSignal): Promise<ProjectSyncDigestCommitResult> {
  if (input.snapshot.project.declarationDigest === input.digest) return { kind: "unchanged", snapshot: input.snapshot };
  const scope = input.snapshot.scope as ProjectScopeContext;
  const result = await input.mutations.runPreparedMutation({ scope, plugins: [], expectedGeneration: input.snapshot.generation }, async (context) => {
    if (!("project" in context.snapshot) || context.snapshot.scope.projectKey !== scope.projectKey) throw new Error("project sync state authority changed");
    const project = createProjectLocalStateDocument({ ...context.snapshot.project, generation: context.snapshot.generation, declarationDigest: input.digest }, scope, input.sha256);
    return { mutation: parseStateMutation({ scope, expectedGeneration: context.snapshot.generation, replace: { project } }, input.sha256), value: input.digest };
  }, signal);
  if (result.kind === "committed") {
    if (!("project" in result.snapshot)) return { kind: "recovery-required", committed: result.snapshot.generation };
    return { kind: "committed", snapshot: result.snapshot };
  }
  if (result.kind === "stale-generation" || result.kind === "commit-failed") return { kind: "stale", actual: result.actual };
  return { kind: "recovery-required", ...(result.actual === undefined ? {} : { committed: result.actual }) };
}
