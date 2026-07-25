import type { TokenUsage } from "./reviewer.ts";

export interface TokenBudgetConfig {
  readonly window: string;
  readonly limit: number | null;
}

export interface BudgetCheckResult {
  readonly exhausted: boolean;
  readonly cumulative: number;
  readonly remaining: number | null;
}

/** Port: the runtime decision path depends on this interface, not the implementation. */
export interface ReviewerTokenBudgetGate {
  /** True iff budget is active and cumulative in-window usage >= limit. */
  isExhausted(config: TokenBudgetConfig): boolean;
  /** Account a completed call's usage. No-op when limit === null. */
  record(usage: TokenUsage, config: TokenBudgetConfig): void;
}

/**
 * Default window used when config.window is unparseable.
 *
 * A typo should keep the configured budget functional rather than silently making model
 * review unlimited.
 */
export const DEFAULT_TOKEN_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ReviewerTokenBudgetGateOptions {
  /**
   * Injected so this module stays pure and independent of the shared duration-parser
   * module. Production wires parseDurationToMs at the composition root.
   */
  readonly parseDuration: (window: string) => number | undefined;
  readonly clock?: () => number;
}

interface TokenBudgetEntry {
  readonly ts: number;
  readonly tokens: number;
}

export function createReviewerTokenBudgetGate(
  options: ReviewerTokenBudgetGateOptions,
): ReviewerTokenBudgetGate {
  const entries: TokenBudgetEntry[] = [];
  const windowCache = new Map<string, number>();
  const clock = options.clock ?? (() => Date.now());

  const windowMsFor = (config: TokenBudgetConfig): number => {
    const cached = windowCache.get(config.window);
    if (cached !== undefined) return cached;

    const parsed =
      options.parseDuration(config.window) ?? DEFAULT_TOKEN_BUDGET_WINDOW_MS;
    windowCache.set(config.window, parsed);
    return parsed;
  };

  const prune = (now: number, windowMs: number): void => {
    const cutoff = now - windowMs;
    let writeIndex = 0;

    for (const entry of entries) {
      if (entry.ts >= cutoff) {
        entries[writeIndex] = entry;
        writeIndex += 1;
      }
    }

    entries.length = writeIndex;
  };

  const cumulative = (): number =>
    entries.reduce((sum, entry) => sum + entry.tokens, 0);

  return {
    isExhausted(config) {
      if (config.limit === null) return false;

      const now = clock();
      prune(now, windowMsFor(config));
      return cumulative() >= config.limit;
    },

    record(usage, config) {
      if (config.limit === null) return;

      const now = clock();
      entries.push({ ts: now, tokens: Math.max(0, usage.totalTokens) });
      prune(now, windowMsFor(config));
    },
  };
}
