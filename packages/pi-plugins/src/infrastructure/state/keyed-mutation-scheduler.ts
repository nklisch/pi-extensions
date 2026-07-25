import { AsyncLocalStorage } from "node:async_hooks";
import {
  createKeyedMutationScheduler as createPortableKeyedMutationScheduler,
  canonicalSubjectKey,
  RecursiveMutationAcquisitionError,
} from "../../application/keyed-mutation-scheduler.js";
import type { MutationExecutionContext } from "../../application/ports/mutation-execution-context.js";
import type { KeyedMutationScheduler } from "../../application/mutation-coordination.js";

class NodeMutationExecutionContext implements MutationExecutionContext {
  private readonly storage = new AsyncLocalStorage<ReadonlySet<string>>();

  current(): ReadonlySet<string> | undefined {
    return this.storage.getStore();
  }

  run<T>(keys: ReadonlySet<string>, work: () => T): T {
    return this.storage.run(keys, work);
  }
}

/** Compose the portable scheduler with Node's async-local execution context. */
export function createKeyedMutationScheduler(): KeyedMutationScheduler {
  return createPortableKeyedMutationScheduler(new NodeMutationExecutionContext());
}

export { canonicalSubjectKey, RecursiveMutationAcquisitionError };
