import { describe, expect, it } from "vitest";

import { formatRatchetToolResult } from "../../../src/runtime/ratchet-tools/result.ts";

describe("formatRatchetToolResult", () => {
  it("wraps text content and preserves details", () => {
    const details = { status: "ok", nested: { count: 1 } };

    const result = formatRatchetToolResult(details, "short output");

    expect(result).toEqual({
      content: [{ type: "text", text: "short output" }],
      details,
    });
    expect(result.details).toBe(details);
    expect(JSON.parse(JSON.stringify(result.details))).toEqual(details);
  });

  it("truncates large content with a stable ratchet notice", () => {
    const details = { status: "large" };
    const text = Array.from(
      { length: 2010 },
      (_, index) => `line-${index}`,
    ).join("\n");

    const result = formatRatchetToolResult(details, text);
    const output = result.content[0].text;

    expect(output).toContain("line-0");
    expect(output).not.toContain("line-2009");
    expect(output).toContain("[ratchet output truncated:");
    expect(result.details).toBe(details);
  });
});
