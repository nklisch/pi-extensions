import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditLogger } from "../../../src/audit/logger.ts";
import type {
  ResolvedConfig,
  ResolvedReviewerConfig,
} from "../../../src/config/loader.ts";
import type { PackageRegistrationSnapshot } from "../../../src/packs/package-registration.ts";
import { createPackRegistry } from "../../../src/packs/registry.ts";
import type { EffectivePolicy } from "../../../src/policy/core.ts";
import type { ReplayCorpus } from "../../../src/replay/history.ts";
import {
  createStructuredProposalBatch,
  getStructuredProposal,
} from "../../../src/replay/proposal-batch.ts";
import { renderStructuredProposalCardMarkdown } from "../../../src/replay/proposal-card.ts";
import type {
  ProposalEvidence,
  ProposalValidation,
  StructuredProposalBatch,
  StructuredRatchetProposal,
} from "../../../src/replay/proposal-schema.ts";
import {
  PROPOSAL_SCHEMA_VERSION,
  validateStructuredProposalBatch,
} from "../../../src/replay/proposal-schema.ts";
import type { RatchetReport } from "../../../src/replay/ratchet.ts";
import type {
  PolicyResolver,
  ResolvedPolicy,
} from "../../../src/runtime/policy-cache.ts";
import {
  createRatchetBatchCache,
  type RatchetBatchCache,
} from "../../../src/runtime/ratchet-tools/batch-cache.ts";
import {
  type AutoReviewerGenerateProposalsDetails,
  type AutoReviewerShowProposalDetails,
  createAutoReviewerGenerateProposalsTool,
  createAutoReviewerShowProposalTool,
  type ProposalGenerationEngines,
} from "../../../src/runtime/ratchet-tools/proposals.ts";
import type { RatchetToolDependencies } from "../../../src/runtime/ratchet-tools/types.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../../fixtures/resolved-config.ts";

const TEST_CWD = "/repo";
const GENERATED_AT = "2026-06-27T12:00:00.000Z";

const DEFAULT_REVIEWER: ResolvedReviewerConfig = defaultResolvedReviewer();

const EMPTY_POLICY: EffectivePolicy = { rules: [] };

afterEach(() => {
  vi.unstubAllEnvs();
});

function resolvedConfig(): ResolvedConfig {
  return {
    version: 1,
    cwd: TEST_CWD,
    mode: "ask",
    unknownToolPosture: "review",
    projectScope: defaultResolvedProjectScope(),
    packEnablement: defaultResolvedPackEnablement(),
    display: defaultResolvedDisplay(),
    globalPacks: [],
    projectPacks: [],
    repoPacks: [],
    trustedProject: {
      trusted: true,
    },
    reviewer: DEFAULT_REVIEWER,

    errors: [],
    warnings: [],
  };
}

function emptyPackageRegistrationSnapshot(): PackageRegistrationSnapshot {
  return {
    requestId: null,
    packs: [],
    issues: [],
  };
}

function resolvedPolicy(
  effectivePolicy: EffectivePolicy = EMPTY_POLICY,
): ResolvedPolicy {
  const config = resolvedConfig();
  return {
    config,
    effectivePolicy,
    registry: createPackRegistry({ resolvedConfig: config }),
    packageRegistration: emptyPackageRegistrationSnapshot(),
    warnings: [],
  };
}

function dependencies(
  policy: ResolvedPolicy = resolvedPolicy(),
): RatchetToolDependencies {
  const policyResolver: PolicyResolver = {
    async resolve() {
      return { ok: true, policy };
    },
    invalidate() {},
  };
  const audit: AuditLogger = { async log() {} };
  return {
    policyResolver,
    packageRegistration: emptyPackageRegistrationSnapshot,
    audit,
  };
}

