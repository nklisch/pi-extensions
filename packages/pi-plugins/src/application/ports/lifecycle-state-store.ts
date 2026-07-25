import type { ScopeContext } from "../../domain/state/scope.js";
import type {
  StateCommitResult,
  StateLoadResult,
  VerifiedStateMutation,
} from "../state-contract.js";

/**
 * Adapter-neutral authoritative state port.
 *
 * Implementations own locking, durable publication, and adapter failures. The
 * port deliberately exposes only validated scope generations and mutations
 * verified by parseStateMutation: callers cannot pass structural evidence,
 * hold a transaction callback, provide paths, choose a lock, apply trust
 * policy, promote content, write projections, or manipulate operations,
 * journals, or recovery payloads.
 */
export interface LifecycleStateStore {
  read(scope: ScopeContext, signal: AbortSignal): Promise<StateLoadResult>;
  commit(mutation: VerifiedStateMutation, signal: AbortSignal): Promise<StateCommitResult>;
}
