/**
 * FIFO admission for every child run.
 *
 * The limiter deliberately knows nothing about subagents. A queued handle can
 * be cancelled by its owner, which removes that exact entry rather than
 * leaving a tombstone for a later capacity change.
 */

import { debugLog } from "#src/debug";

export interface AdmissionHandle {
  readonly promise: Promise<void>;
  readonly admitted: boolean;
  cancel(): void;
}

interface PendingEntry {
  readonly task: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  handle: AdmissionHandleImpl;
}

class AdmissionHandleImpl implements AdmissionHandle {
  admitted = false;
  settled = false;
  private cancelled = false;

  constructor(
    readonly promise: Promise<void>,
    private readonly cancelPending: () => void,
  ) {}

  cancel(): void {
    if (this.cancelled || this.admitted || this.settled) return;
    this.cancelled = true;
    this.cancelPending();
  }

  markAdmitted(): void {
    this.admitted = true;
  }

  markSettled(): void {
    this.settled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly pending: PendingEntry[] = [];

  constructor(private readonly getLimit: () => number) {}

  isSaturated(): boolean {
    try {
      return this.active >= this.getLimit();
    } catch (error) {
      debugLog("concurrency limiter limit", error);
      return false;
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.pending.length;
  }

  schedule(task: () => Promise<void>): AdmissionHandle {
    let entry!: PendingEntry;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const handle = new AdmissionHandleImpl(promise, () => {
      const index = this.pending.indexOf(entry);
      if (index === -1) return;
      this.pending.splice(index, 1);
      handle.markSettled();
      resolve();
    });
    entry = { task, resolve, reject, handle };
    this.pending.push(entry);
    this.recheck();
    return handle;
  }

  recheck(): void {
    try {
      while (this.active < this.getLimit()) {
        const next = this.pending.shift();
        if (!next) return;
        if (next.handle.isCancelled) continue;
        next.handle.markAdmitted();
        this.active++;
        let taskPromise: Promise<void>;
        try {
          taskPromise = Promise.resolve(next.task());
        } catch (error) {
          taskPromise = Promise.reject(error);
        }
        taskPromise.then(next.resolve, next.reject).finally(() => {
          next.handle.markSettled();
          this.active--;
          try {
            this.recheck();
          } catch (error) {
            debugLog("concurrency limiter recheck", error);
          }
        }).catch((error: unknown) => {
          // The task promise was already forwarded to the caller. This catch
          // only contains a rejected `finally` continuation.
          debugLog("concurrency limiter cleanup", error);
        });
      }
    } catch (error) {
      debugLog("concurrency limiter recheck", error);
    }
  }

}
