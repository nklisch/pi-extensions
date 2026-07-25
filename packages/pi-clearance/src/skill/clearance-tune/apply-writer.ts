import type { AuditLogger } from "../../audit/logger.ts";
import type { ResolvedConfig } from "../../config/loader.ts";
import type { ConfigPaths } from "../../config/paths.ts";
import {
  type GlobalConfig,
  GlobalConfigSchema,
  normalizeConfig,
  type ProjectOverlayConfig,
  ProjectOverlaySchema,
  type RawPolicyPack,
  type RawPolicyPackRule,
} from "../../config/schema.ts";
import type { ComposerResult } from "../../policy/composer.ts";
import type { RuleProposal } from "../../replay/proposals.ts";
import {
  type ReviewerConfigProposal,
  renderReviewerConfigDiff,
} from "../../replay/reviewer-config-proposals.ts";
import { validatePromptOverride } from "../../runtime/reviewer-prompts.ts";
import { routeReviewerProposal, routeRuleProposal } from "./presentation.ts";

export const RATCHET_GENERATED_PACK_ID = "ratchet.generated";

export interface WriteTarget {
  readonly kind: "global-config" | "project-overlay";
  readonly path: string;
  readonly backupPath: string;
}

export interface WritePlan {
  readonly target: WriteTarget;
  readonly currentRaw: unknown;
  readonly mergedJson: unknown;
  readonly changeDescription: string;
  readonly ruleId?: string;
  readonly proposalId: string;
}

export type WritePlanError =
  | { readonly kind: "schema"; readonly errors: readonly string[] }
  | { readonly kind: "floor-overlap"; readonly errors: readonly string[] }
  | { readonly kind: "override-invalid"; readonly reason: string }
  | { readonly kind: "not-writable"; readonly reason: string };

export type WritePlanResult =
  | { readonly ok: true; readonly plan: WritePlan }
  | { readonly ok: false; readonly error: WritePlanError };

export interface PlanWritePorts {
  /** Default caller wrapper: `(config, audit) => composeEffectivePolicy(config, { audit })`. */
  readonly compose: (
    config: ResolvedConfig,
    audit: AuditLogger,
  ) => Promise<ComposerResult>;
  /** `noopAuditSink`-backed logger for pre-write validation (no spurious `config-loaded`). */
  readonly silentAudit: AuditLogger;
}

/** Build + validate a write plan for an approved rule proposal. No file IO. */
export async function planRuleWrite(
  proposal: RuleProposal,
  resolved: ResolvedConfig,
  currentRaw: unknown,
  paths: ConfigPaths,
  ports: PlanWritePorts,
): Promise<WritePlanResult> {
  if (
    routeRuleProposal(proposal) !== "write-overlay" ||
    !isUserOwnedTarget(proposal.target)
  ) {
    return notWritable(
      `Rule proposal ${proposal.id} routes to design input, not a user-owned config write.`,
    );
  }

  const target = writeTargetForProposalTarget(proposal.target, paths);
  const mergedRaw = mergeGeneratedRule(currentRaw, rawPolicyPackRule(proposal));
  const validated = validateMergedConfig(proposal.target, mergedRaw);
  if (!validated.ok) {
    return validated;
  }

  const composed = await ports.compose(
    configWithMergedPacks(resolved, proposal.target, validated.packs),
    ports.silentAudit,
  );
  if (!composed.ok) {
    return {
      ok: false,
      error: { kind: "floor-overlap", errors: composed.errors },
    };
  }

  return {
    ok: true,
    plan: {
      target,
      currentRaw,
      mergedJson: validated.value,
      changeDescription: `Merge ${proposal.effect} rule ${proposal.ruleId} into ${RATCHET_GENERATED_PACK_ID} for ${proposal.target}.`,
      ruleId: proposal.ruleId,
      proposalId: proposal.id,
    },
  };
}

