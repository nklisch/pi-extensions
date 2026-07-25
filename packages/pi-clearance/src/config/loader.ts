import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Static, TSchema } from "@sinclair/typebox";
import type { DecisionEffect } from "../policy/core.ts";
import {
  isHighCostReviewerModel,
  parseModelSpec,
} from "../runtime/reviewer-model.ts";
import {
  defaultAgentSupportDirectories,
  isPathWithinOrEqual,
  isSensitiveHomePath,
  normalizeAbsolutePath,
} from "./path-scope.ts";
import type { ConfigPaths } from "./paths.ts";
import { resolveConfigPaths } from "./paths.ts";
import {
  type ClearanceMode,
  type GlobalConfig,
  GlobalConfigSchema,
  normalizeConfig,
  type PackEnablementConfig,
  type ProjectOverlayConfig,
  ProjectOverlaySchema,
  type ProjectScopeConfig,
  type RawPolicyPack,
  type RepositoryPolicyConfig,
  RepositoryPolicySchema,
  type ReviewerConfig,
  type ReviewNoteMode,
} from "./schema.ts";

export interface ConfigError {
  readonly phase: "io" | "schema";
  readonly path: string;
  readonly message: string;
}

export interface ConfigWarning {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface TrustedProjectState {
  /** Pi owns the project-trust decision; Clearance does not maintain a record. */
  readonly trusted: boolean;
}

export interface ResolvedReviewNotePreference {
  readonly mode: ReviewNoteMode;
  readonly showModelLabel: boolean;
  readonly accent: boolean;
}

export interface ResolvedReviewerConfig {
  readonly promptPosture: string;
  readonly promptAppends: readonly string[];
  readonly projectPromptAppends: readonly string[];
  readonly promptOverride: string | null;
  readonly model: string | null;
  readonly tokenBudget: {
    readonly window: string;
    readonly limit: number | null;
  };
  readonly contextMode: "minimal" | "recentContext";
  readonly recentContext: {
    readonly decisionLimit: number;
    readonly decisionWindow: string;
    readonly conversationTurns: number;
    readonly conversationCharLimit: number;
  };
  readonly escalation: {
    readonly enabled: boolean;
    readonly denialLimit: number;
    readonly window: string;
  };
}

export type UnknownPathBehavior = ProjectScopeConfig["unknownPathBehavior"];
export type SensitivePathBehavior = ProjectScopeConfig["sensitivePathBehavior"];
export type HomePathBehavior = ProjectScopeConfig["homePathBehavior"];

/**
 * Normalized runtime view of the user-owned project scope. Paths are absolute
 * and lexically normalized — no realpath or symlink resolution, because
 * downstream path-facts owns existence and symlink semantics. `writableDirectories`
 * entries are validated against `roots`; invalid scope config is surfaced as
 * `ConfigError`s on `ResolvedConfig.errors` so policy composition fails closed.
 */
export interface ResolvedProjectScope {
  readonly roots: readonly string[];
  readonly writableDirectories: readonly string[];
  readonly tempDirectories: readonly string[];
  readonly deniedDirectories: readonly string[];
  readonly safeHomeDirectories: readonly string[];
  /** Resolved built-in and explicitly configured Pi support roots. */
  readonly agentSupportDirectories?: readonly string[];
  readonly unknownPathBehavior: UnknownPathBehavior;
  readonly sensitivePathBehavior: SensitivePathBehavior;
  readonly homePathBehavior: HomePathBehavior;
}

export interface ResolvedPackEnablement {
  readonly global: PackEnablementConfig;
  readonly project: PackEnablementConfig;
  readonly effectivePackagePackIds: readonly string[];
  readonly disabledConfigPackIds: readonly string[];
}

export interface ResolvedConfigSourceSnapshots {
  readonly paths: ConfigPaths;
  readonly global: GlobalConfig;
  readonly project: ProjectOverlayConfig;
  readonly repository: RepositoryPolicyConfig;
}

export interface ResolvedConfig {
  readonly version: 1;
  readonly cwd: string;
  /**
   * Best-effort home directory resolved at the runtime/config boundary for
   * lexical path-facts enrichment. Omitted when Node cannot provide a usable
   * absolute home path, so `~/...` stays unknown instead of being guessed.
   */
  readonly homeDirectory?: string;
  /**
   * Schema-normalized source documents used by config command planners.
   * Older/direct test fixtures may omit this optional snapshot; production
   * `loadConfig()` always supplies it so write plans can perform stale-plan
   * checks against the exact document the user previewed.
   */
  readonly sourceSnapshots?: ResolvedConfigSourceSnapshots;
  readonly mode: ClearanceMode;
  readonly unknownToolPosture: DecisionEffect;
  readonly projectScope: ResolvedProjectScope;
  readonly packEnablement: ResolvedPackEnablement;
  readonly globalPacks: readonly RawPolicyPack[];
  readonly projectPacks: readonly RawPolicyPack[];
  readonly repoPacks: readonly RawPolicyPack[];
  readonly trustedProject: TrustedProjectState;
  readonly reviewer: ResolvedReviewerConfig;
  readonly display: {
    readonly reviewNote: ResolvedReviewNotePreference;
  };
  readonly errors: readonly ConfigError[];
  readonly warnings: readonly ConfigWarning[];
}

export interface LoadConfigOptions {
  readonly cwd: string;
  readonly isProjectTrusted?: boolean;
}

const DEFAULT_SAFE_HOME_DIRECTORIES = [
  "projects",
  "dev",
  "src",
  "code",
  "repos",
  "Developer",
] as const;

type OptionalConfig<T> =
  | { readonly kind: "missing" }
  | { readonly kind: "loaded"; readonly value: T; readonly raw: unknown }
  | { readonly kind: "invalid"; readonly errors: readonly ConfigError[] };

type PackSource = RawPolicyPack["rules"][number]["provenance"]["source"];

export async function loadConfig(
  options: LoadConfigOptions,
): Promise<ResolvedConfig> {
  const cwd = path.resolve(options.cwd);
  const paths = resolveConfigPaths(cwd);

  const errors: ConfigError[] = [];
  const warnings: ConfigWarning[] = [];

  const globalResult = await readOptionalConfig(
    paths.globalConfigFile,
    GlobalConfigSchema,
    "schema",
  );
  const projectResult = await readOptionalConfig(
    paths.projectOverlayFile,
    ProjectOverlaySchema,
    "schema",
  );
  const repoResult = await readOptionalConfig(
    paths.repoPolicyFile,
    RepositoryPolicySchema,
    "schema",
  );
  errors.push(
    ...collectInvalidErrors(globalResult),
    ...collectInvalidErrors(projectResult),
    ...collectInvalidErrors(repoResult),
  );

  const globalConfig =
    globalResult.kind === "loaded"
      ? globalResult.value
      : defaultGlobalConfig(
          globalResult.kind === "invalid" ? "strict" : "normal",
        );
  const projectOverlay =
    projectResult.kind === "loaded"
      ? projectResult.value
      : emptyProjectOverlay();
  const repositoryPolicy =
    repoResult.kind === "loaded" ? repoResult.value : emptyRepositoryPolicy();
  const trustedProject = resolveTrustedProject(options);
  const mode = globalConfig.mode;

  const homeDirectory = resolveHomeDirectory();
  const projectScopeResolution = validateProjectScopeConfig({
    cwd,
    projectScope: projectOverlay.projectScope,
    pathForErrors: paths.projectOverlayFile,
    homeDirectory,
  });
  errors.push(...projectScopeResolution.errors);

  const reviewer = resolveReviewer(
    globalConfig.reviewer,
    projectOverlay,
    repositoryPolicy,
    trustedProject,
    paths,
    warnings,
  );
  const display = resolveDisplay(globalConfig);
  const packEnablement = resolvePackEnablement(
    globalConfig.packEnablement,
    projectOverlay.packEnablement,
    paths,
    warnings,
  );

  return {
    version: 1,
    cwd,
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
    sourceSnapshots: {
      paths,
      global: globalConfig,
      project: projectOverlay,
      repository: repositoryPolicy,
    },
    mode,
    unknownToolPosture: globalConfig.unknownToolPosture ?? "allow",
    projectScope: projectScopeResolution.scope,
    packEnablement,
    globalPacks: withPackSource(globalConfig.packs, "user-global"),
    projectPacks: withPackSource(projectOverlay.packs, "user-project"),
    repoPacks: withPackSource(repositoryPolicy.packs, "trusted-repo"),
    trustedProject,
    reviewer,
    display,
    errors,
    warnings,
  };
}

function resolveDisplay(globalConfig: GlobalConfig): ResolvedConfig["display"] {
  return {
    reviewNote: { ...globalConfig.display.reviewNote },
  };
}

function resolvePackEnablement(
  globalConfig: PackEnablementConfig,
  projectOverlay: PackEnablementConfig,
  paths: ConfigPaths,
  warnings: ConfigWarning[],
): ResolvedPackEnablement {
  const global = normalizePackEnablementScope(
    globalConfig,
    "global",
    paths.globalConfigFile,
    warnings,
  );
  const project = normalizePackEnablementScope(
    projectOverlay,
    "project",
    paths.projectOverlayFile,
    warnings,
  );

  const globalDisabledPackageIds = new Set(global.disabledPackagePacks);
  const projectDisabledPackageIds = new Set(project.disabledPackagePacks);
  const enabledAfterGlobalDisable = global.enabledPackagePacks.filter(
    (id) => !globalDisabledPackageIds.has(id),
  );
  const enabledBeforeProjectDisable = orderedUnionIds(
    enabledAfterGlobalDisable,
    project.enabledPackagePacks,
  );

  return {
    global,
    project,
    effectivePackagePackIds: enabledBeforeProjectDisable.filter(
      (id) => !projectDisabledPackageIds.has(id),
    ),
    disabledConfigPackIds: orderedUnionIds(
      global.disabledConfigPacks,
      project.disabledConfigPacks,
    ),
  };
}

function normalizePackEnablementScope(
  config: PackEnablementConfig,
  scopeLabel: "global" | "project",
  pathForWarnings: string,
  warnings: ConfigWarning[],
): PackEnablementConfig {
  return {
    enabledPackagePacks: dedupePackIds(
      config.enabledPackagePacks,
      scopeLabel,
      "enabledPackagePacks",
      pathForWarnings,
      warnings,
    ),
    disabledPackagePacks: dedupePackIds(
      config.disabledPackagePacks,
      scopeLabel,
      "disabledPackagePacks",
      pathForWarnings,
      warnings,
    ),
    disabledConfigPacks: dedupePackIds(
      config.disabledConfigPacks,
      scopeLabel,
      "disabledConfigPacks",
      pathForWarnings,
      warnings,
    ),
  };
}

function dedupePackIds(
  ids: readonly string[],
  scopeLabel: "global" | "project",
  field: keyof PackEnablementConfig,
  pathForWarnings: string,
  warnings: ConfigWarning[],
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      warnings.push({
        code: "pack-enable-duplicate-id",
        path: pathForWarnings,
        message: `${scopeLabel} packEnablement.${field} contains duplicate id "${id}" at index ${index}; keeping the first occurrence.`,
      });
      return;
    }

