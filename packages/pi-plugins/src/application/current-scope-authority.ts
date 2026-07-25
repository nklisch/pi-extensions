import { canonicalJson } from "../domain/canonical-json.js";
import { ScopeContextSchema, type ScopeContext } from "../domain/state/scope.js";
import type { CurrentProjectRuntimeContext, ProjectTrustPort } from "./ports/project-trust.js";

export type CurrentScopeAuthorityDependencies = Readonly<{
  currentProject?: Extract<ScopeContext, { kind: "project" }>;
  projectTrust?: ProjectTrustPort;
  revalidateCurrentProject?: (signal: AbortSignal) => Promise<CurrentProjectRuntimeContext>;
}>;

export type CurrentScopeAuthority = Readonly<
  | { kind: "trusted"; current?: CurrentProjectRuntimeContext }
  | { kind: "project-stale" }
  | { kind: "project-untrusted" }
>;

function sameProject(
  left: Extract<ScopeContext, { kind: "project" }>,
  right: Readonly<{ projectKey: string; identity: unknown }>,
): boolean {
  return left.projectKey === right.projectKey && canonicalJson(left.identity) === canonicalJson(right.identity);
}

/**
 * Bind project work to the one project selected by this session. Project state
 * callers invoke this immediately before reads/effects; inventory membership is
 * never treated as current root or trust authority.
 */
export async function authorizeCurrentScope(
  contextInput: ScopeContext,
  dependencies: CurrentScopeAuthorityDependencies,
  signal: AbortSignal,
): Promise<CurrentScopeAuthority> {
  signal.throwIfAborted();
  const context = ScopeContextSchema.parse(contextInput);
  if (context.kind === "user") return { kind: "trusted" };
  const bound = dependencies.currentProject;
  if (bound === undefined || !sameProject(context, bound) || dependencies.revalidateCurrentProject === undefined) {
    return { kind: "project-stale" };
  }
  let current: CurrentProjectRuntimeContext;
  try {
    current = await dependencies.revalidateCurrentProject(signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return { kind: "project-stale" };
  }
  if (!sameProject(context, current)) return { kind: "project-stale" };
  if (current.trust.kind !== "trusted" || dependencies.projectTrust === undefined) return { kind: "project-untrusted" };
  try {
    if ((await dependencies.projectTrust.assess(context.projectKey, signal)).kind !== "trusted") {
      return { kind: "project-untrusted" };
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return { kind: "project-untrusted" };
  }
  signal.throwIfAborted();
  return { kind: "trusted", current };
}

export function sameProjectAuthority(
  left: CurrentProjectRuntimeContext,
  right: CurrentProjectRuntimeContext,
): boolean {
  return left.projectKey === right.projectKey &&
    canonicalJson(left.identity) === canonicalJson(right.identity) &&
    left.trust.kind === right.trust.kind;
}
