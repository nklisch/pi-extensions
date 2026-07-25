import { describe, expect, it } from "vitest";
import { projectNativeControlJson, nativeControlContainsForbiddenValue } from "../../src/application/native-control-redaction.js";
import { SensitiveValue } from "../../src/application/sensitive-value.js";

describe("native control redaction", () => {
  it("removes native errors and path-bearing fields structurally", () => {
    const projected = projectNativeControlJson({ code: "FAILED", path: "/private/canary", nested: { message: "native canary", cause: new Error("secret") }, safe: "ok" });
    expect(projected).toEqual({ code: "FAILED", path: "[REDACTED]", nested: {}, safe: "ok" });
    expect(JSON.stringify(projected)).not.toContain("private");
    expect(JSON.stringify(projected)).not.toContain("native canary");
  });

  it("rejects sensitive custody, classes, non-finite values, and cycles", () => {
    expect(nativeControlContainsForbiddenValue(SensitiveValue.fromUnknown("secret"))).toBe(true);
    expect(nativeControlContainsForbiddenValue(new Error("secret"))).toBe(true);
    expect(nativeControlContainsForbiddenValue(Number.NaN)).toBe(true);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(nativeControlContainsForbiddenValue(cycle)).toBe(true);
  });

  it("redacts unsafe controls instead of forwarding them", () => {
    expect(projectNativeControlJson({ text: "safe\u001b]52;secret" })).toEqual({ text: "[REDACTED]" });
  });
});
