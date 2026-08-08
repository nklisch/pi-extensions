import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  type ConfigCommandApplyResult,
  type ConfigCommandWriterDependencies,
  applyConfigCommandPlan as defaultApplyConfigCommandPlan,
} from "../../config/config-command-writer.ts";
import type { PackEnablementPlan } from "../../packs/enablement.ts";
import {
  applyPackEnablementCommand as defaultApplyPackEnablementCommand,
  type PackEnablementCommandApplyDependencies,
  type PackEnablementCommandApplyResult,
} from "../../packs/enablement-command.ts";
import { compileMatch } from "../../policy/core.ts";
import {
  validateStructuredProposalAdversarial as defaultValidateStructuredProposalAdversarial,
  proposalWithAdversarialReport,
} from "../../replay/adversarial.ts";
import {
  evaluateProposalApprovalGate,
  type ProposalApprovalFailure,
  type ProposalApprovalGateResult,
} from "../../replay/proposal-approval.ts";
import type {
  ProposalValidationCheck,
  StructuredRatchetProposal,
} from "../../replay/proposal-schema.ts";
import {
  materializeRatchetProposalWritePlan as defaultMaterializeRatchetProposalWritePlan,
  type RatchetProposalWritePlan,
  type RatchetProposalWritePlanResult,
} from "../../replay/proposal-write-plan.ts";
import { checkAgainstFloor } from "../../replay/proposals.ts";
import { refreshOperatorStatus } from "../config-commands/types.ts";
import {
  composeConfigCommandPostWritePolicy,
  createExtensionContextConfigCommandWriterDependencies,
} from "../config-commands/post-write-validation.ts";
import { resolveRatchetPolicy } from "../ratchet-tools/analysis.ts";
import type { RatchetBatchCache } from "../ratchet-tools/batch-cache.ts";
import {
  packageAvailabilityValidationCheck,
  packageNotRunAdversarialReport,
  resolvePackageCandidateForProposal,
} from "../ratchet-tools/package-candidates.ts";
import {
  runPostWriteReplay as defaultRunPostWriteReplay,
  isPostWriteReplayApplicable,
  notApplicablePostWriteReplay,
  notRunPostWriteReplay,
  type PostWriteReplayResult,
} from "../ratchet-tools/post-write-replay.ts";
import {
  replaceCachedProposal,
  runReplayProposal,
} from "../ratchet-tools/replay.ts";
import { throwIfAborted } from "../ratchet-tools/result.ts";
import type { RatchetToolDependencies } from "../ratchet-tools/types.ts";

export type ProposalPresentationDecision =
  | "accept"
  | "accept-without-replay"
  | "reject"
  | "revise"
  | "skip"
  | "aborted";

export type ProposalApplyStatus =
  | "not-requested"
  | "design-input-only"
  | "applied"
  | "no-op"
  | "refused"
  | "failed";

