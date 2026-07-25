import type { CommandRunner } from "../application/ports/process-runner.js";
import type { ProjectRootAuthorityPort, ProjectRootResolutionPort } from "../application/ports/project-root-authority.js";
import type { CurrentProjectRuntimeContext, ProjectTrustPort } from "../application/ports/project-trust.js";
import type { PiSessionBindingPort } from "../composition/packaged-plugin-host-contract.js";
import { createProjectRootAuthorityPort } from "../composition/create-project-root-authority.js";
import { createScopeContext, type ScopeContext } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import { createNodeProjectRootResolver } from "../infrastructure/project/node-project-root-resolver.js";

export type PiProjectContextAdapters = Readonly<{
  resolution: ProjectRootResolutionPort;
  authority: ProjectRootAuthorityPort;
  trust: ProjectTrustPort;
  scope: Extract<ScopeContext, { kind: "project" }>;
  revalidate(signal: AbortSignal): Promise<CurrentProjectRuntimeContext>;
  current(): CurrentProjectRuntimeContext;
}>;

/** Build exact project identity and live Pi trust from one bound session. */
export async function createPiProjectContextAdapters(input: Readonly<{
  binding: PiSessionBindingPort;
  sha256: Sha256;
  git?: Pick<CommandRunner, "run">;
}>): Promise<PiProjectContextAdapters> {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") {
    throw new TypeError("Pi project context dependencies are required");
  }
  const cwd = input.binding.current().cwd;
  const resolution = createNodeProjectRootResolver({
    cwd,
    sha256: input.sha256,
    ...(input.git === undefined ? {} : { git: input.git }),
  });
  const resolved = createScopeContext(await resolution.resolve(new AbortController().signal), input.sha256);
  if (resolved.kind !== "project") throw new Error("project resolver returned user scope");
  const initial: Extract<ScopeContext, { kind: "project" }> = resolved;
  const authority = createProjectRootAuthorityPort(resolution, input.sha256, initial);
  // Resolution shells out to git for the repository fingerprint. Control
  // reads revalidate several times per command burst, so concurrent callers
  // share one in-flight resolution. The result is never reused once settled:
  // bound-identity replacement must fail closed on the very next call.
  let inFlight: Promise<Readonly<{ exact: boolean }>> | undefined;
  async function revalidate(signal: AbortSignal): Promise<CurrentProjectRuntimeContext> {
    signal.throwIfAborted();
    inFlight ??= (async () => {
      try {
        const current = await authority.revalidateCurrent!(signal);
        if (current.kind !== "project") throw new Error("current project identity is unavailable");
        return Object.freeze({
          exact: current.projectKey === initial.projectKey &&
            JSON.stringify(current.identity) === JSON.stringify(initial.identity),
        });
      } finally {
        inFlight = undefined;
      }
    })();
    const current = await inFlight;
    signal.throwIfAborted();
    return Object.freeze({
      identity: initial.identity,
      projectKey: initial.projectKey,
      trust: current.exact && input.binding.isProjectTrusted() ? { kind: "trusted" } : { kind: "untrusted" },
    });
  }
  const trust: ProjectTrustPort = Object.freeze({
    async assess(
      projectKey: Parameters<ProjectTrustPort["assess"]>[0],
      signal: AbortSignal,
    ) {
      if (projectKey !== initial.projectKey) return { kind: "untrusted" as const };
      try {
        const current = await revalidate(signal);
        return current.trust;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        return { kind: "untrusted" as const };
      }
    },
  });
  return Object.freeze({
    resolution,
    authority,
    trust,
    scope: initial,
    revalidate,
    current(): CurrentProjectRuntimeContext {
      return Object.freeze({
        identity: initial.identity,
        projectKey: initial.projectKey,
        trust: input.binding.isProjectTrusted() ? { kind: "trusted" } : { kind: "untrusted" },
      });
    },
  });
}