function fakeContext(): ExtensionContext {
  return {
    cwd: TEST_CWD,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

function corpus(): ReplayCorpus {
  return {
    entries: [],
    sourceSummary: new Map([
      ["session", 0],
      ["audit", 0],
      ["corpus", 0],
    ]),
    unmatchedAuditEntries: 0,
    warnings: [],
  };
}

function report(
  options: { readonly warnings?: readonly string[] } = {},
): RatchetReport {
  return {
    generatedAt: GENERATED_AT,
    corpus: {
      totalCalls: 4,
      totalUnique: 2,
      sources: new Map([
        ["session", 4],
        ["audit", 0],
        ["corpus", 0],
      ]),
      unmatchedAuditEntries: 0,
      warnings: options.warnings ?? ["corpus warning"],
    },
    summary: {
      totalCalls: 4,
      totalUnique: 2,
      fastPathCalls: 0,
      fastPathUnique: 0,
      reviewCalls: 4,
      reviewUnique: 2,
      hardBlockCalls: 0,
      hardBlockUnique: 0,
      byCapturedOutcome: new Map(),
      modelReviewLoad: { calls: 2, unique: 1 },
      redactedCalls: 0,
    },
    topReviewedExecutables: [],
    topFastPathExecutables: [],
    topReviewedCommands: [],
    topHardBlockedCommands: [],
    topContentiousFamilies: [],
    topUnknownTools: [],
    perCommand: [],
  };
}

function evidence(overrides: Partial<ProposalEvidence> = {}): ProposalEvidence {
  return {
    familyIds: ["family-1"],
    recordIds: ["record-1"],
    calls: 4,
    uniqueCommands: 2,
    reviewCalls: 4,
    hardBlockCalls: 0,
    modelReviewCalls: 2,
    capturedDenialCalls: 0,
    replayStatusCounts: [{ label: "review", calls: 4 }],
    capturedOutcomeCounts: [{ label: "model-review", calls: 2 }],
    sampleCommands: ["pnpm test"],
    ...overrides,
  };
}

function validation(
  overrides: Partial<ProposalValidation> = {},
): ProposalValidation {
  return {
    schema: { status: "pass", code: "schema-ok", message: "schema ok" },
    ...overrides,
  };
}

function proposal(
  kind: StructuredRatchetProposal["kind"],
  overrides: Partial<StructuredRatchetProposal> = {},
): StructuredRatchetProposal {
  const base = baseByKind(kind);
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: `prop:${kind}`,
    kind,
    title: `Proposal ${kind}`,
    summary: `Structured proposal for ${kind}`,
    reason: "test proposal reason",
    createdAt: GENERATED_AT,
    provenance: { source: "generated" },
    applicationMode:
      kind === "pack-file-authoring"
        ? "design-input-only"
        : "writable-after-approval",
    evidence: evidence(),
    examples: [{ command: "pnpm test", matches: true }],
    fixtureSuggestions: [],
    validation: validation(),
    trustNotes: [],
    warnings: [],
    ...base,
    ...overrides,
  };
}

function baseByKind(
  kind: StructuredRatchetProposal["kind"],
): Pick<StructuredRatchetProposal, "target" | "change" | "intendedProvenance"> {
  switch (kind) {
    case "data-pack-policy":
      return {
        intendedProvenance: "user-project",
        target: {
          kind: "user-project-overlay",
          path: "/config/project.json",
          projectKey: "project-1",
          projectRoot: TEST_CWD,
        },
        change: {
          kind: "policy-pack",
          packId: "user-project-pnpm",
          ruleId: "allow-pnpm-test",
          effect: "allow",
          reason: "allow local tests",
          match: { program: "pnpm", arg0In: ["test"] },
          rawPackPatch: [{ op: "add", path: "/packs/-", value: {} }],
        },
      };
    case "reviewer-config":
      return {
        intendedProvenance: "user-global",
        target: { kind: "user-global-config", path: "/config/global.json" },
        change: {
          kind: "reviewer-config",
          pointer: "/reviewer/promptPosture",
          op: "set",
          before: "reviewer.strict",
          after: "reviewer.default",
          rendered: "reviewer.promptPosture: strict -> default",
        },
      };
    case "project-scope-config":
      return {
        intendedProvenance: "user-project",
        target: {
          kind: "user-project-overlay",
          path: "/config/project.json",
          projectKey: "project-1",
          projectRoot: TEST_CWD,
        },
        change: {
          kind: "project-scope-config",
          patch: [
            {
              op: "add",
              path: "/projectScope/writableDirectories/-",
              value: "./src",
            },
          ],
        },
      };
    case "package-pack-enablement":
      return {
        intendedProvenance: "user-global",
        target: {
          kind: "package-pack-config",
          path: "/config/global.json",
          packId: "pack:demo",
        },
        change: {
          kind: "package-pack-enablement",
          packId: "pack:demo",
          enable: true,
          metadataWarnings: [],
          plan: {
            id: "plan:demo",
            request: {
              action: "enable",
              scope: "global",
              subject: "package",
              packId: "pack:demo",
            },
            targetPath: "/config/global.json",
            patch: [
              {
                op: "replace",
                path: "/packEnablement/enabledPackagePacks",
                before: [],
                value: ["pack:demo"],
              },
            ],
            before: {
              scope: "global",
              packEnablement: {
                enabledPackagePacks: [],
                disabledPackagePacks: [],
                disabledConfigPacks: [],
              },
              packs: [],
            },
            after: {
              scope: "global",
              packEnablement: {
                enabledPackagePacks: ["pack:demo"],
                disabledPackagePacks: [],
                disabledConfigPacks: [],
              },
              packs: [],
            },
            warnings: [],
            requiredAcknowledgementCodes: [],
          },
        },
      };
    case "pack-file-authoring":
      return {
        intendedProvenance: "shipped",
        target: { kind: "design-input", route: "core-matcher" },
        change: {
          kind: "pack-file-authoring",
          authoringKind: "core-matcher",
          matcherName: "pnpmTest",
          matcherSignature: "pnpmTest(): MatcherExpr",
          rationale: "core matcher design input",
        },
      };
  }
}

function engines(
  options: {
    readonly generatedProposals?: readonly StructuredRatchetProposal[];
    readonly reportWarnings?: readonly string[];
  } = {},
): ProposalGenerationEngines {
  const generated = options.generatedProposals ?? [
    proposal("data-pack-policy"),
  ];
  return {
    clock: () => new Date(GENERATED_AT),
    readCorpus: () => corpus(),
    replayHistory: async () =>
      report(
        options.reportWarnings === undefined
          ? {}
          : { warnings: options.reportWarnings },
      ),
    proposePolicyChanges: async () =>
      generated.filter((item) => item.kind === "data-pack-policy"),
    proposeAuthoringInputs: async () =>
      generated.filter((item) => item.kind === "pack-file-authoring"),
    proposeReviewerConfig: async () =>
      generated.filter((item) => item.kind === "reviewer-config"),
  };
}

async function generate(
  cache: RatchetBatchCache,
  toolEngines: ProposalGenerationEngines,
  params: unknown = {},
): Promise<{
  readonly details: AutoReviewerGenerateProposalsDetails;
  readonly text: string;
}> {
  const tool = createAutoReviewerGenerateProposalsTool(
    dependencies(),
    cache,
    toolEngines,
  );
  const result = await tool.execute(
    "tool-call-1",
    params,
    undefined,
    undefined,
    fakeContext(),
  );
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("expected text result");
  }
  return {
    details: result.details as AutoReviewerGenerateProposalsDetails,
    text: content.text,
  };
}