    seen.add(id);
    result.push(id);
  });
  return result;
}

function orderedUnionIds(
  ...lists: readonly (readonly string[])[]
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of lists) {
    for (const id of list) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

export function validateProjectScopeConfig(input: {
  readonly cwd: string;
  readonly projectScope: ProjectScopeConfig;
  readonly pathForErrors: string;
  readonly homeDirectory?: string | undefined;
}): {
  readonly scope: ResolvedProjectScope;
  readonly errors: readonly ConfigError[];
} {
  const cwd = path.resolve(input.cwd);
  const projectScope = input.projectScope;
  const pathForErrors = input.pathForErrors;
  const errors: ConfigError[] = [];

  const roots = resolveScopePathList(
    projectScope.roots,
    cwd,
    pathForErrors,
    "roots",
    errors,
  );
  const writableConfigured = resolveScopePathList(
    projectScope.writableDirectories,
    cwd,
    pathForErrors,
    "writableDirectories",
    errors,
  );
  const tempConfigured = resolveScopePathList(
    projectScope.tempDirectories,
    cwd,
    pathForErrors,
    "tempDirectories",
    errors,
  );
  const deniedConfigured = resolveScopePathList(
    projectScope.deniedDirectories,
    cwd,
    pathForErrors,
    "deniedDirectories",
    errors,
  );
  const homeDirectory = Object.hasOwn(input, "homeDirectory")
    ? input.homeDirectory === undefined
      ? undefined
      : normalizeHomeDirectory(input.homeDirectory)
    : resolveHomeDirectory();
  const safeHomeDefaults =
    projectScope.safeHomeUseDefaults && homeDirectory !== undefined
      ? DEFAULT_SAFE_HOME_DIRECTORIES.map((entry) =>
          path.resolve(homeDirectory, entry),
        )
      : [];
  const safeHomeConfigured = resolveSafeHomePathList(
    projectScope.safeHomeDirectories,
    homeDirectory,
    pathForErrors,
    errors,
  );
  const agentSupportDefaults =
    projectScope.agentSupportUseDefaults !== false &&
    homeDirectory !== undefined
      ? defaultAgentSupportDirectories(homeDirectory)
      : [];
  const agentSupportConfigured = resolveAgentSupportPathList(
    projectScope.agentSupportDirectories ?? [],
    cwd,
    homeDirectory,
    pathForErrors,
    errors,
  );

  // cwd is the implicit project root and default writable directory; the OS
  // temp directory is the implicit temp directory. Both are already absolute,
  // but path.resolve normalizes trailing dots/separators consistently.
  const resolvedRoots = dedupePaths([cwd, ...roots]);
  const resolvedWritable = dedupePaths([cwd, ...writableConfigured]);
  const resolvedTemp = dedupePaths([path.resolve(tmpdir()), ...tempConfigured]);
  const resolvedDenied = dedupePaths(deniedConfigured);
  const resolvedSafeHome = dedupePaths([
    ...safeHomeDefaults,
    ...safeHomeConfigured,
  ]);
  const resolvedAgentSupport = dedupePaths([
    ...agentSupportDefaults,
    ...agentSupportConfigured,
  ]);

  // Every writable directory must sit within a configured root so a mis-scoped
  // config cannot widen writes outside the project. Lexical check only.
  for (const candidate of resolvedWritable) {
    if (!isWithinAnyRoot(candidate, resolvedRoots)) {
      errors.push({
        phase: "schema",
        path: pathForErrors,
        message: `projectScope.writableDirectories entry "${candidate}" is outside all configured project roots`,
      });
    }
  }

  return {
    scope: {
      roots: resolvedRoots,
      writableDirectories: resolvedWritable,
      tempDirectories: resolvedTemp,
      deniedDirectories: resolvedDenied,
      safeHomeDirectories: resolvedSafeHome,
      agentSupportDirectories: resolvedAgentSupport,
      unknownPathBehavior: projectScope.unknownPathBehavior,
      sensitivePathBehavior: projectScope.sensitivePathBehavior,
      homePathBehavior: projectScope.homePathBehavior,
    },
    errors,
  };
}

function resolveHomeDirectory(): string | undefined {
  return normalizeHomeDirectory(homedir());
}

function normalizeHomeDirectory(value: string): string | undefined {
  if (value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    return undefined;
  }
  return path.resolve(value);
}

function resolveScopePathList(
  entries: readonly string[],
  cwd: string,
  pathForErrors: string,
  field: string,
  errors: ConfigError[],
): readonly string[] {
  const resolved: string[] = [];
  entries.forEach((entry, index) => {
    if (entry.includes("\0")) {
      errors.push({
        phase: "schema",
        path: pathForErrors,
        message: `projectScope.${field}[${index}] contains a NUL byte`,
      });
      return;
    }
    resolved.push(path.resolve(cwd, entry));
  });
  return resolved;
}

function resolveSafeHomePathList(
  entries: readonly string[],
  homeDirectory: string | undefined,
  pathForErrors: string,
  errors: ConfigError[],
): readonly string[] {
  const resolved: string[] = [];
  entries.forEach((entry, index) => {
    const field = `projectScope.safeHomeDirectories[${index}]`;
    if (entry.includes("\0")) {
      errors.push({
        phase: "schema",
        path: pathForErrors,
        message: `${field} contains a NUL byte`,
      });
      return;
    }
    if (homeDirectory === undefined) {
      errors.push({
        phase: "schema",
        path: pathForErrors,
        message: `${field} cannot be resolved because $HOME is unavailable`,
      });
      return;
    }

    const candidate = resolveSafeHomeEntry(entry, homeDirectory);
    if (!isPathWithinOrEqual(candidate, homeDirectory)) {
      errors.push({
        phase: "schema",
        path: pathForErrors,
        message: `${field} entry "${entry}" resolves outside $HOME`,
      });
      return;
    }
    if (candidate === homeDirectory) {
      errors.push({
        phase: "schema",
        path: pathForErrors,
        message: `${field} entry "${entry}" resolves to $HOME itself, which is too broad`,
      });
      return;
    }
    if (isSensitiveHomePath(candidate, homeDirectory)) {
      errors.push({
        phase: "schema",
        path: pathForErrors,
        message: `${field} entry "${entry}" resolves to a sensitive home path`,
      });
      return;
    }

    resolved.push(candidate);
  });
  return resolved;
}

function resolveSafeHomeEntry(entry: string, homeDirectory: string): string {
  if (entry === "~" || entry.startsWith("~/")) {
    return path.resolve(homeDirectory, entry.slice(2));
  }
  if (entry === "$HOME" || entry.startsWith("$HOME/")) {
    return path.resolve(homeDirectory, entry.slice("$HOME".length + 1));
  }
  const homeExpression = ["$", "{HOME}"].join("");
  if (entry === homeExpression || entry.startsWith(`${homeExpression}/`)) {
    return path.resolve(homeDirectory, entry.slice(homeExpression.length + 1));
  }
  if (path.isAbsolute(entry)) {
    return normalizeAbsolutePath(entry);
  }
  return path.resolve(homeDirectory, entry);
}

function resolveAgentSupportPathList(
  entries: readonly string[],
  cwd: string,
  homeDirectory: string | undefined,
  pathForErrors: string,
  errors: ConfigError[],
): readonly string[] {
  const resolved: string[] = [];
  entries.forEach((entry, index) => {
    const field = `projectScope.agentSupportDirectories[${index}]`;
    if (entry.includes("\0")) {
      errors.push({
        phase: "schema",
        path: pathForErrors,
        message: `${field} contains a NUL byte`,
      });
      return;
    }

    const usesHomeExpression =
      entry === "~" ||
      entry.startsWith("~/") ||
      entry === "$HOME" ||
      entry.startsWith("$HOME/") ||
      entry === "$" + "{HOME}" ||
      entry.startsWith("$" + "{HOME}/");
    if (usesHomeExpression && homeDirectory === undefined) {
      errors.push({
        phase: "schema",
        path: pathForErrors,
        message: `${field} cannot be resolved because $HOME is unavailable`,
      });
      return;
    }

    const candidate = usesHomeExpression
      ? resolveSafeHomeEntry(entry, homeDirectory as string)
      : path.isAbsolute(entry)
        ? normalizeAbsolutePath(entry)
        : path.resolve(cwd, entry);
    if (homeDirectory !== undefined && candidate === homeDirectory) {
      errors.push({
        phase: "schema",
        path: pathForErrors,
        message: `${field} entry "${entry}" resolves to $HOME itself, which is too broad`,
      });
      return;
    }

    resolved.push(candidate);
  });
  return resolved;
}

function dedupePaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of paths) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function isWithinAnyRoot(candidate: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (isWithinRoot(candidate, root)) {
      return true;
    }
  }
  return false;
}

