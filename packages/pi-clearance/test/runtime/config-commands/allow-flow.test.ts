import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createDefaultAnalyzerRegistry } from "../../../src/parse/registry.ts";
import { handleAllowCommand } from "../../../src/runtime/config-commands/allow.ts";
import type {
  AutoReviewerCommandDependencies,
  CommandPi,
} from "../../../src/runtime/config-commands/types.ts";
import type { ResolvedPolicy } from "../../../src/runtime/policy-cache.ts";
import { defaultValidateDraftMatcherAndFloor } from "../../../src/runtime/proposal-tools/apply-engine.ts";
import { createClearancePresentTool } from "../../../src/runtime/proposal-tools/present.ts";
import { createClearanceProposeTool } from "../../../src/runtime/proposal-tools/propose.ts";
import { createRatchetBatchCache } from "../../../src/runtime/ratchet-tools/batch-cache.ts";
import type { RatchetToolDependencies } from "../../../src/runtime/ratchet-tools/types.ts";
import { replayDelta } from "../ratchet-tools/fixtures.ts";

const DRAFT = {
  kind: "data-pack-policy",
  target: { kind: "user-global-config", path: "$.packs" },
  change: {
    kind: "policy-pack",
    packId: "user.allowances",
    ruleId: "allow-pnpm-test",
    effect: "allow",
    reason: "routine test runner",
    match: { all: [{ program: "pnpm" }, { arg0In: ["test"] }] },
    rawPackPatch: [],
  },
  title: "Allow pnpm test",
  summary: "Allow pnpm test runs.",
  reason: "The user asked to allow the pnpm test family.",
  examples: [{ command: "pnpm test", matches: true }],
  intendedProvenance: "user-global",
} as const;

function fakePolicy(): ResolvedPolicy {
  return {
    config: {
      mode: "ask",
      unknownToolPosture: "allow",
      cwd: "/repo",
    },
    effectivePolicy: { floor: [], active: [] },
  } as unknown as ResolvedPolicy;
}

function uiContext(): ExtensionContext & ExtensionCommandContext {
  return {
    cwd: "/repo",
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      async select(_title: string, options: string[]) {
        return options.includes("approve all") ? "approve all" : options[0];
      },
      async confirm() {
        return true;
      },
    },
  } as unknown as ExtensionContext & ExtensionCommandContext;
}

describe("/clearance allow end-to-end flow", () => {
  it("handoff → propose → present → approve writes without any reviewer call", async () => {
    const ctx = uiContext();
    const auditEntries: { entryType?: string }[] = [];
    const audit = {
      async log(entry: { entryType?: string }) {
        auditEntries.push(entry);
      },
    };

    // Step 1: the command hands a deterministic brief to the agent.
    const sendUserMessage = vi.fn(
      async (_brief: string, _options?: unknown) => {},
    );
    const pi = { sendUserMessage } as unknown as CommandPi;
    const allowDeps = {
      policyResolver: {
        async resolve() {
          return { ok: true as const, policy: fakePolicy() };
        },
        invalidate() {},
      },
      recentDecisionSource: { readRecent: () => ({ items: [] }) },
      analyzerRegistry: createDefaultAnalyzerRegistry(),
    } as unknown as AutoReviewerCommandDependencies;

    const report = await handleAllowCommand(
      ["pnpm", "test"],
      ctx,
      pi,
      allowDeps,
      "pnpm test",
    );
    expect(report.details.kind).toBe("handoff");
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const brief = sendUserMessage.mock.calls[0]?.[0] as string;
    expect(brief).toContain("pnpm test");
    expect(brief).toContain("clearance_propose");

    // Step 2: the agent authors a draft and presents it. The proposal path
    // never constructs a reviewer adapter, so any reviewer.decision audit
    // entry here would prove a leak.
    const ratchetDeps = {
      policyResolver: {
        async resolve() {
          return { ok: true as const, policy: fakePolicy() };
        },
        invalidate() {},
      },
      packageRegistration: () => ({
        requestId: null,
        packs: [],
        issues: [],
      }),
      audit,
    } as unknown as RatchetToolDependencies;

    const cache = createRatchetBatchCache();
    const propose = createClearanceProposeTool(
      ratchetDeps,
      cache,
      () => new Date("2026-07-23T00:00:00.000Z"),
    );
    const proposed = await propose.execute(
      "call",
      { drafts: [DRAFT] },
      undefined,
      undefined,
      ctx,
    );
    const batchId = (proposed.details as { batchId: string }).batchId;
    expect(typeof batchId).toBe("string");

    const applySpy = vi.fn(async () => ({
      ok: true as const,
      changed: true,
      planId: "plan:test",
      appliedOperations: 1,
      warnings: [],
      errors: [],
    }));
    const present = createClearancePresentTool(ratchetDeps, cache, {
      validateDraftMatcherAndFloor: defaultValidateDraftMatcherAndFloor,
      runReplayProposal: async ({ proposal }) =>
        ({
          replayOk: true,
          delta: replayDelta(),
          validationCheck: {
            status: "pass",
            code: "replay-delta-passed",
            message: "replay passed",
          },
          warnings: [],
          updatedProposal: {
            ...proposal,
            validation: {
              ...proposal.validation,
              replay: {
                status: "pass",
                code: "replay-delta-passed",
                message: "replay passed",
              },
            },
          },
        }) as never,
      validateStructuredProposalAdversarial: async ({ proposal }) =>
        ({
          version: 1,
          status: "passed",
          proposalId: proposal.id,
          generatedCaseCount: 1,
          evaluatedCaseCount: 1,
          failedCaseCount: 0,
          skippedCaseCount: 0,
          cases: [],
          results: [],
          warnings: [],
        }) as never,
      materializeRatchetProposalWritePlan: () =>
        ({
          ok: true as const,
          writePlan: {
            kind: "config-command",
            plan: { id: "plan:test" },
            acknowledgement: { confirmedPlanId: "plan:test" },
          },
        }) as never,
      createWriterDependencies: () =>
        ({
          validatePostWrite: async (config: unknown) => ({
            ok: true as const,
            config,
          }),
        }) as never,
      applyConfigCommandPlan: applySpy as never,
      runPostWriteReplay: async () =>
        ({
          status: "passed",
          proposalId: "draft:test",
          applicable: false,
          warnings: [],
        }) as never,
    });

    const presented = await present.execute(
      "call",
      { batchId },
      undefined,
      undefined,
      ctx,
    );
    expect(presented.details).toMatchObject({ ok: true });
    expect(applySpy).toHaveBeenCalledTimes(1);

    // The whole allow path is observable in the audit log: proposal decisions
    // exist, and no reviewer (model or human) decision was ever recorded.
    expect(auditEntries.length).toBeGreaterThan(0);
    expect(
      auditEntries.filter((entry) => entry.entryType === "reviewer.decision"),
    ).toEqual([]);
  });
});
