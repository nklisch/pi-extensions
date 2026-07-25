import type { ProjectIdentity, ProjectKey, ScopeContext } from "../../domain/state/scope.js";

/**
 * This symbol is intentionally module-private. The visible fields describe the
 * root for adapters, but the symbol is the compile-time authority marker and
 * the composition port's WeakSet membership is the runtime authority. A
 * parsed or spread copy is only data and cannot cross the port.
 */
declare const trustedProjectRootBrand: unique symbol;

export type TrustedProjectRoot = Readonly<{
  readonly kind: "trusted-project-root-v1";
  readonly identity: Extract<ProjectIdentity, { kind: "repository" | "path-only" }>;
  readonly projectKey: ProjectKey;
  readonly canonicalRoot: Extract<ProjectIdentity, { kind: "repository" | "path-only" }>["canonicalRoot"];
  readonly [trustedProjectRootBrand]: true;
}>;

/**
 * A composition adapter resolves the actual project selected by the host. It
 * receives no caller-selected root, so issuance cannot be redirected by a
 * plugin or presentation-layer value.
 */
export interface ProjectRootResolutionPort {
  resolve(signal: AbortSignal): Promise<unknown>;
}

/** Application boundary consumed by path validation and configuration services. */
export interface ProjectRootAuthorityPort {
  acquire(signal: AbortSignal): Promise<TrustedProjectRoot>;
  verify(capability: unknown, scope: ScopeContext): ScopeContext;
  /** Re-resolve canonical root/repository identity before an effectful boundary. */
  revalidate?(capability: unknown, scope: ScopeContext, signal: AbortSignal): Promise<ScopeContext>;
  /** Re-resolve the session project even when no prior capability is available. */
  revalidateCurrent?(signal: AbortSignal): Promise<ScopeContext>;
}
