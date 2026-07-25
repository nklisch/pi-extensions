import type { CurrentProjectRuntimeContext, ProjectTrustPort } from "../application/ports/project-trust.js";
import type { NativeControlCurrentProjectPort } from "../application/native-control-selection.js";
import { toScopeReference, type ScopeContext } from "../domain/state/scope.js";

/** Bind control requests to the one project captured by the packaged host. */
export function createNativeControlCurrentProjectPort(input: Readonly<{
  scope: Extract<ScopeContext, { kind: "project" }>;
  current(): CurrentProjectRuntimeContext;
  revalidate(signal: AbortSignal): Promise<CurrentProjectRuntimeContext>;
  trust: Pick<ProjectTrustPort, "assess">;
}>): NativeControlCurrentProjectPort {
  return Object.freeze({
    async current(signal: AbortSignal) {
      signal.throwIfAborted();
      try {
        const current = await input.revalidate(signal);
        if (current.trust.kind !== "trusted") {
          return input.current().trust.kind === "trusted"
            ? { kind: "stale" as const }
            : { kind: "untrusted" as const };
        }
        const assessment = await input.trust.assess(input.scope.projectKey, signal);
        if (assessment.kind !== "trusted") return { kind: "untrusted" as const };
        return {
          kind: "trusted" as const,
          projectKey: input.scope.projectKey,
          scope: toScopeReference(input.scope) as Extract<ReturnType<typeof toScopeReference>, { kind: "project" }>,
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        return { kind: "unavailable" as const };
      }
    },
  });
}
