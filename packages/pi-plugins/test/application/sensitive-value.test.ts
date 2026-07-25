import { describe, expect, it } from "vitest";
import { SensitiveValue, withSensitiveValue } from "../../src/application/sensitive-value.js";

describe("SensitiveValue", () => {
  it("redacts all ordinary coercions and only exposes callback-scoped consumption", () => {
    const secret = SensitiveValue.fromUnknown("CANARY_SECRET");
    expect(String(secret)).toBe("[REDACTED]");
    expect(`${secret}`).toBe("[REDACTED]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(Object.prototype.toString.call(secret)).toBe("[object Object]");
    expect(withSensitiveValue(secret, (value) => value)).toBe("CANARY_SECRET");
    expect(JSON.stringify(secret)).not.toContain("CANARY_SECRET");
  });

  it("rejects unsafe object coercion and does not expose a getter", () => {
    expect(() => SensitiveValue.fromUnknown({ toString: () => "CANARY_SECRET" })).toThrow();
    const secret = SensitiveValue.fromUnknown(["one", "two"]);
    expect(withSensitiveValue(secret, (value) => value)).toBe('["one","two"]');
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.getOwnPropertyNames(secret)).not.toContain("plaintext");
  });
});
