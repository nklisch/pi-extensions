import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AuditLogger } from "../audit/logger.ts";
import { loadConfig, type ResolvedConfig } from "../config/loader.ts";
import type { PackageRegistrationSnapshot } from "../packs/package-registration.ts";
import {
  createPackRegistry,
  type PackRegistry,
  selectEnabledPackagePacks,
} from "../packs/registry.ts";
import {
  type ComposerResult,
  composeEffectivePolicy,
} from "../policy/composer.ts";
import {
  createNativePolicyHandle,
  type EffectivePolicy,
  type NativePolicyHandle,
} from "../policy/core.ts";

export interface ResolvedPolicy {
  readonly config: ResolvedConfig;
  readonly effectivePolicy: EffectivePolicy;
  /** Compiled once per cached config state; reused by every tool decision. */
  readonly nativePolicy?: NativePolicyHandle;
  readonly registry: PackRegistry;
  readonly packageRegistration: PackageRegistrationSnapshot;
  readonly warnings: readonly string[];
}

export type PolicyResolverResult =
  | { readonly ok: true; readonly policy: ResolvedPolicy }
  | { readonly ok: false; readonly reason: string };

export interface PolicyResolver {
  readonly resolve: (ctx: ExtensionContext) => Promise<PolicyResolverResult>;
  readonly invalidate: (cwd?: string) => void;
}

export interface CachingPolicyResolverOptions {
  readonly audit: AuditLogger;
  readonly packageRegistration?: () => PackageRegistrationSnapshot;
  /** Registered Pi tools used to activate conditional shipped extension packs. */
  readonly registeredToolNames?: (ctx: ExtensionContext) => readonly string[];
  /**
   * Optional seam for tests. Receives the context and audit logger and must return a
   * resolved policy or a failure reason.
   */
  readonly loadAndCompose?: (
    ctx: ExtensionContext,
    audit: AuditLogger,
  ) => Promise<PolicyResolverResult>;
}

export function createCachingPolicyResolver(
  options: CachingPolicyResolverOptions,
): PolicyResolver {
  const cache = new Map<string, Promise<PolicyResolverResult>>();
  const packageRegistration =
    options.packageRegistration ?? emptyPackageRegistrationSnapshot;

  return {
    resolve: (ctx) => {
      const registeredToolNames = stableToolNames(
        safeRegisteredToolNames(options.registeredToolNames, ctx),
      );
      const cacheKey = cacheKeyFor(ctx.cwd, registeredToolNames);
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      const uncached = resolveUncached(
        ctx,
        options.audit,
        packageRegistration,
        registeredToolNames,
        options.loadAndCompose,
      );
      const pending = (
        options.loadAndCompose === undefined
          ? uncached.then(attachNativePolicy)
          : uncached
      ).catch(
        (error: unknown): PolicyResolverResult => ({
          ok: false,
          reason: `policy resolution failed: ${errorMessage(error)}`,
        }),
      );
      cache.set(cacheKey, pending);
      return pending;
    },
    invalidate: (cwd) => {
      const retired: Promise<PolicyResolverResult>[] = [];
      if (cwd === undefined) {
        retired.push(...cache.values());
        cache.clear();
      } else {
        for (const [key, value] of cache) {
          if (key === cwd || key.startsWith(`${cwd}\0tools:`)) {
            retired.push(value);
            cache.delete(key);
          }
        }
      }
      for (const pending of retired) {
        void pending.then(freeResolvedNativePolicy);
      }
    },
  };
}

async function resolveUncached(
  ctx: ExtensionContext,
  audit: AuditLogger,
  packageRegistration: () => PackageRegistrationSnapshot,
  registeredToolNames: readonly string[],
  loadAndCompose:
    | ((
        ctx: ExtensionContext,
        audit: AuditLogger,
      ) => Promise<PolicyResolverResult>)
    | undefined,
): Promise<PolicyResolverResult> {
  if (loadAndCompose !== undefined) {
    return await loadAndCompose(ctx, audit);
  }
  return await defaultLoadAndCompose(
    ctx,
    audit,
    packageRegistration(),
    registeredToolNames,
  );
}