function cacheWithBatch(batch: StructuredProposalBatch): {
  readonly cache: RatchetBatchCache;
  readonly batchId: string;
} {
  const cache = createRatchetBatchCache();
  return { cache, batchId: cache.store(batch) };
}

describe("clearance_generate_proposals", () => {
  it("returns a batch id, valid batch details, proposal summaries, and stores the batch", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/pi-auto-approve-proposals-test");
    const cache = createRatchetBatchCache();
    const generated = [
      proposal("data-pack-policy"),
      proposal("reviewer-config"),
      proposal("pack-file-authoring"),
    ];

    const { details, text } = await generate(
      cache,
      engines({ generatedProposals: generated }),
      { includeFullShape: true },
    );

    expect(details.batchId).toBe("batch-1");
    expect(details).not.toHaveProperty("batch");
    const cachedBatch = cache.get(details.batchId);
    expect(cachedBatch).not.toBeUndefined();
    if (cachedBatch === undefined) {
      throw new Error("expected generated proposal batch in cache");
    }
    expect(validateStructuredProposalBatch(cachedBatch)).toMatchObject({
      ok: true,
    });
    expect(details.proposalCount).toBe(3);
    expect(details.proposals.map((entry) => entry.id).sort()).toEqual(
      generated.map((entry) => entry.id).sort(),
    );
    expect(details.proposals[0]).toMatchObject({
      id: expect.any(String),
      kind: expect.any(String),
      title: expect.any(String),
      applicationMode: expect.any(String),
      targetSummary: expect.any(String),
      changeSummary: expect.any(String),
    });
    expect(details.counts.byKind).toMatchObject({
      "data-pack-policy": 1,
      "reviewer-config": 1,
      "pack-file-authoring": 1,
    });
    expect(cachedBatch.source.corpusSummary).toMatchObject({
      totalRecords: 4,
      totalUniqueCommands: 2,
      modelReviewLoad: { calls: 2, uniqueCommands: 1 },
    });
    expect(details.warnings).toEqual(["corpus warning"]);
    expect(details.includeFullShape).toEqual({
      requested: true,
      note: expect.stringContaining(
        "structured proposal details remain authoritative",
      ),
    });
    expect(text).toContain("# Clearance proposal batch");
    expect(text).toContain("Batch id: `batch-1`");
  });

  it("returns a valid empty batch with a clear warning when no proposals are generated", async () => {
    const cache = createRatchetBatchCache();

    const { details, text } = await generate(
      cache,
      engines({ generatedProposals: [], reportWarnings: [] }),
    );

    expect(details.batchId).toBe("batch-1");
    expect(details.proposalCount).toBe(0);
    expect(details).not.toHaveProperty("batch");
    const cachedBatch = cache.get(details.batchId);
    expect(cachedBatch).not.toBeUndefined();
    if (cachedBatch === undefined) {
      throw new Error("expected generated proposal batch in cache");
    }
    expect(cachedBatch.proposals).toEqual([]);
    expect(validateStructuredProposalBatch(cachedBatch)).toMatchObject({
      ok: true,
    });
    expect(details.warnings).toEqual([
      "No structured proposals generated from the current ratchet history and policy.",
    ]);
    expect(text).toContain("No structured proposals were generated");
  });

  it("honors a pre-cancelled abort signal without caching a batch", async () => {
    const cache = createRatchetBatchCache();
    const tool = createAutoReviewerGenerateProposalsTool(
      dependencies(),
      cache,
      engines(),
    );
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      "tool-call-1",
      {},
      controller.signal,
      undefined,
      fakeContext(),
    );

    expect(result.details).toMatchObject({
      ok: false,
      error: {
        code: "clearance_tool_error",
        tool: "clearance_generate_proposals",
        message: "clearance tool call aborted",
      },
    });
    expect(cache.get("batch-1")).toBeUndefined();
  });
});