export interface ProposalApplyDetails {
  readonly status: ProposalApplyStatus;
  readonly writerKind?: "config-command" | "pack-enablement";
  readonly planId?: string;
  readonly targetPath?: string;
  readonly backupPath?: string;
  readonly changed?: boolean;
  readonly wrote?: boolean;
  readonly restored?: boolean;
  readonly reason?: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ProposalPresentationEngines {
  readonly applyConfigCommandPlan?: typeof defaultApplyConfigCommandPlan;
  readonly applyPackEnablementCommand?: typeof defaultApplyPackEnablementCommand;
  readonly createWriterDependencies?: (
    ctx: ExtensionContext,
    deps: RatchetToolDependencies,
  ) => ConfigCommandWriterDependencies;
  readonly materializeRatchetProposalWritePlan?: typeof defaultMaterializeRatchetProposalWritePlan;
  readonly runReplayProposal?: typeof runReplayProposal;
  readonly runPostWriteReplay?: typeof defaultRunPostWriteReplay;
  readonly validateStructuredProposalAdversarial?: typeof defaultValidateStructuredProposalAdversarial;
  readonly validateDraftMatcherAndFloor?: typeof defaultValidateDraftMatcherAndFloor;
}

export async function resolveApprovalAndApply(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly batchCache: RatchetBatchCache;
  readonly batchId: string;
  readonly batch: Parameters<typeof replaceCachedProposal>[2];
  readonly proposal: StructuredRatchetProposal;
  readonly decision: ProposalPresentationDecision;
  readonly engines: ProposalPresentationEngines;
  readonly signal: AbortSignal | undefined;
}): Promise<{
  readonly proposal: StructuredRatchetProposal;
  readonly batchWarnings: readonly string[];
  readonly approval: ProposalApprovalGateResult;
  readonly approvalWarnings: readonly string[];
  readonly apply: ProposalApplyDetails;
  readonly postWriteReplay: PostWriteReplayResult;
}> {
  if (
    input.decision !== "accept" &&
    input.decision !== "accept-without-replay"
  ) {
    const approval = evaluateProposalApprovalGate({
      proposal: input.proposal,
      decision: input.decision,
    });
    return {
      proposal: input.proposal,
      batchWarnings: input.batch.warnings,
      approval,
      approvalWarnings: approval.warnings,
      apply: notRequestedApply(),
      postWriteReplay: notApplicablePostWriteReplay(
        input.proposal,
        `${input.decision} decision did not request a config write`,
      ),
    };
  }

  const evidence = await fillRequiredApprovalEvidence(input);
  throwIfAborted(input.signal);

  if (evidence.failures.length > 0) {
    const approval: ProposalApprovalGateResult = {
      ok: false,
      route: "no-write",
      failures: evidence.failures,
      warnings: evidence.warnings,
    };
    return {
      proposal: evidence.proposal,
      batchWarnings: evidence.batchWarnings,
      approval,
      approvalWarnings: approval.warnings,
      apply: refusedApply({
        reason: "approval evidence could not be completed",
        errors: evidence.failures.map((failure) => failure.message),
        warnings: approval.warnings,
      }),
      postWriteReplay: notRunPostWriteReplay(
        evidence.proposal,
        "approval evidence could not be completed before writing",
      ),
    };
  }

  const approval = evaluateProposalApprovalGate({
    proposal: evidence.proposal,
    decision: input.decision,
  });
  if (!approval.ok) {
    return {
      proposal: evidence.proposal,
      batchWarnings: evidence.batchWarnings,
      approval,
      approvalWarnings: approval.warnings,
      apply: refusedApply({
        reason: "approval gate refused proposal",
        errors: approval.failures.map(formatApprovalFailure),
        warnings: approval.warnings,
      }),
      postWriteReplay: notRunPostWriteReplay(
        evidence.proposal,
        "approval gate refused the proposal before writing",
      ),
    };
  }

  if (approval.route === "design-input-only") {
    return {
      proposal: evidence.proposal,
      batchWarnings: evidence.batchWarnings,
      approval,
      approvalWarnings: approval.warnings,
      apply: {
        status: "design-input-only",
        reason:
          "proposal was accepted as design input only; no config writer was invoked",
        errors: [],
        warnings: approval.warnings,
      },
      postWriteReplay: notApplicablePostWriteReplay(
        evidence.proposal,
        "design-input-only approvals do not write config",
      ),
    };
  }

  if (approval.route !== "writable") {
    return {
      proposal: evidence.proposal,
      batchWarnings: evidence.batchWarnings,
      approval,
      approvalWarnings: approval.warnings,
      apply: notRequestedApply(approval.warnings),
      postWriteReplay: notApplicablePostWriteReplay(
        evidence.proposal,
        "approval route did not request a config write",
      ),
    };
  }

  const applyResult = await applyAcceptedWritableProposal({
    ctx: input.ctx,
    deps: input.deps,
    proposal: evidence.proposal,
    engines: input.engines,
  });
  return {
    proposal: evidence.proposal,
    batchWarnings: evidence.batchWarnings,
    approval,
    approvalWarnings: approval.warnings,
    apply: applyResult.apply,
    postWriteReplay: applyResult.postWriteReplay,
  };
}

