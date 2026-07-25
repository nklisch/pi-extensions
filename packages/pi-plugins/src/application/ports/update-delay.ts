/** Abortable waiting is an application capability; timer ownership stays in composition. */
export interface UpdateDelayPort {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}
