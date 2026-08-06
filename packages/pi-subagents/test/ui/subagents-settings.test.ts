import { describe, expect, it, vi } from "vitest";
import {
  SubagentsSettingsHandler,
  type SubagentsSettingsAgentRegistry,
  type SubagentsSettingsManager,
  type SubagentsSettingsUI,
} from "#src/ui/subagents-settings";

function makeSettings(): SubagentsSettingsManager {
  const toast = { message: "saved", level: "info" as const };
  return {
    maxConcurrent: 4,
    defaultMaxTurns: undefined,
    graceTurns: 3,
    consumedSessionRetentionMinutes: 10,
    unconsumedSessionRetentionMinutes: 60,
    abortAllOnInterrupt: true,
    fallbackSubagent: "general-purpose",
    applyMaxConcurrent: vi.fn(() => toast),
    applyDefaultMaxTurns: vi.fn(() => toast),
    applyGraceTurns: vi.fn(() => toast),
    applyConsumedSessionRetention: vi.fn(() => toast),
    applyUnconsumedSessionRetention: vi.fn(() => toast),
    applyAbortAllOnInterrupt: vi.fn(() => toast),
    applyFallbackSubagent: vi.fn(() => toast),
  };
}

function makeUi(selection: string): SubagentsSettingsUI {
  return {
    select: vi.fn()
      .mockResolvedValueOnce("Unknown agent fallback (current: general-purpose)")
      .mockResolvedValueOnce(selection),
    input: vi.fn(),
    notify: vi.fn(),
  };
}

describe("SubagentsSettingsHandler fallback policy", () => {
  it("reloads definitions and persists only a selected enabled agent", async () => {
    const settings = makeSettings();
    const registry: SubagentsSettingsAgentRegistry = {
      reload: vi.fn(),
      getAvailableTypes: vi.fn(() => ["general-purpose", "Explore", "Custom"]),
    };
    const ui = makeUi("Custom");

    await new SubagentsSettingsHandler(settings, registry).handle({ ui });

    expect(registry.reload).toHaveBeenCalledOnce();
    expect(ui.select).toHaveBeenLastCalledWith("Fallback for unknown agent types", [
      "Fail closed (no fallback)",
      "general-purpose",
      "Explore",
      "Custom",
    ]);
    expect(settings.applyFallbackSubagent).toHaveBeenCalledWith("Custom");
  });

  it("maps the explicit fail-closed option to false", async () => {
    const settings = makeSettings();
    const registry: SubagentsSettingsAgentRegistry = {
      reload: vi.fn(),
      getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
    };

    await new SubagentsSettingsHandler(settings, registry).handle({
      ui: makeUi("Fail closed (no fallback)"),
    });

    expect(settings.applyFallbackSubagent).toHaveBeenCalledWith(false);
  });
});
