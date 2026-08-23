/**
 * concurrency-limiter.ts — FIFO admission gate for background work.
 *
 * Schedules run closures (thunks) against a dynamic limit, running them in
 * scheduling order as slots free. The limiter knows nothing about agents, IDs,
 * or the manager — it owns only the active count and the pending queue.
 *
 * Every scheduled promise settles: it follows the task's settlement when the
 * task runs, or resolves early if clear() drops it before it starts.
 */

import { debugLog } from "#src/debug";

export class ConcurrencyLimiter {
	private active = 0;
	private readonly pending: Array<{ start: () => void; settle: () => void }> = [];

	constructor(private readonly getLimit: () => number) {}

	/** Whether a newly scheduled task will wait behind work already admitted. */
	isSaturated(): boolean {
		try {
			return this.active >= this.getLimit();
		} catch (error) {
			debugLog("concurrency limiter limit", error);
			return false;
		}
	}

	/**
	 * Schedule a task to run FIFO once a slot is free.
	 * Returns a promise that settles with the task, or resolves early if the
	 * task is dropped by clear() before it starts.
	 */
	schedule(task: () => Promise<void>): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
		this.pending.push({
			start: () => {
				this.active++;
				let taskPromise: Promise<void>;
				try {
					taskPromise = Promise.resolve(task());
				} catch (error) {
					taskPromise = Promise.reject(error);
				}
				taskPromise
					.then(resolve, reject)
					.finally(() => {
						this.active--;
						try {
							this.recheck();
						} catch (error) {
							// A failing dynamic limit must not strand the slot or
							// reject the detached cleanup promise.
							debugLog("concurrency limiter recheck", error);
						}
					})
					.catch((error: unknown) => debugLog("concurrency limiter cleanup", error));
			},
			settle: resolve,
		});
		this.recheck();
		return promise;
	}

	/** Start pending tasks until the limit is reached. Call when the limit may have grown. */
	recheck(): void {
		try {
			while (this.active < this.getLimit()) {
				const next = this.pending.shift();
				if (!next) break;
				next.start();
			}
		} catch (error) {
			debugLog("concurrency limiter recheck", error);
		}
	}

	/** Drop all pending tasks, resolving their promises without running them. */
	clear(): void {
		const dropped = this.pending.splice(0);
		for (const task of dropped) task.settle();
	}
}