export async function fillRequiredApprovalEvidence(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly batchCache: RatchetBatchCache;
  readonly batchId: string;
  readonly batch: Parameters<typeof replaceCachedProposal>[2];
  readonly proposal: StructuredRatchetProposal;
  readonly engines: ProposalPresentationEngines;
  readonly signal: AbortSignal | undefined;
}): Promise<{
  readonly proposal: StructuredRatchetProposal;
  readonly batchWarnings: readonly string[];
  readonly warnings: readonly string[];
  readonly failures: readonly ProposalApprovalFailure[];
}> {
  let proposal = input.proposal;
  let batch = input.batch;
  const failures: ProposalApprovalFailure[] = [];
  const warnings: string[] = [];
  let replayEvidenceUpdated = false;

  // A draft's schema slot is pending by contract. Promote it only after the
  // canonical transport has crossed this read-only validation boundary; this
  // does not claim matcher, floor, replay, or adversarial safety.
  if (proposal.validation.schema.status === "pending") {
    const schemaCheckedProposal = {
      ...proposal,
      validation: {
        ...proposal.validation,
        schema: {
          status: "pass" as const,
          code: "proposal-schema-ok",
          message: "proposal conforms to the structured proposal schema",
        },
      },
    };
    const replacement = replaceCachedProposal(
      input.batchCache,
      input.batchId,
      batch,
      schemaCheckedProposal,
    );
    proposal = replacement.proposal;
    batch = replacement.batch;
  }

  // Draft-authored policy proposals carry pending matcherCompile/floorOverlap
  // checks by contract; fill the deterministic local checks before replay so
  // the approval gate can actually pass a well-formed draft.
  if (
    proposal.kind === "data-pack-policy" &&
    proposal.change.kind === "policy-pack" &&
    (proposal.validation.matcherCompile?.status === "pending" ||
      proposal.validation.floorOverlap?.status === "pending")
  ) {
    const validateDraft =
      input.engines.validateDraftMatcherAndFloor ??
      defaultValidateDraftMatcherAndFloor;
    const filled = await validateDraft({
      ctx: input.ctx,
      deps: input.deps,
      proposal,
    });
    warnings.push(...filled.warnings);
    const replacement = replaceCachedProposal(
      input.batchCache,
      input.batchId,
      batch,
      filled.proposal,
    );
    proposal = replacement.proposal;
    batch = replacement.batch;
  }

  if (shouldRunReplayBeforeApproval(proposal)) {
    try {
      throwIfAborted(input.signal);
      const runReplay = input.engines.runReplayProposal ?? runReplayProposal;
      const replay = await runReplay({
        ctx: input.ctx,
        deps: input.deps,
        proposal,
      });
      const replacement = replaceCachedProposal(
        input.batchCache,
        input.batchId,
        batch,
        replay.updatedProposal,
      );
      proposal = replacement.proposal;
      batch = replacement.batch;
      replayEvidenceUpdated = true;
      warnings.push(...replay.warnings);
    } catch (error: unknown) {
      failures.push({
        code: "approval-replay-evidence-failed",
        message: `replay evidence could not be completed before approval: ${errorMessage(error)}`,
        check: "replay",
      });
    }
  }

  if (!replayEvidenceUpdated && isPackagePackEnablementProposal(proposal)) {
    try {
      throwIfAborted(input.signal);
      const policy = await resolveRatchetPolicy(input.ctx, input.deps);
      const packageCandidate = resolvePackageCandidateForProposal({
        proposal,
        policy,
      });
      const check = packageAvailabilityValidationCheck(packageCandidate);
      const updatedProposal = withPackageAvailabilityCheck(proposal, check);
      const replacement = replaceCachedProposal(
        input.batchCache,
        input.batchId,
        batch,
        updatedProposal,
      );
      proposal = replacement.proposal;
      batch = replacement.batch;
      if (packageCandidate?.ok === false) {
        warnings.push(packageCandidate.reason.message);
      }
    } catch (error: unknown) {
      failures.push({
        code: "approval-package-evidence-failed",
        message: `package candidate evidence could not be resolved before approval: ${errorMessage(error)}`,
        check: "packageAvailability",
      });
    }
  }

  if (shouldRunAdversarialBeforeApproval(proposal)) {
    try {
      throwIfAborted(input.signal);
      const policy = await resolveRatchetPolicy(input.ctx, input.deps);
      const packageCandidate = resolvePackageCandidateForProposal({
        proposal,
        policy,
      });
      const validateAdversarial =
        input.engines.validateStructuredProposalAdversarial ??
        defaultValidateStructuredProposalAdversarial;
      const report =
        packageCandidate?.ok === false
          ? packageNotRunAdversarialReport({
              proposalId: proposal.id,
              reason: packageCandidate.reason,
            })
          : await validateAdversarial({
              proposal,
              baselinePolicy: policy.effectivePolicy,
              ...(packageCandidate?.ok === true
                ? { candidatePack: packageCandidate.candidatePack }
                : {}),
              pathFacts: {
                cwd: policy.config.cwd,
                projectScope: policy.config.projectScope,
              },
            });
      const proposalWithReport = withPackageAvailabilityCheck(
        proposalWithAdversarialReport(proposal, report),
        packageAvailabilityValidationCheck(packageCandidate),
      );
      const replacement = replaceCachedProposal(
        input.batchCache,
        input.batchId,
        batch,
        proposalWithReport,
      );
      proposal = replacement.proposal;
      batch = replacement.batch;
      warnings.push(...report.warnings);
    } catch (error: unknown) {
      failures.push({
        code: "approval-adversarial-evidence-failed",
        message: `adversarial evidence could not be completed before approval: ${errorMessage(error)}`,
        check: "adversarial",
      });
    }
  }

  return {
    proposal,
    batchWarnings: batch.warnings,
    warnings: stableUnique([...warnings, ...proposal.warnings]),
    failures,
  };
}

