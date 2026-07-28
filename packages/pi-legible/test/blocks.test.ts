import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { applyRewrites, restoredClones, restoreOriginals, textBlockIndexes } from "../src/blocks.js";

type Content = AssistantMessage["content"];

function content(): Content {
  return [
    { type: "text", text: "first" },
    { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    { type: "text", text: "second" },
    { type: "text", text: "   " },
  ];
}

describe("textBlockIndexes", () => {
  it("finds non-whitespace text blocks in order", () => {
    expect(textBlockIndexes(content())).toEqual([0, 2]);
  });
});

describe("applyRewrites", () => {
  it("replaces only targeted blocks, keeping positions and other blocks", () => {
    const original = content();
    const { content: next, originals } = applyRewrites(original, new Map([[2, "SECOND-REWRITTEN"]]));
    expect(next[0]).toMatchObject({ type: "text", text: "first" });
    expect(next[1]).toMatchObject({ type: "toolCall" });
    expect(next[2]).toMatchObject({ type: "text", text: "SECOND-REWRITTEN" });
    const record = originals.get(2);
    expect(record?.rewritten).toBe("SECOND-REWRITTEN");
    expect(record?.original).toMatchObject({ type: "text", text: "second" });
    // Input array untouched.
    expect((original[2] as { text: string }).text).toBe("second");
  });

  it("strips textSignature from the displayed rewrite but keeps it in the stash", () => {
    const signed: Content = [{ type: "text", text: "signed text", textSignature: "sig-abc" }];
    const { content: next, originals } = applyRewrites(signed, new Map([[0, "rewritten"]]));
    expect((next[0] as TextContent).textSignature).toBeUndefined();
    expect(originals.get(0)?.original.textSignature).toBe("sig-abc");
  });

  it("ignores indexes that are not text blocks", () => {
    const { originals } = applyRewrites(content(), new Map([[1, "nope"]]));
    expect(originals.size).toBe(0);
  });
});

describe("restoreOriginals", () => {
  it("restores the full original block when the displayed text still matches the rewrite", () => {
    const signed: Content = [{ type: "text", text: "signed text", textSignature: "sig-abc" }];
    const { content: displayed, originals } = applyRewrites(signed, new Map([[0, "rewritten"]]));
    restoreOriginals(displayed, originals);
    expect(displayed[0]).toEqual({ type: "text", text: "signed text", textSignature: "sig-abc" });
  });

  it("does not restore when the text changed underneath (edit or timestamp collision)", () => {
    const next = content();
    restoreOriginals(next, new Map([[0, { original: { type: "text", text: "STALE" }, rewritten: "some other rewrite" }]]));
    expect((next[0] as TextContent).text).toBe("first");
  });

  it("skips out-of-range and non-text indexes safely", () => {
    const next = content();
    const stale = { original: { type: "text", text: "x" } as TextContent, rewritten: "y" };
    expect(() => restoreOriginals(next, new Map([[99, stale], [1, stale]]))).not.toThrow();
  });
});

describe("restoredClones", () => {
  function message(timestamp: number, text: string) {
    return { role: "assistant", timestamp, content: [{ type: "text", text }] as Content };
  }

  it("restores via clones, leaving the input objects untouched (compaction aliasing guard)", () => {
    const live = message(1, "original");
    const { content: displayed, originals } = applyRewrites(live.content, new Map([[0, "rewritten"]]));
    live.content = displayed;

    const stash = new Map([[1, originals]]);
    const result = restoredClones([live], stash);

    expect((result[0].content[0] as TextContent).text).toBe("original");
    // Live session object unchanged — safe if compaction is cancelled.
    expect((live.content[0] as TextContent).text).toBe("rewritten");
    expect(result[0]).not.toBe(live);
  });

  it("keeps identity for messages without a stash entry", () => {
    const plain = message(1, "no rewrite");
    const result = restoredClones([plain], new Map([[2, new Map()]]));
    expect(result[0]).toBe(plain);
  });
});
