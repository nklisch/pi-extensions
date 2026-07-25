import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { AuditLogger } from "../../audit/logger.ts";
import type {
  ConfigCommandPostWriteValidationResult,
  ConfigCommandWriterDependencies,
} from "../../config/config-command-writer.ts";
import { loadConfig, type ResolvedConfig } from "../../config/loader.ts";
import type { PackageRegistrationSnapshot } from "../../packs/package-registration.ts";
import {
  createPackRegistry,
  selectEnabledPackagePacks,
} from "../../packs/registry.ts";
import { composeEffectivePolicy } from "../../policy/composer.ts";
import { packageRegistrationWarnings } from "../auto-reviewer-read-models.ts";
import type { ResolvedPolicy } from "../policy-cache.ts";
import {
  assembleReviewPrompt,
  PromptFragmentError,
  PromptOverrideError,
} from "../reviewer-prompts.ts";
import type { AutoReviewerCommandDependencies } from "./types.ts";

export interface ConfigCommandPostWriteValidationDependencies {
  readonly audit: AuditLogger;
  readonly packageRegistration: () => PackageRegistrationSnapshot;
}

export function createConfigCommandWriterDependencies(
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): ConfigCommandWriterDependencies {
  return createExtensionContextConfigCommandWriterDependencies(ctx, deps);
}

export function createExtensionContextConfigCommandWriterDependencies(
  ctx: ExtensionContext,
  deps: ConfigCommandPostWriteValidationDependencies,
): ConfigCommandWriterDependencies {
  return {
    reloadConfig: () =>
      loadConfig({
        cwd: ctx.cwd,
        isProjectTrusted: safeIsProjectTrusted(ctx),
      }),
    validatePostWrite: (config) =>
      validateConfigCommandPostWrite(config, {
        audit: deps.audit,
        packageRegistration: deps.packageRegistration,
      }),
  };
}

export type ConfigCommandPostWritePolicyResult =
  | { readonly ok: true; readonly policy: ResolvedPolicy }
  | { readonly ok: false; readonly errors: readonly string[] };

export async function validateConfigCommandPostWrite(
  resolvedConfig: ResolvedConfig,
  deps: ConfigCommandPostWriteValidationDependencies,
): Promise<ConfigCommandPostWriteValidationResult> {
  const resolvedPolicy = await composeConfigCommandPostWritePolicy(
    resolvedConfig,
    deps,
  );
  if (!resolvedPolicy.ok) {
    return resolvedPolicy;
  }

  const reviewerPromptErrors = validateReviewerPromptSurface(resolvedConfig);
  if (reviewerPromptErrors.length > 0) {
    return {
      ok: false,
      errors: reviewerPromptErrors.map(
        (error) =>
          `Post-write validation checks the complete reviewer prompt surface; a reviewer configuration problem blocked this write and may have pre-existed the attempted command: ${error}`,
      ),
    };
  }

  return {
    ok: true,
    warnings: resolvedPolicy.policy.warnings,
  };
}

export async function composeConfigCommandPostWritePolicy(
  resolvedConfig: ResolvedConfig,
  deps: ConfigCommandPostWriteValidationDependencies,
): Promise<ConfigCommandPostWritePolicyResult> {
  if (resolvedConfig.errors.length > 0) {
    return {
      ok: false,
      errors: resolvedConfig.errors.map(
        (error) =>
          `resolved config error after write (${error.phase}) at ${error.path}: ${error.message}`,
      ),
    };
  }

  const packageRegistration = deps.packageRegistration();
  const selectedPackagePacks = selectEnabledPackagePacks({
    packagePacks: packageRegistration.packs,
    enabledPackageIds: resolvedConfig.packEnablement.effectivePackagePackIds,
  });
  const composed = await composeEffectivePolicy(resolvedConfig, {
    audit: deps.audit,
    enabledPackagePacks: selectedPackagePacks.packs,
  });

  if (!composed.ok) {
    return {
      ok: false,
      errors: stableUnique([composed.reason, ...composed.errors]),
    };
  }

  const registry = createPackRegistry({
    resolvedConfig,
    packagePacks: packageRegistration.packs,
    enabledPackageIds: selectedPackagePacks.enabledPackageIds,
    disabledConfigPackIds: resolvedConfig.packEnablement.disabledConfigPackIds,
  });

  return {
    ok: true,
    policy: {
      config: resolvedConfig,
      effectivePolicy: composed.effectivePolicy,
      registry,
      packageRegistration,
      warnings: stableUnique([
        ...composed.warnings,
        ...packageRegistrationWarnings(packageRegistration),
        ...selectedPackagePacks.warnings.map((warning) => warning.message),
        ...registry.warnings,
      ]),
    },
  };
}

function validateReviewerPromptSurface(
  resolvedConfig: ResolvedConfig,
): readonly string[] {
  try {
    assembleReviewPrompt(resolvedConfig.reviewer);
    return [];
  } catch (error) {
    if (error instanceof PromptFragmentError) {
      return [
        `Reviewer prompt append references unknown shipped reviewer fragment "${error.fragmentId}". reviewer.* append entries must name a shipped fragment id.`,
      ];
    }
    if (error instanceof PromptOverrideError) {
      return [`Reviewer prompt override is invalid: ${error.reason}.`];
    }
    return [errorMessage(error)];
  }
}

function safeIsProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

function stableUnique<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