/** Build + validate a write plan for an approved reviewer-config proposal. No file IO. */
export async function planReviewerConfigWrite(
  proposal: ReviewerConfigProposal,
  _resolved: ResolvedConfig,
  currentRaw: unknown,
  paths: ConfigPaths,
  ports: PlanWritePorts,
): Promise<WritePlanResult> {
  if (routeReviewerProposal(proposal) !== "write-reviewer") {
    return notWritable(
      `Reviewer-config proposal ${proposal.id} does not route to a reviewer config write.`,
    );
  }

  let drafted: ReturnType<typeof renderReviewerConfigDiff>;
  try {
    drafted = renderReviewerConfigDiff(
      proposal.kind,
      proposal.diff.target,
      proposal.diff.pointer,
      proposal.diff.op,
      proposal.diff.before,
      proposal.diff.after,
      _resolved.reviewer,
    );
  } catch (error) {
    return {
      ok: false,
      error: { kind: "schema", errors: [errorMessage(error)] },
    };
  }

  const mergedRaw = mergeReviewerConfig(
    currentRaw,
    proposal.target,
    drafted.merged,
  );
  const validated = validateMergedConfig(proposal.target, mergedRaw);
  if (!validated.ok) {
    return validated;
  }

  if (proposal.kind === "override-set") {
    if (drafted.overrideText === undefined) {
      return {
        ok: false,
        error: {
          kind: "override-invalid",
          reason: "override-set proposal did not produce string override text",
        },
      };
    }

    const overrideValidation = validatePromptOverride(drafted.overrideText);
    if (!overrideValidation.ok) {
      return {
        ok: false,
        error: {
          kind: "override-invalid",
          reason: overrideValidation.reason,
        },
      };
    }
  }

  // Keep the same injected seam for reviewer writes even though there is no
  // floor-overlap policy expansion to compose. This makes the port shape uniform
  // for callers and prevents future reviewer-affecting validation from importing IO.
  void ports;

  return {
    ok: true,
    plan: {
      target: writeTargetForProposalTarget(proposal.target, paths),
      currentRaw,
      mergedJson: validated.value,
      changeDescription: `Apply reviewer config proposal ${proposal.id} to ${proposal.target}.`,
      proposalId: proposal.id,
    },
  };
}

function rawPolicyPackRule(proposal: RuleProposal): RawPolicyPackRule {
  return {
    id: proposal.ruleId,
    effect: proposal.effect,
    match: proposal.match,
    reason: proposal.reason,
    provenance: { source: proposal.intendedProvenance },
  } as RawPolicyPackRule;
}

function writeTargetForProposalTarget(
  target: "user-global" | "user-project",
  paths: ConfigPaths,
): WriteTarget {
  const path =
    target === "user-global"
      ? paths.globalConfigFile
      : paths.projectOverlayFile;
  return {
    kind: target === "user-global" ? "global-config" : "project-overlay",
    path,
    backupPath: `${path}.bak`,
  };
}

function mergeGeneratedRule(
  currentRaw: unknown,
  rule: RawPolicyPackRule,
): unknown {
  if (!isRecord(currentRaw)) {
    return currentRaw;
  }

  if ("packs" in currentRaw && !Array.isArray(currentRaw.packs)) {
    return cloneRecord(currentRaw);
  }

  const currentPacks = Array.isArray(currentRaw.packs) ? currentRaw.packs : [];
  const packs = currentPacks.map(cloneJsonish);
  const generatedIndex = packs.findIndex(
    (pack) => isRecord(pack) && pack.id === RATCHET_GENERATED_PACK_ID,
  );
  const generatedPack =
    generatedIndex === -1
      ? { version: 1, id: RATCHET_GENERATED_PACK_ID, rules: [] }
      : packs[generatedIndex];

  const mergedPack = mergeRuleIntoPack(generatedPack, rule);
  const mergedPacks =
    generatedIndex === -1
      ? [...packs, mergedPack]
      : packs.map((pack, index) =>
          index === generatedIndex ? mergedPack : pack,
        );

  return { ...cloneRecord(currentRaw), packs: mergedPacks };
}

