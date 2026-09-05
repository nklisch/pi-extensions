import { describe, it, expect } from "vitest";
import { resolveMcpResultContent } from "../tool-registrar.ts";

describe("resolveMcpResultContent", () => {
  it("appends distinct structured content when content is present", () => {
    // Regression: the resolver used to suppress structuredContent entirely
    // whenever any content block existed, losing server-provided facts.
    const blocks = resolveMcpResultContent({
      content: [{ type: "text", text: "Captured 1 page (ok)" }],
      structuredContent: { pages: [{ target_id: "p1" }], correlation_id: "c-1" },
    });

    expect(blocks).toEqual([
      { type: "text", text: "Captured 1 page (ok)" },
      {
        type: "text",
        text: `[Structured content]\n${JSON.stringify({ pages: [{ target_id: "p1" }], correlation_id: "c-1" }, null, 2)}`,
      },
    ]);
  });

  it("falls back to structuredContent when content is empty", () => {
    const structured = { status: "available", summary: "## Notes" };
    const blocks = resolveMcpResultContent({
      content: [],
      structuredContent: structured,
    });

    expect(blocks).toEqual([
      { type: "text", text: JSON.stringify(structured, null, 2) },
    ]);
  });

  it("falls back to structuredContent when content is omitted entirely", () => {
    const structured = { value: 42 };
    const blocks = resolveMcpResultContent({ structuredContent: structured });

    expect(blocks).toEqual([
      { type: "text", text: JSON.stringify(structured, null, 2) },
    ]);
  });

  it("returns empty array when both content and structuredContent are absent", () => {
    expect(resolveMcpResultContent({ content: [] })).toEqual([]);
    expect(resolveMcpResultContent({})).toEqual([]);
  });

  it("does not treat null structuredContent as a fallback payload", () => {
    expect(
      resolveMcpResultContent({ content: [], structuredContent: null }),
    ).toEqual([]);
  });

  it("treats an empty structuredContent object as a present payload", () => {
    // guards against a truthy check that would drop a legitimately empty object
    expect(
      resolveMcpResultContent({ content: [], structuredContent: {} }),
    ).toEqual([{ type: "text", text: "{}" }]);
  });

  it("appends an empty structuredContent object alongside existing content", () => {
    const blocks = resolveMcpResultContent({
      content: [{ type: "text", text: "done" }],
      structuredContent: {},
    });

    expect(blocks).toEqual([
      { type: "text", text: "done" },
      { type: "text", text: "[Structured content]\n{}" },
    ]);
  });

  it("preserves images and appends structured facts without base64 duplication", () => {
    const image = { type: "image", data: "AA==", mimeType: "image/png" };
    const blocks = resolveMcpResultContent({
      content: [image],
      structuredContent: { correlation_id: "shot-1" },
    });

    expect(blocks).toEqual([
      image,
      { type: "text", text: '[Structured content]\n{\n  "correlation_id": "shot-1"\n}' },
    ]);
    // The image stays native: no base64 leaks into any text block.
    expect(JSON.stringify(blocks.filter((block) => block.type === "text"))).not.toContain("AA==");
  });

  it("preserves resource links and appends structured facts", () => {
    const blocks = resolveMcpResultContent({
      content: [
        { type: "resource_link", name: "artifact", uri: "krometrail://fixture/artifact" } as never,
      ],
      structuredContent: { range_handle: "r-1" },
    });

    expect(blocks).toEqual([
      { type: "text", text: "[Resource Link: artifact]\nURI: krometrail://fixture/artifact" },
      { type: "text", text: '[Structured content]\n{\n  "range_handle": "r-1"\n}' },
    ]);
  });

  it("suppresses the append only when a whole text block is the same JSON value", () => {
    const structured = { echoed: "round trip" };
    for (const echo of [JSON.stringify(structured), JSON.stringify(structured, null, 2)]) {
      expect(
        resolveMcpResultContent({
          content: [{ type: "text", text: echo }],
          structuredContent: structured,
        }),
      ).toEqual([{ type: "text", text: echo }]);
    }
  });

  it("suppresses the append when any one text block equals the structured value", () => {
    const structured = { echoed: "yes" };
    const blocks = resolveMcpResultContent({
      content: [
        { type: "text", text: "prose context" },
        { type: "text", text: JSON.stringify(structured) },
      ],
      structuredContent: structured,
    });

    expect(blocks).toEqual([
      { type: "text", text: "prose context" },
      { type: "text", text: JSON.stringify(structured) },
    ]);
  });

  it("compares deeply nested values without stack exhaustion", () => {
    // SDK decoding passes depth-2000 JSON, but recursive deep-equality
    // implementations overflow the stack on it, misread the failure as
    // inequality, and then serialize an enormous duplicate. The whole-block
    // comparison must stay depth-tolerant.
    let deepSame = { fact: true } as Record<string, unknown>;
    for (let i = 0; i < 2000; i++) deepSame = { x: deepSame };
    let deepDifferent = { fact: false } as Record<string, unknown>;
    for (let i = 0; i < 2000; i++) deepDifferent = { x: deepDifferent };

    // Same deep value: no duplicate append.
    expect(
      resolveMcpResultContent({
        content: [{ type: "text", text: JSON.stringify(deepSame) }],
        structuredContent: deepSame,
      }),
    ).toHaveLength(1);

    // Distinct deep value: facts still delivered exactly once.
    const distinct = resolveMcpResultContent({
      content: [{ type: "text", text: JSON.stringify(deepDifferent) }],
      structuredContent: deepSame,
    });
    expect(distinct).toHaveLength(2);
    expect(distinct[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"fact": true'),
    });
  });

  it("compares reordered deep keys as the same JSON value", () => {
    let text = '{"c":2,"b":1}';
    let value = { b: 1, c: 2 } as Record<string, unknown>;
    for (let i = 0; i < 300; i++) {
      text = `{"x":${text},"z":${i}}`;
      value = { x: value, z: i };
    }

    expect(
      resolveMcpResultContent({
        content: [{ type: "text", text }],
        structuredContent: value,
      }),
    ).toHaveLength(1);
  });

  it("does not deduplicate prose, substrings, or partial objects", () => {
    const structured = { status: "ok", items: [1, 2, 3] };

    // Prose mentioning the value is not the value.
    expect(
      resolveMcpResultContent({
        content: [{ type: "text", text: `Result: ${JSON.stringify(structured)}` }],
        structuredContent: structured,
      }),
    ).toHaveLength(2);

    // A substring/partial projection is not the value.
    expect(
      resolveMcpResultContent({
        content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }],
        structuredContent: structured,
      }),
    ).toHaveLength(2);

    // Whitespace/formatting differences are still the same JSON value only
    // when the whole block parses equal; reordered keys compare equal.
    expect(
      resolveMcpResultContent({
        content: [{ type: "text", text: '{"items":[1,2,3],"status":"ok"}' }],
        structuredContent: structured,
      }),
    ).toHaveLength(1);
  });

  it("degrades gracefully when structuredContent is not serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const blocks = resolveMcpResultContent({ content: [], structuredContent: circular });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text" });

    // With content present, the failure is an explicit presentation notice,
    // never a thrown error that would turn a dispatched call into a failure.
    const withContent = resolveMcpResultContent({
      content: [{ type: "text", text: "dispatched" }],
      structuredContent: circular,
    });
    expect(withContent).toHaveLength(2);
    expect(withContent[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Structured content could not be presented"),
    });
  });

  it("appends structured facts after transformed non-text blocks", () => {
    const blocks = resolveMcpResultContent({
      content: [
        { type: "audio", mimeType: "audio/wav" } as never,
        { type: "resource", resource: { uri: "file:///tmp/x", text: "data" } } as never,
      ],
      structuredContent: { done: true },
    });

    expect(blocks).toEqual([
      { type: "text", text: "[Audio content: audio/wav]" },
      { type: "text", text: "[Resource: file:///tmp/x]\ndata" },
      { type: "text", text: '[Structured content]\n{\n  "done": true\n}' },
    ]);
  });
});