function isPackagePackEnablementProposal(
  proposal: StructuredRatchetProposal,
): boolean {
  return (
    proposal.kind === "package-pack-enablement" &&
    proposal.change.kind === "package-pack-enablement"
  );
}

function withPackageAvailabilityCheck(
  proposal: StructuredRatchetProposal,
  check: ProposalValidationCheck | undefined,
): StructuredRatchetProposal {
  if (check === undefined) {
    return proposal;
  }
  return {
    ...proposal,
    validation: {
      ...proposal.validation,
      packageAvailability: check,
    },
  };
}

function shouldRunReplayBeforeApproval(
  proposal: StructuredRatchetProposal,
): boolean {
  if (proposal.applicationMode === "design-input-only") {
    return false;
  }
  if (proposal.validation.replay?.status === "pass") {
    return false;
  }
  if (proposal.validation.replay?.status === "fail") {
    return false;
  }

  switch (proposal.kind) {
    case "data-pack-policy":
    case "project-scope-config":
    case "package-pack-enablement":
      return true;
    case "reviewer-config":
    case "pack-file-authoring":
      return false;
  }
}

function shouldRunAdversarialBeforeApproval(
  proposal: StructuredRatchetProposal,
): boolean {
  if (
    proposal.applicationMode === "design-input-only" ||
    proposal.target.kind === "design-input" ||
    proposal.kind !== "data-pack-policy" ||
    proposal.change.kind !== "policy-pack" ||
    proposal.change.effect !== "allow"
  ) {
    return false;
  }
  if (proposal.validation.adversarial?.status === "pass") {
    return false;
  }
  return proposal.validation.adversarial?.status !== "fail";
}

interface TransactionalPostWriteReplayRecorder {
  result?: PostWriteReplayResult;
}

