import { describe, expect, it } from "vitest";
import { NativeDisplayLimits, toSafeDisplayField } from "../../src/application/native-inspection-display.js";

const unsafe = [
  "\u001b]8;;https://evil.invalid\u0007link\u001b]8;;\u0007",
  "\u001b[31mred\u001b[0m",
  "line\r\nnext\tcell",
  "left\u202Eright\u2066tail",
  "bom\uFEFFseparator\u2028next",
  "zero\u200Bwidth\u200Djoin",
  "combinee\u0301",
  `lone-${String.fromCharCode(0xd800)}`,
];

describe("terminal-safe native inspection display", () => {
  it.each(unsafe)("visibly escapes unsafe terminal input", (input) => {
    const field = toSafeDisplayField(input, { maxScalars: 4096 });
    expect(field.escaped).toBe(true);
    expect(field.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect(field.text).not.toContain("\u202E");
    expect(() => JSON.parse(JSON.stringify(field))).not.toThrow();
  });

  it("bounds by scalar count and final escaped representation", () => {
    expect(toSafeDisplayField("😀😀x", { maxScalars: 2 })).toEqual({ text: "😀😀", escaped: false, truncated: true });
    const field = toSafeDisplayField("\u001b".repeat(9000), { maxScalars: 9000 });
    expect(field.text.length).toBeLessThanOrEqual(8192);
    expect(field.truncated).toBe(true);
    expect(field.escaped).toBe(true);
  });

  it("uses named limits at disclosure boundaries", () => {
    const field = toSafeDisplayField("x".repeat(NativeDisplayLimits.labelScalars + 1), { maxScalars: NativeDisplayLimits.labelScalars });
    expect(field.text).toHaveLength(NativeDisplayLimits.labelScalars);
    expect(field.truncated).toBe(true);
  });
});
