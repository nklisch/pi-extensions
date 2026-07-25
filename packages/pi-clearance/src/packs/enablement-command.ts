import type { ResolvedConfig } from "../config/loader.ts";
import {
  applyPackEnablementPlan,
  type PackEnablementApplyResult,
  type PackEnablementWriterDependencies,
} from "../config/pack-enablement-writer.ts";
import { resolveConfigPaths } from "../config/paths.ts";
import type { ResolvedPolicy } from "../runtime/policy-cache.ts";
import type {
  PackEnablementAcknowledgement,
  PackEnablementAction,
  PackEnablementPlan,
  PackEnablementPlanResult,
  PackEnablementScope,
  PackEnablementSubject,
} from "./enablement.ts";
import { planPackEnablementChange } from "./enablement.ts";
import type {
  PackReplayImpactSummary,
  ValidatedAvailablePack,
} from "./validation.ts";
import {
  createPackAvailabilityValidationReport,
  getValidatedAvailablePack,
  type PackAvailabilityValidationReport,
} from "./validation.ts";

export interface PackEnablementCommandPreviewInput {
  readonly resolvedPolicy: ResolvedPolicy;
  readonly action: PackEnablementAction;
  readonly scope: PackEnablementScope;
  readonly subject: PackEnablementSubject;
  readonly packId: string;
  readonly replayImpact?: PackReplayImpactSummary;
}

export interface PackEnablementCommandPreviewReport {
  readonly result: PackEnablementPlanResult;
  readonly availabilityReport: PackAvailabilityValidationReport;
  readonly candidate?: ValidatedAvailablePack;
  readonly current: {
    readonly enabledInScope: boolean;
    readonly disabledInScope: boolean;
    readonly effectivelyEnabledPackage: boolean;
    readonly disabledConfigPack: boolean;
  };
}

export interface PackEnablementCommandApplyInput {
  readonly plan: PackEnablementPlan;
  readonly acknowledgement: PackEnablementAcknowledgement;
}

export interface PackEnablementCommandApplyDependencies
  extends PackEnablementWriterDependencies {
  /** Invalidate any policy cache after a successful write/no-op, before optional recomposition. */
  readonly invalidatePolicyCache?: () => void;
  /** Optional command-shell hook to return the freshly recomposed runtime snapshot for reporting. */
  readonly resolvePolicy?: () => Promise<ResolvedPolicy>;
}

export type PackEnablementCommandApplyResult =
  | (Extract<PackEnablementApplyResult, { readonly ok: true }> & {
      readonly cacheInvalidated: boolean;
      readonly resolvedPolicy?: ResolvedPolicy;
    })
  | (Extract<PackEnablementApplyResult, { readonly ok: false }> & {
      readonly cacheInvalidated: false;
    });

/**
 * Preview a package/config pack enablement change from a
 * runtime-resolved policy snapshot. Pure command/controller seam only: no Pi UI,
 * no filesystem writes, and no prompt/confirmation side effects.
 */
export function previewPackEnablementCommand(
  input: PackEnablementCommandPreviewInput,
): PackEnablementPlanResult {
  return previewPackEnablementCommandReport(input).result;
}

export function previewPackEnablementCommandReport(
  input: PackEnablementCommandPreviewInput,
): PackEnablementCommandPreviewReport {
  const availabilityReport = buildPackEnablementAvailabilityReport(input);
  const paths = resolveConfigPaths(input.resolvedPolicy.config.cwd);
  const result = planPackEnablementChange({
    request: {
      action: input.action,
      scope: input.scope,
      subject: input.subject,
      packId: input.packId,
    },
    paths,
    resolvedConfig: input.resolvedPolicy.config,
    availabilityReport,
  });

  const candidate = getValidatedAvailablePack(availabilityReport, input.packId);
  return {
    result,
    availabilityReport,
    ...(candidate === undefined ? {} : { candidate }),
    current: currentState(input),
  };
}

/** Build the same validated availability report preview/apply cards should show. */
export function buildPackEnablementAvailabilityReport(
  input: Pick<
    PackEnablementCommandPreviewInput,
    "resolvedPolicy" | "packId" | "replayImpact"
  >,
): PackAvailabilityValidationReport {
  return createPackAvailabilityValidationReport({
    registry: input.resolvedPolicy.registry,
    context: {
      resolvedConfig: validationConfig(input.resolvedPolicy.config),
    },
    ...(input.replayImpact === undefined
      ? {}
      : {
          replayImpactByCandidateId: new Map([
            [input.packId, input.replayImpact],
          ]),
        }),
  });
}

/**
 * Apply a confirmed previewed plan through the audited writer. The command seam
 * owns only orchestration: stale checks, atomic writes, backups, schema
 * validation, and post-write policy validation remain in the writer.
 */
export async function applyPackEnablementCommand(
  input: PackEnablementCommandApplyInput,
  dependencies: PackEnablementCommandApplyDependencies,
): Promise<PackEnablementCommandApplyResult> {
  const result = await applyPackEnablementPlan(
    input.plan,
    input.acknowledgement,
    dependencies,
  );

  if (!result.ok) {
    return { ...result, cacheInvalidated: false };
  }

  dependencies.invalidatePolicyCache?.();
  const resolvedPolicy = await dependencies.resolvePolicy?.();
  return {
    ...result,
    cacheInvalidated: dependencies.invalidatePolicyCache !== undefined,
    ...(resolvedPolicy === undefined ? {} : { resolvedPolicy }),
  };
}

function currentState(input: PackEnablementCommandPreviewInput) {
  const scoped =
    input.scope === "global"
      ? input.resolvedPolicy.config.packEnablement.global
      : input.resolvedPolicy.config.packEnablement.project;
  return {
    enabledInScope: scoped.enabledPackagePacks.includes(input.packId),
    disabledInScope:
      scoped.disabledPackagePacks.includes(input.packId) ||
      scoped.disabledConfigPacks.includes(input.packId),
    effectivelyEnabledPackage:
      input.resolvedPolicy.config.packEnablement.effectivePackagePackIds.includes(
        input.packId,
      ),
    disabledConfigPack:
      input.resolvedPolicy.config.packEnablement.disabledConfigPackIds.includes(
        input.packId,
      ),
  };
}

function validationConfig(config: ResolvedConfig) {
  return {
    mode: config.mode,
    trustedProject: config.trustedProject,
    errors: config.errors,
    warnings: config.warnings,
  };
}