export async function applyAcceptedWritableProposal(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly proposal: StructuredRatchetProposal;
  readonly engines: ProposalPresentationEngines;
}): Promise<{
  readonly apply: ProposalApplyDetails;
  readonly postWriteReplay: PostWriteReplayResult;
}> {
  const beforePolicy = await resolveRatchetPolicy(input.ctx, input.deps);
  const materialize =
    input.engines.materializeRatchetProposalWritePlan ??
    defaultMaterializeRatchetProposalWritePlan;
  const writePlanResult = materialize({
    proposal: input.proposal,
    resolvedConfig: beforePolicy.config,
    cwd: input.ctx.cwd,
  });
  if (!writePlanResult.ok) {
    return {
      apply: writePlanRefusal(writePlanResult),
      postWriteReplay: notRunPostWriteReplay(
        input.proposal,
        "proposal could not be materialized as a writer plan",
      ),
    };
  }

  const replayRecorder: TransactionalPostWriteReplayRecorder = {};
  const writerDependencies = withTransactionalPostWriteReplay({
    base: (
      input.engines.createWriterDependencies ??
      createExtensionContextConfigCommandWriterDependencies
    )(input.ctx, input.deps),
    ctx: input.ctx,
    deps: input.deps,
    proposal: input.proposal,
    beforePolicy,
    engines: input.engines,
    recorder: replayRecorder,
  });
  const apply = await applyMaterializedWritePlan({
    ctx: input.ctx,
    deps: input.deps,
    writePlan: writePlanResult.writePlan,
    writerDependencies,
    engines: input.engines,
  });
  const postWriteReplay = await resolvePostWriteReplayAfterApply({
    ctx: input.ctx,
    deps: input.deps,
    proposal: input.proposal,
    beforePolicy,
    apply,
    engines: input.engines,
    ...(replayRecorder.result === undefined
      ? {}
      : { transactionReplay: replayRecorder.result }),
  });
  if (apply.status === "applied" && apply.changed === true) {
    try {
      const refreshed = await resolveRatchetPolicy(input.ctx, input.deps);
      refreshOperatorStatus(input.ctx, input.deps, refreshed);
    } catch {
      // The durable writer and post-write validation have already settled.
      // Footer refresh remains advisory and cannot change the apply result.
    }
  }
  return {
    apply: applyWithPostWriteReplay(apply, postWriteReplay),
    postWriteReplay,
  };
}

async function applyMaterializedWritePlan(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly writePlan: RatchetProposalWritePlan;
  readonly writerDependencies: ConfigCommandWriterDependencies;
  readonly engines: ProposalPresentationEngines;
}): Promise<ProposalApplyDetails> {
  switch (input.writePlan.kind) {
    case "config-command": {
      const applyConfig =
        input.engines.applyConfigCommandPlan ?? defaultApplyConfigCommandPlan;
      const result = await applyConfig(
        input.writePlan.plan,
        input.writePlan.acknowledgement,
        input.writerDependencies,
      );
      if (result.ok && result.changed) {
        input.deps.policyResolver.invalidate(input.ctx.cwd);
      }
      return configApplyDetails(result);
    }
    case "pack-enablement": {
      const applyPack =
        input.engines.applyPackEnablementCommand ??
        defaultApplyPackEnablementCommand;
      const result = await applyPack(
        {
          plan: input.writePlan.plan as PackEnablementPlan,
          acknowledgement: input.writePlan.acknowledgement,
        },
        packEnablementApplyDependencies({
          ctx: input.ctx,
          deps: input.deps,
          writerDependencies: input.writerDependencies,
        }),
      );
      return packEnablementApplyDetails(result);
    }
  }
}

