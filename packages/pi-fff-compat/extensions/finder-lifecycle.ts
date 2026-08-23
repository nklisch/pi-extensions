export interface FinderLike {
  readonly isDestroyed: boolean;
  destroy(): void;
}

interface CurrentFinder<F extends FinderLike> {
  cwd: string;
  generation: number;
  finder: F;
}

interface PendingFinder<F extends FinderLike> {
  cwd: string;
  generation: number;
  promise: Promise<F>;
}

/**
 * Own the asynchronous finder lifecycle separately from the Pi event seam.
 * A scan can outlive session_shutdown; the generation check prevents that late
 * completion from becoming the finder for a replacement session.
 */
export function createGenerationGuardedFinderLifecycle<F extends FinderLike>(
  createFinder: (cwd: string) => Promise<F>,
): {
  ensure(cwd: string): Promise<F>;
  revoke(): void;
} {
  let generation = 0;
  let current: CurrentFinder<F> | null = null;
  let pending: PendingFinder<F> | null = null;

  function destroyQuietly(candidate: F | null): void {
    if (candidate === null || candidate.isDestroyed) return;
    // A stale finder has no live session context in which to report a cleanup
    // failure. Do not let best-effort shutdown cleanup reject the host event.
    try {
      candidate.destroy();
    } catch {
      // The lifecycle is already revoked; there is no safe session state to
      // repopulate, which is the guarantee this cleanup protects.
    }
  }

  function revoke(): void {
    generation++;
    const old = current;
    current = null;
    destroyQuietly(old?.finder ?? null);
  }

  function ensure(cwd: string): Promise<F> {
    if (current?.finder.isDestroyed) current = null;
    if (current?.cwd === cwd) return Promise.resolve(current.finder);
    if (pending?.cwd === cwd && pending.generation === generation) return pending.promise;

    // A different workspace, or a new session after revocation, invalidates
    // every earlier initialization. Its late result will be destroyed below.
    generation++;
    const requestedGeneration = generation;
    const old = current;
    current = null;
    destroyQuietly(old?.finder ?? null);

    const initialization = (async (): Promise<F> => {
      let candidate: F | null = null;
      try {
        candidate = await createFinder(cwd);
        if (requestedGeneration !== generation) {
          throw new Error("FFF finder initialization was revoked");
        }
        current = { cwd, generation: requestedGeneration, finder: candidate };
        return candidate;
      } catch (error) {
        // If creation itself fails after allocating a finder, the factory owns
        // cleanup. A completed-but-invalidated candidate is closed exactly once
        // here, before its rejected promise reaches the old session callback.
        if (candidate !== null && current?.finder !== candidate) destroyQuietly(candidate);
        throw error;
      }
    })();

    let guardedPromise!: Promise<F>;
    guardedPromise = initialization.finally(() => {
      if (pending?.promise === guardedPromise) pending = null;
    });
    pending = { cwd, generation: requestedGeneration, promise: guardedPromise };
    return guardedPromise;
  }

  return { ensure, revoke };
}
