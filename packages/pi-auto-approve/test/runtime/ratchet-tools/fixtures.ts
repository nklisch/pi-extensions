import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AuditLogger } from "../../../src/audit/logger.ts";
import type {
  ResolvedConfig,
  ResolvedReviewerConfig,
} from "../../../src/config/loader.ts";
import type { PackageRegistrationSnapshot } from "../../../src/packs/package-registration.ts";
import { createPackRegistry } from "../../../src/packs/registry.ts";
import type { EffectivePolicy } from "../../../src/policy/core.ts";
import type { ReplayCorpus } from "../../../src/replay/history.ts";
import { proposalNotRunReason } from "../../../src/replay/not-run-reasons.ts";
import { createStructuredProposalBatch } from "../../../src/replay/proposal-batch.ts";
import type {
  AdversarialValidationReport,
  ProposalEvidence,
  ProposalNotRunReasonCode,
  ProposalValidation,
  ProposalValidationCheck,
  ReplayDelta,
  StructuredProposalBatch,
  StructuredRatchetProposal,
} from "../../../src/replay/proposal-schema.ts";
import {
  ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
  PROPOSAL_SCHEMA_VERSION,
  REPLAY_DELTA_SCHEMA_VERSION,
} from "../../../src/replay/proposal-schema.ts";
import type {
  PolicyResolver,
  ResolvedPolicy,
} from "../../../src/runtime/policy-cache.ts";
import {
  createRatchetBatchCache,
  type RatchetBatchCache,
} from "../../../src/runtime/ratchet-tools/batch-cache.ts";
import type { RatchetToolDependencies } from "../../../src/runtime/ratchet-tools/types.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../../fixtures/resolved-config.ts";

export const TEST_CWD = "/repo";
export const GENERATED_AT = "2026-06-27T12:00:00.000Z";

const DEFAULT_REVIEWER: ResolvedReviewerConfig = defaultResolvedReviewer();

export const EMPTY_POLICY: EffectivePolicy = { rules: [] };

