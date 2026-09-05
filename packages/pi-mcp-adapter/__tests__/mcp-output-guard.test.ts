import { chmod, mkdtemp, readFile, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardMcpOutput, resolveMcpOutputGuardOptions, type McpResultSummary } from "../mcp-output-guard.ts";

describe("guardMcpOutput", () => {
  it("leaves small MCP output unchanged and keeps the raw result in details", async () => {
    const rawMcpResult = { content: [{ type: "text", text: "small result" }], isError: false, structuredContent: { ok: true } };
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "small result" }],
      { rawMcpResult },
    );

    expect(guarded.content).toEqual([{ type: "text", text: "small result" }]);
    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.mcpResult).toBe(rawMcpResult);
  });

  it("merges prefixes and suffixes into small text output", async () => {
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "upstream failed" }],
      { prefix: "Error: ", suffix: "\n\nExpected parameters:\n{}" },
    );

    expect(guarded.content).toEqual([{ type: "text", text: "Error: upstream failed\n\nExpected parameters:\n{}" }]);
  });

  it("uses the empty text fallback before applying affixes", async () => {
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "" }],
      { prefix: "Error: ", emptyTextFallback: "Tool execution failed" },
    );

    expect(guarded.content).toEqual([{ type: "text", text: "Error: Tool execution failed" }]);

    const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
    const withImage = await guardMcpOutput(
      [image],
      { prefix: "Error: ", emptyTextFallback: "Tool execution failed" },
    );

    expect(withImage.content).toEqual([{ type: "text", text: "Error: Tool execution failed" }, image]);
  });

  it("reuses the full MCP-result spill for recovery when both text and details overflow", async () => {
    const text = Array.from({ length: 20 }, (_, i) => `line-${i} ${"x".repeat(40)}`).join("\n");
    const rawMcpResult = { content: [{ type: "text", text }], isError: false, structuredContent: { rows: [text] } };
    const guarded = await guardMcpOutput(
      [{ type: "text", text }],
      { maxBytes: 300, maxLines: 8, detailsMaxBytes: 200, rawMcpResult },
    );

    expect(guarded.outputGuard).toMatchObject({
      truncated: true,
      originalLines: 20,
    });
    // No second text spill: the complete result spill is the recovery artifact.
    expect(guarded.outputGuard?.fullOutputPath).toBeUndefined();
    expect(guarded.content).toHaveLength(1);
    expect(guarded.content[0]).toMatchObject({ type: "text" });
    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(returnedText).toContain("MCP text output truncated");
    expect(returnedText).toContain("Full MCP result (JSON) saved to:");
    // Honest recovery instructions for one JSON document: JSON-aware local
    // extraction, never a promise of line-offset paging over embedded strings.
    expect(returnedText).toContain("JSON-aware local tools");
    expect(returnedText).not.toContain("use read with offset/limit");
    expect(returnedText).not.toContain("line-19");

    const summary = guarded.mcpResult as McpResultSummary;
    expect(summary).toMatchObject({ omitted: true, isError: false, contentBlocks: 1 });
    expect(summary.fullResultPath).toBeTruthy();
    expect(summary.structuredContent).toMatchObject({ omitted: true });
    expect(JSON.stringify(summary)).not.toContain("line-19");

    // The shared spill holds the complete result — every canonical fact — as
    // readable JSON that line-based recovery tools can address.
    const saved = await readFile(summary.fullResultPath!, "utf8");
    expect(JSON.parse(saved)).toEqual(rawMcpResult);
    expect(saved).toContain("\n");
    expect(returnedText).toContain(summary.fullResultPath!);
  });

  it("keeps the full-text spill as recovery when no raw result is provided", async () => {
    const text = Array.from({ length: 50 }, (_, i) => `row-${i}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], { maxBytes: 250, maxLines: 5 });

    expect(guarded.outputGuard).toMatchObject({ truncated: true });
    expect(guarded.outputGuard?.fullOutputPath).toBeTruthy();
    expect(guarded.mcpResult).toBeUndefined();
    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(returnedText).toContain("Full text saved to:");
    const saved = await readFile(guarded.outputGuard!.fullOutputPath!, "utf8");
    expect(saved).toBe(text);
  });

  it("retains the composed-text spill when affixes add information absent from the raw result", async () => {
    // Adapter suffixes (schema guidance, UI handoff) exist only in the
    // composed text; the raw result JSON cannot recover them. Both spills must
    // exist and the notice must point at the one holding the guidance.
    const text = "r".repeat(60_000);
    const suffix = "\n\nExpected parameters:\nEXPECTED-SCHEMA-CANARY";
    const rawMcpResult = { content: [{ type: "text", text }], isError: false };
    const guarded = await guardMcpOutput(
      [{ type: "text", text }],
      { maxBytes: 10_000, maxLines: 2000, detailsMaxBytes: 1000, prefix: "Error: ", suffix, rawMcpResult },
    );

    // Composed-text spill retained for affix recovery.
    expect(guarded.outputGuard?.fullOutputPath).toBeTruthy();
    const savedText = await readFile(guarded.outputGuard!.fullOutputPath!, "utf8");
    expect(savedText).toContain("Error: ");
    expect(savedText).toContain("EXPECTED-SCHEMA-CANARY");
    // Raw details spill still exists as the canonical-result artifact.
    const summary = guarded.mcpResult as McpResultSummary;
    expect(summary.fullResultPath).toBeTruthy();
    expect(summary.fullResultPath).not.toBe(guarded.outputGuard!.fullOutputPath);
    expect(JSON.parse(await readFile(summary.fullResultPath!, "utf8"))).toEqual(rawMcpResult);
    // Returned content stays bounded; the notice points at the text artifact.
    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(returnedText.length).toBeLessThan(20_000);
    expect(returnedText).toContain("Full text saved to:");
    expect(returnedText).not.toContain("Full output could not be saved");
  });

  it("keeps truthful instructions for text spills with unpagedable lines", async () => {
    const oneHugeLine = "L".repeat(100_000);
    const guarded = await guardMcpOutput([{ type: "text", text: oneHugeLine }], { maxBytes: 1000, maxLines: 2000 });

    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(guarded.outputGuard?.fullOutputPath).toBeTruthy();
    expect(returnedText).toContain("use grep to inspect");
    expect(returnedText).toContain("exceeds read's per-line limit");
    expect(returnedText).not.toContain("use read with offset/limit");
  });

  it("supports bounded JSON-aware recovery from the actual shared spill", async () => {
    const rawMcpResult = {
      content: [{ type: "text", text: "rows attached" }],
      isError: false,
      structuredContent: { correlation_id: "fact-1", rows: "y".repeat(120_000) },
    };
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "rows attached" }],
      { maxBytes: 2000, maxLines: 2000, detailsMaxBytes: 500, rawMcpResult },
    );

    const summary = guarded.mcpResult as McpResultSummary;
    expect(summary.fullResultPath).toBeTruthy();
    const saved = await readFile(summary.fullResultPath!, "utf8");

    // Exactly what a model can do locally with standard Node tooling: select a
    // field and take a bounded slice of a long string value from the spill.
    const recovered = JSON.parse(saved) as typeof rawMcpResult;
    expect(recovered.structuredContent.correlation_id).toBe("fact-1");
    const rowSlice = recovered.structuredContent.rows.slice(0, 200);
    expect(rowSlice).toBe("y".repeat(200));
    expect(rowSlice.length).toBeLessThanOrEqual(200);

    // The model-facing text stays bounded and never inlines the long value.
    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(returnedText.length).toBeLessThan(5000);
    expect(returnedText).not.toContain("yyyyyyy");
  });

  it("keeps image base64 out of the recovery notice and truncated text", async () => {
    const image = { type: "image" as const, data: "IMGBASE64CANARY".repeat(100), mimeType: "image/png" };
    const guarded = await guardMcpOutput(
      [image, { type: "text", text: "z".repeat(60_000) }],
      { maxBytes: 2000, maxLines: 2000, detailsMaxBytes: 500, rawMcpResult: { content: [{ type: "text", text: "z".repeat(60_000) }] } },
    );

    const returnedText = guarded.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n");
    expect(returnedText).not.toContain("IMGBASE64CANARY");
    // The image passes through as native content next to the truncated text.
    expect(guarded.content.some((block) => block.type === "image")).toBe(true);
  });

  it("falls back to the text spill when the result spill write fails", async () => {
    // A read-only TMPDIR makes mkdtemp fail; the guard must still deliver an
    // explicit recovery-unavailable notice instead of a silent loss.
    const lockedDir = await mkdtemp(join(tmpdir(), "pi-mcp-guard-locked-"));
    await chmod(lockedDir, 0o500);
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = lockedDir;
    try {
      const text = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");
      const guarded = await guardMcpOutput(
        [{ type: "text", text }],
        { maxBytes: 200, maxLines: 5, detailsMaxBytes: 100, rawMcpResult: { content: [{ type: "text", text }] } },
      );

      const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
      expect(returnedText).toContain("Full output could not be saved:");
      expect(guarded.outputGuard?.fullOutputPath).toBeUndefined();
      expect((guarded.mcpResult as McpResultSummary).fullResultPath).toBeUndefined();
      expect((guarded.mcpResult as McpResultSummary).resultWriteError).toBeTruthy();
      expect(guarded.outputGuard?.writeError).toBeTruthy();
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await chmod(lockedDir, 0o700);
      await rmdir(lockedDir);
    }
  });

  it("summarizes details.mcpResult only when it exceeds detailsMaxBytes", async () => {
    const rawMcpResult = { content: [{ type: "text", text: "ok" }], isError: false, structuredContent: { rows: "y".repeat(500) } };
    const kept = await guardMcpOutput([{ type: "text", text: "ok" }], { detailsMaxBytes: 5000, rawMcpResult });
    expect(kept.mcpResult).toBe(rawMcpResult);

    const summarized = await guardMcpOutput([{ type: "text", text: "ok" }], { detailsMaxBytes: 100, rawMcpResult });
    expect((summarized.mcpResult as McpResultSummary).omitted).toBe(true);
    expect((summarized.mcpResult as McpResultSummary).fullResultPath).toBeTruthy();
  });

  it("spills the oversized raw result as readable JSON and reports the compact byte size", async () => {
    const rawMcpResult = { content: [{ type: "text", text: "ok" }], isError: false, structuredContent: { rows: "z".repeat(500) } };
    const guarded = await guardMcpOutput([{ type: "text", text: "ok" }], { detailsMaxBytes: 50, rawMcpResult });

    const summary = guarded.mcpResult as McpResultSummary;
    expect(summary.omitted).toBe(true);
    expect(summary.fullResultPath).toBeTruthy();

    const saved = await readFile(summary.fullResultPath!, "utf8");
    expect(JSON.parse(saved)).toEqual(rawMcpResult);
    expect(saved).toContain("\n");
    expect(summary.rawResultBytes).toBe(Buffer.byteLength(JSON.stringify(rawMcpResult), "utf8"));
  });

  it("reports honest final accounting when a tiny details budget is smaller than the notice", async () => {
    const text = "y".repeat(4000);
    const guarded = await guardMcpOutput(
      [{ type: "text", text }],
      { maxBytes: 500, maxLines: 2000, detailsMaxBytes: 10, rawMcpResult: { content: [{ type: "text", text }] } },
    );

    // The recovery notice itself can exceed a tiny configured budget; the
    // guard reports the bytes it actually returned rather than claiming a
    // stricter ceiling than it enforces.
    expect(guarded.outputGuard).toMatchObject({ truncated: true });
    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(guarded.outputGuard!.returnedBytes).toBe(Buffer.byteLength(returnedText, "utf8"));
    expect(returnedText).toContain("Full MCP result (JSON) saved to:");
  });

  it("truncates multibyte text on a byte boundary without introducing replacement characters", async () => {
    // Each line is 8 bytes of 4-byte characters; the byte budget lands mid-character.
    const line = "\u{1F600}\u{1F600}".repeat(500);
    const guarded = await guardMcpOutput([{ type: "text", text: line }], { maxBytes: 1003, maxLines: 2000 });

    expect(guarded.outputGuard).toMatchObject({ truncated: true });
    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(returnedText).not.toContain("\uFFFD");
    expect(Buffer.byteLength(returnedText, "utf8")).toBeLessThanOrEqual(1003 + Buffer.byteLength("\n\n[MCP text output truncated", "utf8") + 400);
  });

  it("passes image blocks through untouched, even large ones", async () => {
    const image = { type: "image" as const, data: "A".repeat(100_000), mimeType: "image/png" };
    const guarded = await guardMcpOutput(
      [image, { type: "text", text: "caption" }],
      { maxBytes: 1000, maxLines: 10 },
    );

    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.content).toEqual([image, { type: "text", text: "caption" }]);
  });

  it("keeps image blocks when text output is truncated", async () => {
    const text = Array.from({ length: 50 }, (_, i) => `row-${i}`).join("\n");
    const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
    const guarded = await guardMcpOutput(
      [{ type: "text", text }, image],
      { maxBytes: 250, maxLines: 5 },
    );

    expect(guarded.outputGuard).toMatchObject({ truncated: true, imageBlocksPassedThrough: 1 });
    expect(guarded.content).toHaveLength(2);
    expect(guarded.content[0].type).toBe("text");
    expect(guarded.content[1]).toEqual(image);

    const saved = await readFile(guarded.outputGuard!.fullOutputPath!, "utf8");
    expect(saved).toBe(text);
  });

  it("truncates on line count alone", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `entry-${i}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], { maxBytes: 10_000, maxLines: 10 });

    expect(guarded.outputGuard).toMatchObject({ truncated: true, originalLines: 30 });
    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(returnedText).toContain("entry-0");
    expect(returnedText).not.toContain("entry-29");
  });

  it("keeps prefixes and suffixes inside the saved full output", async () => {
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "body" }],
      { prefix: "Error: ", suffix: "\n\nExpected parameters:\n{}", maxBytes: 10, maxLines: 2 },
    );

    expect(guarded.outputGuard?.fullOutputPath).toBeTruthy();
    const saved = await readFile(guarded.outputGuard!.fullOutputPath!, "utf8");
    expect(saved).toBe("Error: body\n\nExpected parameters:\n{}");
  });

  it("can be disabled to return raw output and raw details", async () => {
    const text = "x".repeat(1000);
    const rawMcpResult = { content: [{ type: "text", text }], isError: false };
    const guarded = await guardMcpOutput(
      [{ type: "text", text }],
      { enabled: false, maxBytes: 10, maxLines: 1, rawMcpResult },
    );

    expect(guarded.content).toEqual([{ type: "text", text }]);
    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.mcpResult).toBe(rawMcpResult);

    const withPrefix = await guardMcpOutput(
      [{ type: "text", text: "body" }],
      { enabled: false, prefix: "Error: ", rawMcpResult },
    );

    expect(withPrefix.content).toEqual([{ type: "text", text: "Error: body" }]);
  });

  it("returns no mcpResult when rawMcpResult is not provided", async () => {
    const guarded = await guardMcpOutput([{ type: "text", text: "x" }], {});
    expect(guarded.mcpResult).toBeUndefined();
  });
});