function withTransactionalPostWriteReplay(input: {
  readonly base: ConfigCommandWriterDependencies;
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly proposal: StructuredRatchetProposal;
  readonly beforePolicy: Awaited<ReturnType<typeof resolveRatchetPolicy>>;
  readonly engines: ProposalPresentationEngines;
  readonly recorder: TransactionalPostWriteReplayRecorder;
}): ConfigCommandWriterDependencies {
  return {
    ...input.base,
    validatePostWrite: async (config) => {
      const base = await input.base.validatePostWrite(config);
      if (!base.ok) {
        return base;
      }

      const replay = await runTransactionalPostWriteReplay({
        ctx: input.ctx,
        deps: input.deps,
        proposal: input.proposal,
        beforePolicy: input.beforePolicy,
        resolvedConfig: config,
        engines: input.engines,
      });
      input.recorder.result = replay;

      if (postWriteReplayBlocksWrite(replay)) {
        return {
          ok: false,
          errors: postWriteReplayFailureErrors(replay),
        };
      }

      return {
        ok: true,
        warnings: stableUnique([...(base.warnings ?? []), ...replay.warnings]),
      };
    },
  };
}

async function runTransactionalPostWriteReplay(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly proposal: StructuredRatchetProposal;
  readonly beforePolicy: Awaited<ReturnType<typeof resolveRatchetPolicy>>;
  readonly resolvedConfig: Awaited<
    ReturnType<ConfigCommandWriterDependencies["reloadConfig"]>
  >;
  readonly engines: ProposalPresentationEngines;
}): Promise<PostWriteReplayResult> {
  if (!isPostWriteReplayApplicable(input.proposal)) {
    return notApplicablePostWriteReplay(
      input.proposal,
      "proposal kind is not a deterministic post-write replay target",
    );
  }

  const afterPolicy = await composeConfigCommandPostWritePolicy(
    input.resolvedConfig,
    input.deps,
  );
  if (!afterPolicy.ok) {
    return {
      status: "failed",
      proposalId: input.proposal.id,
      applicable: true,
      reason: `post-write replay could not compose the updated policy: ${afterPolicy.errors.join("; ")}`,
      warnings: [],
    };
  }

  try {
    const runPostWriteReplay =
      input.engines.runPostWriteReplay ?? defaultRunPostWriteReplay;
    return await runPostWriteReplay({
      proposal: input.proposal,
      beforePolicy: input.beforePolicy,
      afterPolicy: afterPolicy.policy,
      ctx: input.ctx,
      deps: input.deps,
    });
  } catch (error: unknown) {
    return {
      status: "failed",
      proposalId: input.proposal.id,
      applicable: true,
      reason: `post-write replay failed during post-write validation: ${errorMessage(error)}`,
      warnings: [],
    };
  }
}

function postWriteReplayBlocksWrite(replay: PostWriteReplayResult): boolean {
  return (
    replay.status === "regression" ||
    replay.status === "failed" ||
    (replay.applicable && replay.status === "not-run")
  );
}

function packEnablementApplyDependencies(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly writerDependencies: ConfigCommandWriterDependencies;
}): PackEnablementCommandApplyDependencies {
  return {
    reloadConfig: input.writerDependencies.reloadConfig,
    validatePostWrite: input.writerDependencies.validatePostWrite,
    invalidatePolicyCache: () =>
      input.deps.policyResolver.invalidate(input.ctx.cwd),
    resolvePolicy: () => resolveRatchetPolicy(input.ctx, input.deps),
  };
}