function mergeRuleIntoPack(pack: unknown, rule: RawPolicyPackRule): unknown {
  if (!isRecord(pack)) {
    return pack;
  }

  if (!Array.isArray(pack.rules)) {
    return cloneRecord(pack);
  }

  const rules = pack.rules.map(cloneJsonish);
  const existingIndex = rules.findIndex(
    (candidate) => isRecord(candidate) && candidate.id === rule.id,
  );
  const mergedRules =
    existingIndex === -1
      ? [...rules, rule]
      : rules.map((candidate, index) =>
          index === existingIndex ? rule : candidate,
        );

  return {
    ...cloneRecord(pack),
    version: 1,
    id: RATCHET_GENERATED_PACK_ID,
    rules: mergedRules,
  };
}

function mergeReviewerConfig(
  currentRaw: unknown,
  target: "user-global" | "user-project",
  draftedMerged: unknown,
): unknown {
  if (!isRecord(currentRaw)) {
    return currentRaw;
  }

  if (target === "user-global") {
    return {
      ...cloneRecord(currentRaw),
      reviewer: cloneJsonish(draftedMerged),
    };
  }

  if (!isRecord(draftedMerged)) {
    return { ...cloneRecord(currentRaw), promptAppends: draftedMerged };
  }

  return {
    ...cloneRecord(currentRaw),
    promptAppends: cloneJsonish(draftedMerged.promptAppends),
  };
}

type ValidatedMergedConfig =
  | {
      readonly ok: true;
      readonly value: GlobalConfig;
      readonly packs: readonly RawPolicyPack[];
    }
  | {
      readonly ok: true;
      readonly value: ProjectOverlayConfig;
      readonly packs: readonly RawPolicyPack[];
    }
  | {
      readonly ok: false;
      readonly error: Extract<WritePlanError, { kind: "schema" }>;
    };

function validateMergedConfig(
  target: "user-global" | "user-project",
  mergedRaw: unknown,
): ValidatedMergedConfig {
  if (target === "user-global") {
    const result = normalizeConfig(GlobalConfigSchema, mergedRaw);
    if (!result.ok) {
      return schemaError(result.errors);
    }

    return { ok: true, value: result.value, packs: result.value.packs };
  }

  const result = normalizeConfig(ProjectOverlaySchema, mergedRaw);
  if (!result.ok) {
    return schemaError(result.errors);
  }

  return { ok: true, value: result.value, packs: result.value.packs };
}

function schemaError(
  errors: readonly { readonly path: string; readonly message: string }[],
): Extract<ValidatedMergedConfig, { readonly ok: false }> {
  return {
    ok: false,
    error: {
      kind: "schema",
      errors: errors.map((error) => `${error.path}: ${error.message}`),
    },
  };
}

function configWithMergedPacks(
  resolved: ResolvedConfig,
  target: "user-global" | "user-project",
  packs: readonly RawPolicyPack[],
): ResolvedConfig {
  const stampedPacks = provenanceStampedPacks(packs, target);

  return {
    ...resolved,
    ...(target === "user-global"
      ? { globalPacks: stampedPacks }
      : { projectPacks: stampedPacks }),
  };
}

function provenanceStampedPacks(
  packs: readonly RawPolicyPack[],
  target: "user-global" | "user-project",
): readonly RawPolicyPack[] {
  const source = target;
  return packs.map((pack) => ({
    ...pack,
    rules: pack.rules.map((rule) => ({
      ...rule,
      provenance: { source },
    })),
  }));
}

function notWritable(reason: string): WritePlanResult {
  return { ok: false, error: { kind: "not-writable", reason } };
}

function isUserOwnedTarget(
  target: string,
): target is "user-global" | "user-project" {
  return target === "user-global" || target === "user-project";
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneJsonish(entry)]),
  );
}

function cloneJsonish(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonish);
  }

  if (isRecord(value)) {
    return cloneRecord(value);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