function isWithinRoot(candidate: string, root: string): boolean {
  // Lexical containment only — no realpath/symlink resolution (downstream
  // path-facts owns that). `path.relative` yields "" when candidate is the
  // root itself. A ".."-prefixed (escapes upward) or absolute (different
  // drive on Windows) relative path means the candidate is outside the root.
  // Intentionally conservative: a literal "..foo" name also trips this, but
  // failing closed is the safe default for path-scope uncertainty.
  const relative = path.relative(root, candidate);
  return !(relative.startsWith("..") || path.isAbsolute(relative));
}

function resolveTrustedProject(
  options: LoadConfigOptions,
): TrustedProjectState {
  return { trusted: options.isProjectTrusted === true };
}

function warnForReviewerModel(
  model: string | null,
  pathForWarnings: string,
  warnings: ConfigWarning[],
): void {
  if (model === null) return;

  if (parseModelSpec(model)?.provider === undefined) {
    warnings.push({
      code: "reviewer-model-bare-id",
      path: pathForWarnings,
      message:
        "reviewer.model uses a bare model id; prefer provider/modelId to avoid runtime provider ambiguity.",
    });
  }

  if (isHighCostReviewerModel(model)) {
    warnings.push({
      code: "reviewer-model-high-cost",
      path: pathForWarnings,
      message:
        "reviewer.model appears to target a known high-cost model; this is allowed but may increase review cost.",
    });
  }
}