async function resolvePostWriteReplayAfterApply(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly proposal: StructuredRatchetProposal;
  readonly beforePolicy: Awaited<ReturnType<typeof resolveRatchetPolicy>>;
  readonly apply: ProposalApplyDetails;
  readonly engines: ProposalPresentationEngines;
  readonly transactionReplay?: PostWriteReplayResult;
}): Promise<PostWriteReplayResult> {
  if (input.transactionReplay !== undefined) {
    return input.transactionReplay;
  }

  if (!isPostWriteReplayApplicable(input.proposal)) {
    return notApplicablePostWriteReplay(
      input.proposal,
      "proposal kind is not a deterministic post-write replay target",
    );
  }

  if (input.apply.status !== "applied" || input.apply.changed !== true) {
    return notRunPostWriteReplay(
      input.proposal,
      `post-write replay did not run because apply status was ${input.apply.status}`,
    );
  }

  try {
    const afterPolicy = await resolveRatchetPolicy(input.ctx, input.deps);
    const runPostWriteReplay =
      input.engines.runPostWriteReplay ?? defaultRunPostWriteReplay;
    return await runPostWriteReplay({
      proposal: input.proposal,
      beforePolicy: input.beforePolicy,
      afterPolicy,
      ctx: input.ctx,
      deps: input.deps,
    });
  } catch (error: unknown) {
    return {
      status: "failed",
      proposalId: input.proposal.id,
      applicable: true,
      reason: `post-write replay could not resolve the updated policy: ${errorMessage(error)}`,
      warnings: [],
    };
  }
}

function applyWithPostWriteReplay(
  apply: ProposalApplyDetails,
  replay: PostWriteReplayResult,
): ProposalApplyDetails {
  const warnings = stableUnique([...apply.warnings, ...replay.warnings]);
  if (
    replay.status !== "regression" &&
    replay.status !== "failed" &&
    !(apply.status === "applied" && replay.status === "not-run")
  ) {
    return { ...apply, warnings };
  }

  return {
    ...apply,
    status: "failed",
    reason: replay.reason ?? `post-write replay ${replay.status}`,
    errors: stableUnique([
      ...apply.errors,
      ...postWriteReplayFailureErrors(replay),
    ]),
    ...(apply.wrote === undefined ? { wrote: apply.changed === true } : {}),
    ...(apply.restored === undefined ? { restored: false } : {}),
    warnings,
  };
}

function postWriteReplayFailureErrors(
  replay: PostWriteReplayResult,
): readonly string[] {
  const fallback = replay.reason ?? `post-write replay ${replay.status}`;
  if (replay.delta === undefined || replay.delta.regressions.length === 0) {
    return [fallback];
  }
  return replay.delta.regressions.map(
    (regression) => `post-write replay regression: ${regression.message}`,
  );
}

function configApplyDetails(
  result: ConfigCommandApplyResult,
): ProposalApplyDetails {
  if (result.ok) {
    return {
      status: result.changed ? "applied" : "no-op",
      writerKind: "config-command",
      planId: result.planId,
      targetPath: result.targetPath,
      ...(result.backupPath === undefined
        ? {}
        : { backupPath: result.backupPath }),
      changed: result.changed,
      errors: [],
      warnings: result.warnings,
    };
  }

  return {
    status: "failed",
    writerKind: "config-command",
    planId: result.planId,
    targetPath: result.targetPath,
    reason: result.reason,
    changed: result.wrote,
    wrote: result.wrote,
    restored: result.restored,
    errors: result.errors,
    warnings: [],
  };
}

function packEnablementApplyDetails(
  result: PackEnablementCommandApplyResult,
): ProposalApplyDetails {
  if (result.ok) {
    return {
      status: result.changed ? "applied" : "no-op",
      writerKind: "pack-enablement",
      planId: result.planId,
      targetPath: result.targetPath,
      ...(result.backupPath === undefined
        ? {}
        : { backupPath: result.backupPath }),
      changed: result.changed,
      errors: [],
      warnings: result.warnings,
    };
  }

  return {
    status: "failed",
    writerKind: "pack-enablement",
    planId: result.planId,
    targetPath: result.targetPath,
    reason: result.reason,
    changed: result.wrote,
    wrote: result.wrote,
    restored: result.restored,
    errors: result.errors,
    warnings: [],
  };
}

function formatApprovalFailure(failure: ProposalApprovalFailure): string {
  const check = failure.check === undefined ? "" : ` ${failure.check}`;
  const status = failure.status === undefined ? "" : `/${failure.status}`;
  return `${failure.code}${check}${status}: ${failure.message}`;
}

