import { describe, expect, it } from "vitest";

import {
  createReviewerTokenBudgetGate,
  DEFAULT_TOKEN_BUDGET_WINDOW_MS,
  type TokenBudgetConfig,
} from "../../src/runtime/token-budget.ts";

const oneSecond = 1_000;
const oneHour = 60 * 60 * 1_000;

const limited = (
  overrides: Partial<TokenBudgetConfig> = {},
): TokenBudgetConfig =>
  ({
    window: "1h",
    limit: 1_000,
    ...overrides,
  }) satisfies TokenBudgetConfig;

describe("createReviewerTokenBudgetGate", () => {
  it("keeps limit null unlimited and does not account state", () => {
    let now = 0;
    let parseCalls = 0;
    const gate = createReviewerTokenBudgetGate({
      clock: () => now,
      parseDuration: () => {
        parseCalls += 1;
        return oneHour;
      },
    });
    const unlimited = limited({ limit: null });

    for (let index = 0; index < 10; index += 1) {
      gate.record({ totalTokens: 10_000 }, unlimited);
      expect(gate.isExhausted(unlimited)).toBe(false);
      now += 1;
    }

    expect(parseCalls).toBe(0);
    expect(gate.isExhausted(limited({ limit: 1 }))).toBe(false);
  });

  it("reports exhaustion once cumulative in-window usage reaches the limit", () => {
    let now = 0;
    const gate = createReviewerTokenBudgetGate({
      clock: () => now,
      parseDuration: () => oneHour,
    });
    const config = limited();

    gate.record({ totalTokens: 600 }, config);
    expect(gate.isExhausted(config)).toBe(false);

    now += 10;
    gate.record({ totalTokens: 600 }, config);
    expect(gate.isExhausted(config)).toBe(true);
  });

  it("restores capacity after recorded usage ages out of the window", () => {
    let now = 0;
    const gate = createReviewerTokenBudgetGate({
      clock: () => now,
      parseDuration: () => oneSecond,
    });
    const config = limited({ window: "1s", limit: 1_000 });

    gate.record({ totalTokens: 1_000 }, config);
    expect(gate.isExhausted(config)).toBe(true);

    now = oneSecond + 1;
    expect(gate.isExhausted(config)).toBe(false);
  });

  it("falls back to the default token-budget window when parsing fails", () => {
    let now = 0;
    const gate = createReviewerTokenBudgetGate({
      clock: () => now,
      parseDuration: () => undefined,
    });
    const config = limited({ window: "bogus" });

    gate.record({ totalTokens: 600 }, config);
    gate.record({ totalTokens: 600 }, config);
    expect(gate.isExhausted(config)).toBe(true);

    now = DEFAULT_TOKEN_BUDGET_WINDOW_MS - 1;
    expect(gate.isExhausted(config)).toBe(true);

    now = DEFAULT_TOKEN_BUDGET_WINDOW_MS + 1;
    expect(gate.isExhausted(config)).toBe(false);
  });

  it("records zero token usage as zero instead of using a per-call estimate", () => {
    const gate = createReviewerTokenBudgetGate({
      parseDuration: () => oneHour,
    });
    const config = limited({ limit: 1 });

    for (let index = 0; index < 5; index += 1) {
      gate.record({ totalTokens: 0 }, config);
    }
    expect(gate.isExhausted(config)).toBe(false);

    gate.record({ totalTokens: 1 }, config);
    expect(gate.isExhausted(config)).toBe(true);
  });

  it("clamps negative token usage to zero", () => {
    const gate = createReviewerTokenBudgetGate({
      parseDuration: () => oneHour,
    });
    const config = limited({ limit: 1 });

    gate.record({ totalTokens: -10 }, config);
    expect(gate.isExhausted(config)).toBe(false);

    gate.record({ totalTokens: 1 }, config);
    expect(gate.isExhausted(config)).toBe(true);
  });

  it("caches parsed windows by config window string", () => {
    const parsedWindows: string[] = [];
    const gate = createReviewerTokenBudgetGate({
      parseDuration: (window) => {
        parsedWindows.push(window);
        return window === "1h" ? oneHour : oneSecond;
      },
    });

    gate.record({ totalTokens: 1 }, limited({ window: "1h" }));
    gate.isExhausted(limited({ window: "1h" }));
    gate.record({ totalTokens: 1 }, limited({ window: "1s" }));

    expect(parsedWindows).toEqual(["1h", "1s"]);
  });
});
