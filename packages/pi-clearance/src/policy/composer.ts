import {
  type AuditLogger,
  createConfigEventEntry,
  createTrustEventEntry,
} from "../audit/log.ts";
import type { ConfigError, ResolvedConfig } from "../config/loader.ts";
import type { RawPolicyPack } from "../config/schema.ts";
import { filterActiveShippedPacksByActivation } from "../packs/activation.ts";
import { baselinePacks } from "../packs/baseline.ts";
import { sealedFloor } from "../packs/floor.ts";
import type { EffectivePolicy, PolicyPack } from "./core.ts";
import { type CompileError, compilePack } from "./core.ts";
import { type LoadError, loadEffectivePolicy } from "./loader.ts";
import { buildScopeBehaviorPack } from "./scope-behavior-pack.ts";
export interface CompiledPacksResult {
  readonly ok: true;
  readonly packs: readonly PolicyPack[];
}

export interface CompiledPacksFailure {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type CompiledPacksOutcome = CompiledPacksResult | CompiledPacksFailure;

export interface RepositoryPacksResult {
  readonly ok: true;
  readonly packs: readonly PolicyPack[];
  readonly warnings: readonly string[];
}

export interface RepositoryPacksFailure {
  readonly ok: false;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export type RepositoryPacksOutcome =
  | RepositoryPacksResult
  | RepositoryPacksFailure;

export interface PolicyComposerDependencies {
  readonly audit: AuditLogger;
  /**
   * Package-contributed packs selected by user-owned enablement config.
   * Callers pass compiled packs from the package-registration snapshot; the
   * composer only validates them as part of the effective active lane.
   */
  readonly enabledPackagePacks?: readonly PolicyPack[];
  /** Registered Pi tool names used to activate conditional shipped extension packs. */
  readonly registeredToolNames?: readonly string[];
}

export type ComposerResult =
  | {
      readonly ok: true;
      readonly effectivePolicy: EffectivePolicy;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly effectivePolicy: EffectivePolicy;
      readonly reason: string;
      readonly errors: readonly string[];
    };

/**
 * Compose resolved config into a loader-validated EffectivePolicy.
 *
 * Any config, compile, or loader error returns a floor-only policy so
 * the runtime never widens auto-approval when configuration is uncertain.
 */
export async function composeEffectivePolicy(
  resolvedConfig: ResolvedConfig,
  dependencies: PolicyComposerDependencies,
): Promise<ComposerResult> {
  await logTrustEvent(resolvedConfig, dependencies.audit);
  await logModeSelected(resolvedConfig, dependencies.audit);

  if (resolvedConfig.errors.length > 0) {
    const errors = resolvedConfig.errors.map(formatConfigError);
    const result = failureResult(errors);
    await logConfigFailed(dependencies.audit, result.errors);
    return result;
  }

  const warnings = resolvedConfig.warnings.map((warning) => warning.message);
  const activeBaselinePacks = selectBaselinePacks({
    registeredToolNames: dependencies.registeredToolNames ?? [],
  });

  const disabledConfigPackIds = new Set(
    resolvedConfig.packEnablement.disabledConfigPackIds,
  );
  const globalPacks = compileRawPacks(
    filterDisabledConfigPacks(
      resolvedConfig.globalPacks,
      disabledConfigPackIds,
    ),
  );
  if (!globalPacks.ok) {
    const result = failureResult(globalPacks.errors);
    await logConfigFailed(dependencies.audit, result.errors);
    return result;
  }

  const projectPacks = compileRawPacks(
    filterDisabledConfigPacks(
      resolvedConfig.projectPacks,
      disabledConfigPackIds,
    ),
  );
  if (!projectPacks.ok) {
    const result = failureResult(projectPacks.errors);
    await logConfigFailed(dependencies.audit, result.errors);
    return result;
  }

  const repositoryPacks = compileAndFilterRepositoryPacks(
    resolvedConfig.repoPacks,
    resolvedConfig.trustedProject.trusted,
  );
  warnings.push(...repositoryPacks.warnings);
  if (!repositoryPacks.ok) {
    const result = failureResult(repositoryPacks.errors);
    await logConfigFailed(dependencies.audit, result.errors);
    return result;
  }

  const scopeBehavior = buildScopeBehaviorPack(resolvedConfig.projectScope);
  if (!scopeBehavior.ok) {
    const result = failureResult(
      scopeBehavior.errors.map(
        (error) => `scope-behavior pack: ${error.message}`,
      ),
    );
    await logConfigFailed(dependencies.audit, result.errors);
    return result;
  }

  const activePacks = [
    ...activeBaselinePacks,
    ...globalPacks.packs,
    ...projectPacks.packs,
    ...repositoryPacks.packs,
    ...(dependencies.enabledPackagePacks ?? []),
    // Derived from user-owned scope config; deny > review > allow ranking
    // makes its rules effective regardless of pack order.
    ...(scopeBehavior.pack === null ? [] : [scopeBehavior.pack]),
  ];

  const loadResult = loadEffectivePolicy({
    floor: sealedFloor,
    active: activePacks,
  });

  if (!loadResult.ok) {
    const result = failureResult(loadResult.errors.map(formatLoadError));
    await logConfigFailed(dependencies.audit, result.errors);
    return result;
  }

  const result: ComposerResult = {
    ok: true,
    effectivePolicy: loadResult.policy,
    warnings,
  };
  await dependencies.audit.log(
    createConfigEventEntry({
      entryType: "config.event",
      event: "config-loaded",
    }),
  );
  return result;
}

/** Build the fail-closed floor-only policy used for any composition failure. */
export function createFallbackPolicy(): EffectivePolicy {
  return { floor: [...sealedFloor.rules], active: [], rules: [] };
}

/** Select the built-in baseline, filtering conditional extension packs. */
export function selectBaselinePacks(options?: {
  readonly registeredToolNames?: readonly string[];
}): readonly PolicyPack[] {
  return filterActiveShippedPacksByActivation(
    baselinePacks,
    options?.registeredToolNames ?? [],
  );
}

/** Compile config-owned raw packs while preserving caller-supplied pack order. */
export function compileRawPacks(
  rawPacks: readonly RawPolicyPack[],
): CompiledPacksOutcome {
  const packs: PolicyPack[] = [];
  const errors: string[] = [];

  for (const rawPack of rawPacks) {
    const result = compilePack(rawPack);
    errors.push(...result.errors.map(formatCompileError));

    if (result.pack !== null) {
      packs.push(result.pack);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, packs };
}

/**
 * Compile repository-owned raw packs while enforcing the trust boundary.
 *
 * Untrusted repositories may tighten policy with deny/review rules, but cannot
 * widen auto-approval through checked-in allow rules.
 */
export function filterDisabledConfigPacks(
  rawPacks: readonly RawPolicyPack[],
  disabledConfigPackIds: ReadonlySet<string>,
): readonly RawPolicyPack[] {
  return rawPacks.filter((pack) => !disabledConfigPackIds.has(pack.id));
}

export function compileAndFilterRepositoryPacks(
  rawRepoPacks: readonly RawPolicyPack[],
  trusted: boolean,
): RepositoryPacksOutcome {
  const warnings: string[] = [];
  const packsToCompile = trusted
    ? rawRepoPacks
    : rawRepoPacks.map((pack) => filterUntrustedRepositoryPack(pack, warnings));

  const compiled = compileRawPacks(packsToCompile);
  return { ...compiled, warnings };
}

function filterUntrustedRepositoryPack(
  pack: RawPolicyPack,
  warnings: string[],
): RawPolicyPack {
  return {
    ...pack,
    rules: pack.rules.filter((rule) => {
      if (rule.effect !== "allow") {
        return true;
      }

      warnings.push(
        `Repository allow rule \`${rule.id}\` dropped because the project is not trusted.`,
      );
      return false;
    }),
  };
}

function failureResult(
  errors: readonly string[],
): Extract<ComposerResult, { readonly ok: false }> {
  return {
    ok: false,
    effectivePolicy: createFallbackPolicy(),
    reason: errors[0] ?? "policy composition failed",
    errors,
  };
}

async function logTrustEvent(
  resolvedConfig: ResolvedConfig,
  audit: AuditLogger,
): Promise<void> {
  const trusted = resolvedConfig.trustedProject.trusted;
  await audit.log(
    createTrustEventEntry({
      entryType: "trust.event",
      event: trusted ? "project-trusted" : "project-untrusted",
      projectPath: resolvedConfig.cwd,
      reason: trusted
        ? "Pi project trust signal is active"
        : "Pi project trust signal is missing; repository policy is tighten-only",
    }),
  );
}

async function logModeSelected(
  resolvedConfig: ResolvedConfig,
  audit: AuditLogger,
): Promise<void> {
  await audit.log(
    createConfigEventEntry({
      entryType: "config.event",
      event: "mode-selected",
      mode: resolvedConfig.mode,
    }),
  );
}

async function logConfigFailed(
  audit: AuditLogger,
  errors: readonly string[],
): Promise<void> {
  await audit.log(
    createConfigEventEntry({
      entryType: "config.event",
      event: "config-load-failed",
      errors,
    }),
  );
}

function formatConfigError(error: ConfigError): string {
  return `[${error.phase}][${error.path}] ${error.message}`;
}

function formatCompileError(error: CompileError): string {
  return formatPackPathMessage(error.packId, error.path, error.message);
}

function formatLoadError(error: LoadError): string {
  return formatPackPathMessage(error.packId, error.path, error.message);
}

function formatPackPathMessage(
  packId: string | null,
  path: string,
  message: string,
): string {
  return `[${packId ?? "pack"}][${path}] ${message}`;
}