function resolveReviewer(
  globalReviewer: ReviewerConfig,
  projectOverlay: ProjectOverlayConfig,
  repositoryPolicy: RepositoryPolicyConfig,
  trustedProject: TrustedProjectState,
  paths: ConfigPaths,
  warnings: ConfigWarning[],
): ResolvedReviewerConfig {
  warnForReviewerModel(globalReviewer.model, paths.globalConfigFile, warnings);

  const projectPromptAppends = [
    ...globalReviewer.projectPromptAppends,
    ...projectOverlay.promptAppends,
    ...repositoryPolicy.promptAppends,
  ];

  if (!trustedProject.trusted && projectPromptAppends.length > 0) {
    if (globalReviewer.projectPromptAppends.length > 0) {
      warnings.push({
        code: "global-project-prompt-appends-untrusted",
        path: paths.globalConfigFile,
        message:
          "Global project prompt appends were omitted because this project is not trusted.",
      });
    }
    if (projectOverlay.promptAppends.length > 0) {
      warnings.push({
        code: "project-prompt-appends-untrusted",
        path: paths.projectOverlayFile,
        message:
          "Project prompt appends were omitted because this project is not trusted.",
      });
    }
    if (repositoryPolicy.promptAppends.length > 0) {
      warnings.push({
        code: "repo-prompt-appends-untrusted",
        path: paths.repoPolicyFile,
        message:
          "Repository prompt appends were omitted because this project is not trusted.",
      });
    }
  }

  return {
    promptPosture: globalReviewer.promptPosture,
    promptAppends: [...globalReviewer.promptAppends],
    projectPromptAppends: trustedProject.trusted ? projectPromptAppends : [],
    promptOverride: globalReviewer.promptOverride,
    model: globalReviewer.model,
    tokenBudget: {
      window: globalReviewer.tokenBudget.window,
      limit: globalReviewer.tokenBudget.limit,
    },
    contextMode: globalReviewer.contextMode,
    recentContext: { ...globalReviewer.recentContext },
    escalation: { ...globalReviewer.escalation },
  };
}

