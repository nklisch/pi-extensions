import { createProjectLocalStateDocument } from "../domain/state/project-state.js";
import type { ContentDigest } from "../domain/content-manifest.js";
import type { ProjectScopeContext, ProjectGenerationSnapshot } from "./state-contract.js";
import { parseStateMutation } from "./state-contract.js";
import { runScopedMutation } from "./state-transaction.js";
import type { Sha256 } from "../domain/source.js";

export type ProjectSyncDigestCommitResult =
  | Readonly<{ kind: "committed" | "unchanged"; snapshot: ProjectGenerationSnapshot }>
  | Readonly<{ kind: "stale"; actual: number }>
  | Readonly<{ kind: "unavailable" }>; 

export async function commitProjectSyncDeclarationDigest(input: Readonly<{
  snapshot: ProjectGenerationSnapshot;
  digest: ContentDigest;
  mutations: import("./ports/lifecycle-state-store.js").LifecycleStateStore;
  sha256: Sha256;
}>, signal: AbortSignal): Promise<ProjectSyncDigestCommitResult> {
  if (input.snapshot.project.declarationDigest === input.digest) return { kind: "unchanged", snapshot: input.snapshot };
  const scope = input.snapshot.scope as ProjectScopeContext;
  const result = await runScopedMutation(input.mutations, scope, (snapshot) => {
    if (!("project" in snapshot) || snapshot.scope.projectKey !== scope.projectKey) throw new Error("project sync state authority changed");
    const project = createProjectLocalStateDocument({ ...snapshot.project, generation: snapshot.generation, declarationDigest: input.digest }, scope, input.sha256);
    return { kind: "commit" as const, mutation: parseStateMutation({ scope, expectedGeneration: snapshot.generation, replace: { project } }, input.sha256), value: input.digest };
  }, signal);
  if (result.kind === "committed") {
    if (!("project" in result.snapshot)) return { kind: "unavailable" };
    return { kind: "committed", snapshot: result.snapshot };
  }
  if (result.kind === "stale") return { kind: "stale", actual: result.actual ?? input.snapshot.generation };
  return { kind: "unavailable" };
}
