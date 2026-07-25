import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createStructuredProposalBatch } from "../../src/replay/proposal-batch.ts";
import { createClearancePresentTool } from "../../src/runtime/proposal-tools/present.ts";
import { createClearanceProposeTool } from "../../src/runtime/proposal-tools/propose.ts";
import { createRatchetBatchCache } from "../../src/runtime/ratchet-tools/batch-cache.ts";
import type { RatchetToolDependencies } from "../../src/runtime/ratchet-tools/types.ts";
import { proposal } from "./ratchet-tools/fixtures.ts";

function noOpDependencies(): RatchetToolDependencies {
  return {
    policyResolver: {
      async resolve() {
        throw new Error("policy resolution should not run for design input");
      },
      invalidate() {},
    },
    packageRegistration: () => ({
      requestId: null,
      packs: [],
      issues: [],
    }),
    audit: { async log() {} },
  } as RatchetToolDependencies;
}

function noUiContext(): ExtensionContext {
  return {
    cwd: "/tmp/project",
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

describe("always-on proposal tools", () => {
  it("proposes valid drafts without invoking filesystem or writers", async () => {
    const cache = createRatchetBatchCache();
    const tool = createClearanceProposeTool(
      noOpDependencies(),
      cache,
      () => new Date("2026-07-23T00:00:00.000Z"),
    );
    const source = proposal("reviewer-config");
    const result = await tool.execute(
      "call",
      {
        drafts: [
          {
            kind: source.kind,
            target: source.target,
            change: source.change,
            title: source.title,
            summary: source.summary,
            reason: source.reason,
            examples: source.examples,
            intendedProvenance: source.intendedProvenance,
          },
        ],
      },
      undefined,
      undefined,
      noUiContext(),
    );

    expect(result.details).toMatchObject({
      ok: true,
      proposalCount: 1,
      batchId: expect.any(String),
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("aborts every proposal without UI and records no write request", async () => {
    const cache = createRatchetBatchCache();
    const batch = createStructuredProposalBatch({
      generatedAt: "2026-07-23T00:00:00.000Z",
      proposals: [proposal("pack-file-authoring")],
    });
    const batchId = cache.store(batch);
    const audit = vi.fn(async () => {});
    const deps = { ...noOpDependencies(), audit: { log: audit } };
    const tool = createClearancePresentTool(deps, cache);
    const result = await tool.execute(
      "call",
      { batchId },
      undefined,
      undefined,
      noUiContext(),
    );

    expect(result.details).toMatchObject({
      ok: true,
      outcomes: [{ decision: "aborted", apply: { status: "not-requested" } }],
    });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("offers the no-corpus override only for genuine no-corpus pending replay", async () => {
    const seenOptionLists: string[][] = [];
    const ctx = {
      cwd: "/tmp/project",
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        async select(_title: string, options: string[]) {
          seenOptionLists.push([...options]);
          return "reject";
        },
        async confirm() {
          return true;
        },
      },
    } as unknown as ExtensionContext;

    async function presentWithReplayMarker(
      notRunCode: string,
    ): Promise<string[][]> {
      seenOptionLists.length = 0;
      const cache = createRatchetBatchCache();
      const source = proposal("data-pack-policy");
      const batch = createStructuredProposalBatch({
        generatedAt: "2026-07-23T00:00:00.000Z",
        proposals: [source],
      });
      const batchId = cache.store(batch);
      const tool = createClearancePresentTool(noOpDependencies(), cache, {
        runReplayProposal: async () => ({
          replayOk: false,
          delta: { status: "not-run" },
          validationCheck: {
            status: "pending",
            code: "replay-delta-not-run-pending",
            message: "replay was not run",
            details: { notRun: { code: notRunCode, message: "not run" } },
          },
          warnings: [],
          updatedProposal: {
            ...source,
            validation: {
              ...source.validation,
              replay: {
                status: "pending",
                code: "replay-delta-not-run-pending",
                message: "replay was not run",
                details: { notRun: { code: notRunCode, message: "not run" } },
              },
            },
          },
        }),
      } as never);
      await tool.execute("call", { batchId }, undefined, undefined, ctx);
      return seenOptionLists;
    }

    const noCorpusOptions = await presentWithReplayMarker("no-captured-corpus");
    expect(noCorpusOptions[0]).toContain("approve all without replay evidence");

    const compileFailedOptions =
      await presentWithReplayMarker("compile-failed");
    expect(compileFailedOptions[0]).not.toContain(
      "approve all without replay evidence",
    );
  });
});
