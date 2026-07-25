import { describe, expect, it } from "vitest";
import type { StructuredProposalBatch } from "../../../src/replay/proposal-schema.ts";
import { createRatchetBatchCache } from "../../../src/runtime/ratchet-tools/batch-cache.ts";

function proposalBatch(
  overrides: Record<string, unknown> = {},
): StructuredProposalBatch {
  return {
    version: 1,
    generatedAt: "2026-06-27T00:00:00.000Z",
    source: { warnings: [] },
    proposals: [],
    warnings: [],
    ...overrides,
  } as unknown as StructuredProposalBatch;
}

describe("createRatchetBatchCache", () => {
  it("is empty when created", () => {
    const cache = createRatchetBatchCache();

    expect(cache.get("batch-1")).toBeUndefined();
  });

  it("stores and retrieves batches by generated id", () => {
    const cache = createRatchetBatchCache();
    const batch = proposalBatch();

    const batchId = cache.store(batch);

    expect(batchId).toBe("batch-1");
    expect(cache.get(batchId)).toBe(batch);
  });

  it("returns undefined for unknown ids", () => {
    const cache = createRatchetBatchCache();

    cache.store(proposalBatch());

    expect(cache.get("missing-batch")).toBeUndefined();
  });

  it("uses an existing batch id when the schema supplies one", () => {
    const cache = createRatchetBatchCache();
    const batch = proposalBatch({ id: "from-schema" });

    const batchId = cache.store(batch);

    expect(batchId).toBe("from-schema");
    expect(cache.get("from-schema")).toBe(batch);
  });

  it("replaces an existing batch by id", () => {
    const cache = createRatchetBatchCache();
    const original = proposalBatch();
    const replacement = proposalBatch({ warnings: ["updated"] });
    const batchId = cache.store(original);

    expect(cache.replace(batchId, replacement)).toBe(true);
    expect(cache.get(batchId)).toBe(replacement);
  });

  it("does not replace unknown batch ids", () => {
    const cache = createRatchetBatchCache();
    const replacement = proposalBatch({ warnings: ["updated"] });

    expect(cache.replace("missing-batch", replacement)).toBe(false);
    expect(cache.get("missing-batch")).toBeUndefined();
  });
});
