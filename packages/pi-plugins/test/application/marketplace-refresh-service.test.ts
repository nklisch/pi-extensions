import { describe, expect, it } from "vitest";
import { automaticDisposition } from "../../src/application/marketplace-refresh-service.js";
import type { LifecycleRejectionCode } from "../../src/application/plugin-lifecycle-contract.js";

describe("automatic update disposition mapping", () => {
  it("classifies every lifecycle outcome and rejection code", () => {
    expect(automaticDisposition({ kind: "changed" })).toBe("automatic-applied");
    expect(automaticDisposition({ kind: "unchanged" })).toBe("automatic-applied");
    expect(automaticDisposition({ kind: "stale" })).toBe("automatic-retryable");
    expect(automaticDisposition({ kind: "rolled-back" })).toBe("automatic-retryable");
    expect(automaticDisposition({ kind: "recovery-required" })).toBe("recovery-required");

    const manual: readonly LifecycleRejectionCode[] = [
      "INVALID_REQUEST", "NOT_INSTALLED", "ALREADY_INSTALLED", "WRONG_ACTIVATION",
      "PENDING_TRANSITION", "INCOMPATIBLE", "UNTRUSTED", "UNCONFIGURED", "MALFORMED",
    ];
    for (const code of manual) expect(automaticDisposition({ kind: "rejected", code })).toBe("manual-required");

    const retryable: readonly LifecycleRejectionCode[] = ["PROJECTION_FAILED", "PROMOTION_FAILED", "ABORTED", "AVAILABLE_REVISION_CHANGED"];
    for (const code of retryable) expect(automaticDisposition({ kind: "rejected", code })).toBe("automatic-retryable");
  });
});
