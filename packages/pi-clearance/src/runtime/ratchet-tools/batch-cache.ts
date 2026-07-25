import type { StructuredProposalBatch } from "../../replay/proposal-schema.ts";

export type BatchId = string;

export interface RatchetBatchCache {
  readonly store: (batch: StructuredProposalBatch) => BatchId;
  readonly get: (batchId: BatchId) => StructuredProposalBatch | undefined;
  readonly replace: (
    batchId: BatchId,
    batch: StructuredProposalBatch,
  ) => boolean;
}

export function createRatchetBatchCache(): RatchetBatchCache {
  const batches = new Map<BatchId, StructuredProposalBatch>();
  let nextGeneratedId = 1;

  return {
    store(batch) {
      const batchId = readBatchId(batch) ?? `batch-${nextGeneratedId++}`;
      batches.set(batchId, batch);
      return batchId;
    },
    get(batchId) {
      return batches.get(batchId);
    },
    replace(batchId, batch) {
      if (!batches.has(batchId)) {
        return false;
      }
      batches.set(batchId, batch);
      return true;
    },
  };
}

function readBatchId(batch: StructuredProposalBatch): BatchId | undefined {
  const id = (batch as { readonly id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