async function readOptionalConfig<T extends TSchema>(
  filePath: string,
  schema: T,
  validationPhase: ConfigError["phase"],
): Promise<OptionalConfig<Static<T>>> {
  let rawText: string;
  try {
    rawText = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { kind: "missing" };
    }

    return {
      kind: "invalid",
      errors: [
        {
          phase: "io",
          path: filePath,
          message: errorMessage(error),
        },
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    return {
      kind: "invalid",
      errors: [
        {
          phase: validationPhase,
          path: filePath,
          message: `invalid JSON: ${errorMessage(error)}`,
        },
      ],
    };
  }

  // TypeBox Value.Default mutates nested objects, so preserve the parsed
  // document before normalization for raw key-presence checks.
  const rawBeforeDefaults = structuredClone(raw);
  const normalized = normalizeConfig(schema, raw);
  if (normalized.ok) {
    return { kind: "loaded", value: normalized.value, raw: rawBeforeDefaults };
  }

  return {
    kind: "invalid",
    errors: normalized.errors.map((error) => ({
      phase: validationPhase,
      path: filePath,
      message: `${error.path}: ${error.message}`,
    })),
  };
}

function collectInvalidErrors<T>(
  result: OptionalConfig<T>,
): readonly ConfigError[] {
  return result.kind === "invalid" ? result.errors : [];
}

function defaultGlobalConfig(_mode: "normal" | "strict"): GlobalConfig {
  const normalized = normalizeConfig(GlobalConfigSchema, { version: 1 });
  if (!normalized.ok) {
    throw new Error("Internal default global config failed schema validation");
  }
  return normalized.value;
}

function emptyProjectOverlay(): ProjectOverlayConfig {
  const normalized = normalizeConfig(ProjectOverlaySchema, { version: 1 });
  if (!normalized.ok) {
    throw new Error("Internal empty project overlay failed schema validation");
  }

  return normalized.value;
}

function emptyRepositoryPolicy(): RepositoryPolicyConfig {
  const normalized = normalizeConfig(RepositoryPolicySchema, { version: 1 });
  if (!normalized.ok) {
    throw new Error(
      "Internal empty repository policy failed schema validation",
    );
  }

  return normalized.value;
}

function withPackSource(
  packs: readonly RawPolicyPack[],
  source: PackSource,
): readonly RawPolicyPack[] {
  return packs.map((pack) => ({
    ...pack,
    rules: pack.rules.map((rule) => ({
      ...rule,
      provenance: { source },
    })),
  }));
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
