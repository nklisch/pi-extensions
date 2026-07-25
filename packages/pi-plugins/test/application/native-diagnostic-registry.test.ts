import { describe, expect, it } from "vitest";
import { NativeDiagnosticActionSchema, NativeDiagnosticCategorySchema, NativeDiagnosticCodeSchema, NativeDiagnosticRegistry } from "../../src/application/native-diagnostic-registry.js";

describe("native diagnostic registry", () => {
  it("owns every code, category, action, rank, severity, and condition effect", () => {
    const values = Object.values(NativeDiagnosticRegistry);
    expect(new Set(values.map((entry) => entry.code)).size).toBe(values.length);
    expect(new Set(values.map((entry) => entry.rank)).size).toBe(values.length);
    for (const entry of values) {
      expect(NativeDiagnosticCodeSchema.parse(entry.code)).toBe(entry.code);
      expect(NativeDiagnosticCategorySchema.parse(entry.category)).toBe(entry.category);
      expect(NativeDiagnosticActionSchema.parse(entry.action)).toBe(entry.action);
      expect(["error", "warning", "info"]).toContain(entry.severity);
      expect(typeof entry.blocks).toBe("boolean");
      expect(typeof entry.unavailable).toBe("boolean");
      expect(entry.summary).not.toMatch(/[{}]/u);
    }
  });

  it("keeps semantic actions free of command grammar", () => {
    for (const entry of Object.values(NativeDiagnosticRegistry)) {
      expect(entry.action).not.toMatch(/[\s/\\-]{2}|^\//u);
      expect(entry.action).not.toContain("npm");
      expect(entry.action).not.toContain("pi ");
    }
  });
});