function writePlanRefusal(
  result: Extract<RatchetProposalWritePlanResult, { readonly ok: false }>,
): ProposalApplyDetails {
  return refusedApply({
    reason: result.reason,
    errors: result.errors,
    warnings: [],
  });
}

function refusedApply(input: {
  readonly reason: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}): ProposalApplyDetails {
  return {
    status: "refused",
    reason: input.reason,
    errors: input.errors,
    warnings: input.warnings,
  };
}

function notRequestedApply(
  warnings: readonly string[] = [],
): ProposalApplyDetails {
  return {
    status: "not-requested",
    errors: [],
    warnings,
  };
}

function stableUnique<TValue>(values: readonly TValue[]): readonly TValue[] {
  const seen = new Set<TValue>();
  const result: TValue[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Fill the deterministic local validation checks for an agent-authored
 * policy-pack draft: compile the rule matcher and, for allow rules, check
 * the compiled matcher against the sealed floor. Drafts are never narrowed
 * or downgraded here — an overlapping allow simply fails the check and the
 * human sees the failure on the card.
 */
export async function defaultValidateDraftMatcherAndFloor(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly proposal: StructuredRatchetProposal;
}): Promise<{
  readonly proposal: StructuredRatchetProposal;
  readonly warnings: readonly string[];
}> {
  const { proposal } = input;
  if (proposal.change.kind !== "policy-pack") {
    return { proposal, warnings: [] };
  }
  const change = proposal.change;
  const warnings: string[] = [];

  let matcherCompile: ProposalValidationCheck | undefined =
    proposal.validation.matcherCompile;
  let compiledExpr: Parameters<typeof checkAgainstFloor>[0] | undefined;
  if (matcherCompile?.status === "pending") {
    const compiled = compileMatch(change.match);
    if ("expr" in compiled) {
      compiledExpr = compiled.expr;
      matcherCompile = {
        status: "pass",
        code: "matcher-compile-ok",
        message: "rule matcher compiles",
      };
    } else {
      matcherCompile = {
        status: "fail",
        code: "matcher-compile-failed",
        message: compiled.errors
          .map((error) => error.message)
          .join("; ")
          .slice(0, 500),
      };
    }
  }

  let floorOverlap: ProposalValidationCheck | undefined =
    proposal.validation.floorOverlap;
  if (floorOverlap?.status === "pending") {
    if (change.effect !== "allow") {
      floorOverlap = {
        status: "skipped",
        code: "floor-overlap-not-applicable",
        message: "floor overlap check applies only to allow rules",
      };
    } else if (compiledExpr === undefined) {
      floorOverlap = {
        status: "fail",
        code: "floor-overlap-unchecked",
        message:
          "floor overlap cannot be proven without a compiled matcher; fails closed",
      };
    } else {
      const policy = await resolveRatchetPolicy(input.ctx, input.deps);
      const result = checkAgainstFloor(
        compiledExpr,
        policy.effectivePolicy.floor ?? [],
      );
      floorOverlap = result.allDisjoint
        ? {
            status: "pass",
            code: "floor-overlap-disjoint",
            message: `allow matcher is disjoint from ${result.checkedRuleIds.length} sealed-floor deny rule(s)`,
          }
        : {
            status: "fail",
            code: "floor-overlap-detected",
            message: `allow matcher overlaps sealed-floor deny rule(s): ${result.unsafeRuleIds.join(", ")}`,
          };
      if (!result.allDisjoint) {
        warnings.push(
          `Draft rule ${change.ruleId} overlaps sealed-floor deny rule(s): ${result.unsafeRuleIds.join(", ")}.`,
        );
      }
    }
  }

  return {
    proposal: {
      ...proposal,
      validation: {
        ...proposal.validation,
        ...(matcherCompile === undefined ? {} : { matcherCompile }),
        ...(floorOverlap === undefined ? {} : { floorOverlap }),
      },
    },
    warnings,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