export function resolvedConfig(): ResolvedConfig {
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

export function emptyPackageRegistrationSnapshot(): PackageRegistrationSnapshot {
  return {
    requestId: null,
    packs: [],
    issues: [],
  };
}

export function resolvedPolicy(
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

export function dependencies(
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

export function fakeContext(): ExtensionContext {
  return {
    cwd: TEST_CWD,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

export function corpus(): ReplayCorpus {
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

export function evidence(
  overrides: Partial<ProposalEvidence> = {},
): ProposalEvidence {
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

export function validation(
  overrides: Partial<ProposalValidation> = {},
): ProposalValidation {
  return {
    schema: { status: "pass", code: "schema-ok", message: "schema ok" },
    ...overrides,
  };
}

export function proposal(
  kind: StructuredRatchetProposal["kind"] = "data-pack-policy",
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

export function batchWithProposals(
  proposals: readonly StructuredRatchetProposal[],
  options: { readonly warnings?: readonly string[] } = {},
): StructuredProposalBatch {
  return createStructuredProposalBatch({
    generatedAt: GENERATED_AT,
    proposals,
    warnings: options.warnings ?? [],
  });
}

export function cacheWithBatch(batch: StructuredProposalBatch): {
  readonly cache: RatchetBatchCache;
  readonly batchId: string;
} {
  const cache = createRatchetBatchCache();
  return { cache, batchId: cache.store(batch) };
}

export function replayDelta(overrides: Partial<ReplayDelta> = {}): ReplayDelta {
  return {
    version: REPLAY_DELTA_SCHEMA_VERSION,
    status: "passed",
    baseline: {
      totalRecords: 4,
      totalUniqueCommands: 2,
      replayStatusCounts: [{ label: "review", calls: 4, uniqueCommands: 2 }],
      capturedOutcomeCounts: [
        { label: "model-review", calls: 2, uniqueCommands: 1 },
      ],
      sourceCounts: [{ label: "session", calls: 4, uniqueCommands: 2 }],
      modelReviewLoad: { calls: 2, uniqueCommands: 1 },
      lowFidelityCalls: 0,
      redactedCalls: 0,
      unmatchedAuditEntries: 0,
    },
    candidate: {
      totalRecords: 4,
      totalUniqueCommands: 2,
      replayStatusCounts: [
        { label: "fast_path", calls: 2, uniqueCommands: 1 },
        { label: "review", calls: 2, uniqueCommands: 1 },
      ],
      capturedOutcomeCounts: [
        { label: "model-review", calls: 2, uniqueCommands: 1 },
      ],
      sourceCounts: [{ label: "session", calls: 4, uniqueCommands: 2 }],
      modelReviewLoad: { calls: 2, uniqueCommands: 1 },
      lowFidelityCalls: 0,
      redactedCalls: 0,
      unmatchedAuditEntries: 0,
    },
    changedCalls: 2,
    changedUniqueCommands: 1,
    transitions: [
      { transition: "review->fast_path", calls: 2, uniqueCommands: 1 },
    ],
    improvement: {
      reviewToAllowCalls: 2,
      reviewToAllowUniqueCommands: 1,
      reviewReductionPercent: 50,
      remainingReviewCalls: 2,
      unchangedReviewCalls: 2,
    },
    blocked: {
      unknownToolCalls: 0,
      unknownPathCalls: 0,
      sealedFloorBlockCalls: 0,
      activeDenyBlockCalls: 0,
      lowFidelityCalls: 0,
      redactedCalls: 0,
    },
    regressions: [],
    changedFamilies: [
      {
        familyId: "family-1",
        toolName: "bash",
        executable: "pnpm",
        calls: 2,
        uniqueCommands: 1,
        baselineStatusCounts: [
          { label: "review", calls: 2, uniqueCommands: 1 },
        ],
        candidateStatusCounts: [
          { label: "fast_path", calls: 2, uniqueCommands: 1 },
        ],
        transitions: [
          { transition: "review->fast_path", calls: 2, uniqueCommands: 1 },
        ],
        reviewToAllowCalls: 2,
        regressions: [],
        unchangedReviewCalls: 0,
        sealedFloorBlockCalls: 0,
        unknownToolCalls: 0,
        unknownPathCalls: 0,
        sampleRecordIds: ["record-1"],
        sampleCommands: ["pnpm test"],
      },
    ],
    changedRecords: [
      {
        recordId: "record-1",
        command: "pnpm test",
        toolName: "bash",
        familyId: "family-1",
        baselineStatus: "review",
        candidateStatus: "fast_path",
        transition: "review->fast_path",
        baselineReason: "default review",
        candidateRuleId: "allow-pnpm-test",
        candidateReason: "allow local tests",
        fidelity: "high",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

export function notRunReplayDelta(
  reason = "not applicable",
  code?: ProposalNotRunReasonCode,
): ReplayDelta {
  return replayDelta({
    status: "not-run",
    ...(code === undefined
      ? {}
      : { notRun: proposalNotRunReason({ code, message: reason }) }),
    changedCalls: 0,
    changedUniqueCommands: 0,
    transitions: [],
    improvement: {
      reviewToAllowCalls: 0,
      reviewToAllowUniqueCommands: 0,
      reviewReductionPercent: null,
      remainingReviewCalls: 0,
      unchangedReviewCalls: 0,
    },
    regressions: [],
    changedFamilies: [],
    changedRecords: [],
    warnings: [reason],
  });
}

export function adversarialReport(
  proposalId: string,
  overrides: Partial<AdversarialValidationReport> = {},
): AdversarialValidationReport {
  return {
    version: ADVERSARIAL_VALIDATION_SCHEMA_VERSION,
    proposalId,
    status: "passed",
    generatedCaseCount: 0,
    evaluatedCaseCount: 0,
    failedCaseCount: 0,
    skippedCaseCount: 0,
    cases: [],
    results: [],
    warnings: [],
    ...overrides,
  };
}

export function evidenceStateFixtureProposals(): {
  readonly passed: StructuredRatchetProposal;
  readonly failed: StructuredRatchetProposal;
  readonly skipped: StructuredRatchetProposal;
  readonly pending: StructuredRatchetProposal;
} {
  const passed = proposal("data-pack-policy", {
    id: "prop:evidence-passed",
    title: "Passed evidence fixture",
    evidence: evidence({
      replayDelta: replayDelta({ status: "passed" }),
      adversarial: adversarialReport("prop:evidence-passed", {
        status: "passed",
        generatedCaseCount: 2,
        evaluatedCaseCount: 2,
      }),
    }),
    validation: validation({
      replay: validationCheck("pass", "replay-passed"),
      adversarial: validationCheck("pass", "adversarial-passed"),
      trust: validationCheck("pass", "trust-passed"),
    }),
  });

  const failed = proposal("data-pack-policy", {
    id: "prop:evidence-failed",
    title: "Failed evidence fixture",
    evidence: evidence({
      replayDelta: replayDelta({
        status: "regression",
        regressions: [
          {
            transition: "fast_path->review",
            kind: "allow-to-review",
            calls: 1,
            uniqueCommands: 1,
            message: "candidate regresses an existing allow",
          },
        ],
      }),
      adversarial: adversarialReport("prop:evidence-failed", {
        status: "failed",
        generatedCaseCount: 1,
        evaluatedCaseCount: 1,
        failedCaseCount: 1,
      }),
    }),
    validation: validation({
      replay: validationCheck("fail", "replay-regression"),
      adversarial: validationCheck("fail", "adversarial-failed"),
    }),
  });

  const skipped = proposal("reviewer-config", {
    id: "prop:evidence-skipped",
    title: "Skipped evidence fixture",
    evidence: evidence({
      replayDelta: notRunReplayDelta(
        "reviewer-only proposal has no deterministic policy replay",
        "model-evaluation-required",
      ),
      adversarial: adversarialReport("prop:evidence-skipped", {
        status: "not-run",
        notRun: proposalNotRunReason({
          code: "design-input-only",
          message: "adversarial cases do not apply to reviewer guidance",
        }),
        warnings: ["adversarial cases do not apply to reviewer guidance"],
      }),
    }),
    validation: validation({
      replay: validationCheck("skipped", "reviewer-replay-skipped"),
      adversarial: validationCheck("skipped", "adversarial-skipped"),
    }),
  });

  const pending = proposal("package-pack-enablement", {
    id: "prop:evidence-pending",
    title: "Pending evidence fixture",
    warnings: [
      "legacy warning text is intentionally non-authoritative; inspect structured checks",
    ],
    evidence: evidence({
      replayDelta: notRunReplayDelta(
        "package registry snapshot unavailable",
        "package-registry-unavailable",
      ),
      adversarial: adversarialReport("prop:evidence-pending", {
        status: "not-run",
        notRun: proposalNotRunReason({
          code: "package-registry-unavailable",
          message: "package registry snapshot unavailable",
        }),
        generatedCaseCount: 1,
        skippedCaseCount: 1,
        warnings: ["package registry snapshot unavailable"],
      }),
    }),
    validation: validation({
      packageAvailability: validationCheck(
        "pending",
        "package-registry-unavailable",
      ),
      replay: validationCheck("pending", "replay-not-run-pending"),
      adversarial: validationCheck("pending", "adversarial-not-run-pending"),
    }),
  });

  return { passed, failed, skipped, pending };
}

function validationCheck(
  status: ProposalValidationCheck["status"],
  code: string,
): ProposalValidationCheck {
  return { status, code, message: `${code} fixture` };
}