async function defaultLoadAndCompose(
  ctx: ExtensionContext,
  audit: AuditLogger,
  packageRegistration: PackageRegistrationSnapshot,
  registeredToolNames: readonly string[],
): Promise<PolicyResolverResult> {
  const config = await loadConfig({
    cwd: ctx.cwd,
    isProjectTrusted: ctx.isProjectTrusted(),
  });
  const selectedPackagePacks = selectEnabledPackagePacks({
    packagePacks: packageRegistration.packs,
    enabledPackageIds: config.packEnablement.effectivePackagePackIds,
  });
  const composed = await composeEffectivePolicy(config, {
    audit,
    enabledPackagePacks: selectedPackagePacks.packs,
    registeredToolNames,
  });

  return composerResultToPolicyResult(
    config,
    composed,
    packageRegistration,
    selectedPackagePacks,
    registeredToolNames,
  );
}

async function attachNativePolicy(
  result: PolicyResolverResult,
): Promise<PolicyResolverResult> {
  if (!result.ok || result.policy.nativePolicy !== undefined) return result;
  try {
    const nativePolicy = createNativePolicyHandle(
      result.policy.effectivePolicy,
    );
    Object.defineProperty(result.policy, "nativePolicy", {
      configurable: true,
      enumerable: false,
      value: nativePolicy,
    });
    return result;
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `native policy compilation failed: ${errorMessage(error)}`,
    };
  }
}

function freeResolvedNativePolicy(result: PolicyResolverResult): void {
  if (result.ok) result.policy.nativePolicy?.free();
}

function composerResultToPolicyResult(
  config: ResolvedConfig,
  result: ComposerResult,
  packageRegistration: PackageRegistrationSnapshot,
  selectedPackagePacks: ReturnType<typeof selectEnabledPackagePacks>,
  registeredToolNames: readonly string[],
): PolicyResolverResult {
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  const registry = createPackRegistry({
    resolvedConfig: config,
    packagePacks: packageRegistration.packs,
    enabledPackageIds: selectedPackagePacks.enabledPackageIds,
    disabledConfigPackIds: config.packEnablement.disabledConfigPackIds,
    registeredToolNames,
  });

  return {
    ok: true,
    policy: {
      config,
      effectivePolicy: result.effectivePolicy,
      registry,
      packageRegistration,
      warnings: [
        ...result.warnings,
        ...packageRegistration.issues.map(packageRegistrationIssueWarning),
        ...selectedPackagePacks.warnings.map((warning) => warning.message),
        ...registry.warnings,
      ],
    },
  };
}

function emptyPackageRegistrationSnapshot(): PackageRegistrationSnapshot {
  return {
    requestId: null,
    packs: [],
    issues: [],
  };
}

function packageRegistrationIssueWarning(
  issue: PackageRegistrationSnapshot["issues"][number],
): string {
  const packageLabel =
    issue.packageName === undefined ? "" : ` package=${issue.packageName}`;
  const packLabel = issue.packId === undefined ? "" : ` pack=${issue.packId}`;
  const ruleLabel = issue.ruleId === undefined ? "" : ` rule=${issue.ruleId}`;
  return `Package registration ${issue.severity} ${issue.code} at ${issue.path}${packageLabel}${packLabel}${ruleLabel}: ${issue.message}`;
}

function safeRegisteredToolNames(
  provider: ((ctx: ExtensionContext) => readonly string[]) | undefined,
  ctx: ExtensionContext,
): readonly unknown[] {
  if (provider === undefined) {
    return [];
  }

  try {
    const toolNames = provider(ctx) as readonly unknown[];
    return Array.isArray(toolNames) ? toolNames : [];
  } catch {
    return [];
  }
}

function stableToolNames(toolNames: readonly unknown[]): readonly string[] {
  return [
    ...new Set(
      toolNames.filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      ),
    ),
  ].sort();
}

function cacheKeyFor(
  cwd: string,
  registeredToolNames: readonly string[],
): string {
  return `${cwd}\0tools:${registeredToolNames.join("\0")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
