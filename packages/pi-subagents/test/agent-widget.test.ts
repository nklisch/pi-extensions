import { describe, expect, it } from "vitest";
import { formatStatusBar } from "#src/ui/agent-widget";

describe("formatStatusBar", () => {
  it("shows each active model with elapsed runtime or queued state", () => {
    const text = formatStatusBar(
      { runningCount: 1, queuedCount: 1, hasFinished: false, hasActive: true },
      [
        { status: "running", modelLabel: "openai-codex/gpt-5.6-sol", startedAt: 1_000 },
        { status: "queued", modelLabel: "zai/glm-5.2", startedAt: 5_000 },
      ],
      6_000,
    );

    expect(text).toBe(
      "1 running, 1 queued agents · openai-codex/gpt-5.6-sol 5.0s, zai/glm-5.2 queued",
    );
  });

  it("clears when no agent is active", () => {
    expect(formatStatusBar(
      { runningCount: 0, queuedCount: 0, hasFinished: true, hasActive: false },
      [],
    )).toBeUndefined();
  });
});