describe("clearance_show_proposal", () => {
  it("returns the exact structured proposal and card markdown from cache", async () => {
    const target = proposal("data-pack-policy");
    const batch = createStructuredProposalBatch({
      generatedAt: GENERATED_AT,
      proposals: [target],
      warnings: ["batch warning"],
    });
    const { cache, batchId } = cacheWithBatch(batch);
    const tool = createAutoReviewerShowProposalTool(cache);

    const result = await tool.execute(
      "tool-call-1",
      { batchId, proposalId: target.id },
      undefined,
      undefined,
      fakeContext(),
    );

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected text result");
    }
    const details = result.details as AutoReviewerShowProposalDetails;
    expect(details).toMatchObject({
      found: true,
      batchId,
      proposalId: target.id,
    });
    if (!details.found) {
      throw new Error("expected found proposal");
    }
    expect(details.proposal).toEqual(getStructuredProposal(batch, target.id));
    expect(details.cardMarkdown).toBe(
      renderStructuredProposalCardMarkdown(target),
    );
    expect(content.text).toBe(renderStructuredProposalCardMarkdown(target));
    expect(details.warnings).toEqual(["batch warning"]);
  });

  it("returns structured not-found details for missing batches and proposals", async () => {
    const emptyCache = createRatchetBatchCache();
    const showMissingBatch = createAutoReviewerShowProposalTool(emptyCache);

    const missingBatchResult = await showMissingBatch.execute(
      "tool-call-1",
      { batchId: "missing-batch", proposalId: "prop:missing" },
      undefined,
      undefined,
      fakeContext(),
    );
    const missingBatchDetails =
      missingBatchResult.details as AutoReviewerShowProposalDetails;
    expect(missingBatchDetails).toMatchObject({
      found: false,
      reason: "batch-not-found",
      batchId: "missing-batch",
      proposalId: "prop:missing",
      knownProposalIds: [],
    });
    expect(missingBatchDetails.warnings[0]).toContain(
      "No cached ratchet proposal batch found",
    );

    const existing = proposal("reviewer-config");
    const batch = createStructuredProposalBatch({
      generatedAt: GENERATED_AT,
      proposals: [existing],
    });
    const { cache, batchId } = cacheWithBatch(batch);
    const showMissingProposal = createAutoReviewerShowProposalTool(cache);

    const missingProposalResult = await showMissingProposal.execute(
      "tool-call-2",
      { batchId, proposalId: "prop:nope" },
      undefined,
      undefined,
      fakeContext(),
    );
    const missingProposalDetails =
      missingProposalResult.details as AutoReviewerShowProposalDetails;
    expect(missingProposalDetails).toMatchObject({
      found: false,
      reason: "proposal-not-found",
      batchId,
      proposalId: "prop:nope",
      knownProposalIds: [existing.id],
    });
    expect(missingProposalDetails.warnings.at(-1)).toContain("No proposal");
  });
});
