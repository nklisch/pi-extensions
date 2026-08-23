/**
 * debug.ts — Debug logging utility for silenced catch blocks.
 *
 * Set PI_SUBAGENTS_DEBUG=1 to reveal silent failures in catch blocks
 * throughout the package. Production behavior is unchanged when unset.
 */

export function isDebug(): boolean {
  return process.env.PI_SUBAGENTS_DEBUG === "1";
}

export function debugLog(context: string, err: unknown): void {
  if (isDebug()) console.warn(`[pi-subagents:debug] ${context}:`, err);
}

/** Run a synchronous extension-owned callback without letting it escape its boundary. */
export function runSafely(context: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    debugLog(context, error);
  }
}

/** Start extension-owned async work and consume both synchronous and rejected failures. */
export function runDetached(context: string, action: () => PromiseLike<unknown> | void): void {
  try {
    void Promise.resolve(action()).catch((error: unknown) => debugLog(context, error));
  } catch (error) {
    debugLog(context, error);
  }
}
