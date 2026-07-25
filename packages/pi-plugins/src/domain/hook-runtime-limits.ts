/** Shared bounded-runtime values for every command-hook boundary. */
export const HOOK_STDIN_MAX_BYTES = 256 * 1024;
export const HOOK_STDOUT_MAX_BYTES = 64 * 1024;
export const HOOK_STDERR_MAX_BYTES = 64 * 1024;
export const HOOK_DEFAULT_TIMEOUT_MS = 10_000;
export const HOOK_MAX_TIMEOUT_MS = 600_000;
export const HOOK_MAX_SELECTED_HANDLERS = 256;
export const HOOK_MAX_CONCURRENCY = 8;
export const HOOK_MAX_AGGREGATED_TEXT_BYTES = 256 * 1024;
export const HOOK_ASK_TIMEOUT_MS = 30_000;
export const HOOK_STOP_CONTINUATION_BUDGET = 3;
export const HOOK_SUBAGENT_CONTINUATION_BUDGET = 3;

export const HookRuntimeLimits = Object.freeze({
  stdinMaxBytes: HOOK_STDIN_MAX_BYTES,
  stdoutMaxBytes: HOOK_STDOUT_MAX_BYTES,
  stderrMaxBytes: HOOK_STDERR_MAX_BYTES,
  defaultTimeoutMs: HOOK_DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: HOOK_MAX_TIMEOUT_MS,
  maxSelectedHandlers: HOOK_MAX_SELECTED_HANDLERS,
  maxConcurrency: HOOK_MAX_CONCURRENCY,
  maxAggregatedTextBytes: HOOK_MAX_AGGREGATED_TEXT_BYTES,
  askTimeoutMs: HOOK_ASK_TIMEOUT_MS,
  stopContinuationBudget: HOOK_STOP_CONTINUATION_BUDGET,
  subagentContinuationBudget: HOOK_SUBAGENT_CONTINUATION_BUDGET,
});