describe("resolveMcpOutputGuardOptions", () => {
  it("defaults to enabled with standard limits", () => {
    expect(resolveMcpOutputGuardOptions(undefined)).toEqual({
      enabled: true,
      maxBytes: 50 * 1024,
      maxLines: 2000,
      detailsMaxBytes: 16 * 1024,
    });
  });

  it("supports boolean and object settings", () => {
    expect(resolveMcpOutputGuardOptions({ outputGuard: false }).enabled).toBe(false);
    expect(resolveMcpOutputGuardOptions({ outputGuard: true }).enabled).toBe(true);
    expect(resolveMcpOutputGuardOptions({ outputGuard: { maxBytes: 1234, maxLines: 50 } })).toMatchObject({
      enabled: true,
      maxBytes: 1234,
      maxLines: 50,
      detailsMaxBytes: 16 * 1024,
    });
  });

  it("honors the MCP_OUTPUT_GUARD env kill switch", () => {
    const previous = process.env.MCP_OUTPUT_GUARD;
    try {
      process.env.MCP_OUTPUT_GUARD = "0";
      expect(resolveMcpOutputGuardOptions({ outputGuard: true }).enabled).toBe(false);
      process.env.MCP_OUTPUT_GUARD = "1";
      expect(resolveMcpOutputGuardOptions({ outputGuard: false }).enabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MCP_OUTPUT_GUARD;
      else process.env.MCP_OUTPUT_GUARD = previous;
    }
  });
});
