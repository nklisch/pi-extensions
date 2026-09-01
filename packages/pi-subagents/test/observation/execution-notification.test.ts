import { describe, expect, it } from "vitest";
import { getStatusLabel } from "#src/observation/notification";

describe("terminal reason labels", () => {
  it("keeps graceful turn-limit completion distinct", () => {
    expect(getStatusLabel("completed", "turn_limit_graceful")).toBe("Completed (turn limit)");
  });

  it("labels cancellation by reason without inventing a new status", () => {
    expect(getStatusLabel("stopped", "runtime_timeout")).toBe("Stopped (runtime timeout)");
    expect(getStatusLabel("stopped", "parent_cancelled")).toBe("Stopped (parent cancelled)");
    expect(getStatusLabel("stopped")).toBe("Stopped");
  });
});
