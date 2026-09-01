/** Per-run observer-unsubscribe handle. */

import { runSafely } from "#src/debug";

/** Owns the per-run observer-unsubscribe handle. */
export class RunListeners {
	private unsub?: () => void;

	/** Store the record-observer unsubscribe handle. */
	attachObserver(unsub: () => void): void {
		this.unsub = unsub;
	}

	/** Release the observer + signal handles. Idempotent. */
	release(): void {
		const unsub = this.unsub;
		this.unsub = undefined;
		runSafely("subagent observer unsubscribe", () => unsub?.());
	}
}
