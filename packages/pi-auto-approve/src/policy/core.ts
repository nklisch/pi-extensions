import type {
  PathScope,
  PathUsageKind,
  Redirect,
  RedirectStream,
} from "../contracts/index.ts";
import {
  type NativeCompositionError,
  type NativeCompositionWarning,
  type NativeOverlap,
  requireNativeEngine,
} from "../native/loader.ts";
import type { ToolShape } from "../parse/shape.ts";

export type {
  BlockOperator,
  CompositionOperator,
  CompoundForm,
  MatcherExpr,
  MutationShapeKind,
  MutationTrustBoundaryKind,
  PathFactsRequirement,
  PathScopeMatcherExpr,
  PathScopeMatcherMode,
  PiFileMutationToolName,
} from "../contracts/index.ts";

import type {
  BlockOperator,
  CompositionOperator,
  CompoundForm,
  MatcherExpr,
  MutationShapeKind,
  MutationTrustBoundaryKind,
  PathFactsRequirement,
  PathScopeMatcherExpr,
  PathScopeMatcherMode,
  PiFileMutationToolName,
} from "../contracts/index.ts";

export const COMPOUND_FORMS = ["for", "brace-group", "if"] as const;
export const PI_FILE_MUTATION_TOOL_NAMES = ["edit", "write"] as const;
export const MUTATION_SHAPE_KINDS = [
  "well-formed",
  "create",
  "replace",
] as const;

export interface MutationToolMatcherOptions {
  readonly tools: readonly PiFileMutationToolName[];
}

export interface MutationShapeMatcherOptions {
  readonly shape: MutationShapeKind;
}

export interface MutationTrustBoundaryMatcherOptions {
  readonly in: readonly MutationTrustBoundaryKind[];
}

export interface EnvAssignmentNameMatcherOptions {
  readonly names?: readonly string[];
  readonly prefixes?: readonly string[];
  readonly caseInsensitivePrefixes?: readonly string[];
}

export interface FlagMatchesMatcherOptions {
  readonly names?: readonly string[];
  readonly prefixes?: readonly string[];
  readonly shortChars?: readonly string[];
}

export interface CountMatcherOptions {
  readonly min?: number;
  readonly max?: number;
}

export interface FlagAllowlistMatcherOptions {
  readonly names?: readonly string[];
  readonly shortChars?: readonly string[];
}

export interface FlagValueInMatcherOptions {
  readonly names: readonly string[];
  readonly values: readonly string[];
  /** Space-separated flag forms carry no inline value; ignore them when set. */
  readonly allowUndefinedValue?: boolean;
}

interface FlagCountMatcherOptions {
  readonly names?: readonly string[];
  readonly shortChars?: readonly string[];
  readonly max?: number;
  readonly min?: number;
}

export interface ArgMatchesMatcherOptions {
  readonly index: number;
  readonly pattern: string;
}

export interface PathScopeMatcherOptions {
  readonly scopes: readonly PathScope[];
  readonly programs?: readonly string[];
  readonly usages?: readonly PathUsageKind[];
  readonly allowExactPaths?: readonly string[];
  readonly forbidPathSegments?: readonly string[];
  readonly requireFacts?: PathFactsRequirement;
}

export interface CompoundScopeMatcherOptions {
  readonly scopes: readonly PathScope[];
}

/** A compiled policy matcher backed exclusively by the native inspectable DSL. */
export interface CompiledMatcher {
  readonly kind: "ir";
  readonly expr: MatcherExpr;
}

/** Compatibility alias for the current policy-rule seam; later units rename callers. */
export type Matcher = CompiledMatcher;

/** Always matches. Intended for deny-floor and broad gates only. */
export const always = (): MatcherExpr => ({ kind: "always" });

/** Match shapes for a given tool. `"bash"` narrows on kind; typed/unknown tools match by toolName. */
export const tool = (toolName: string): MatcherExpr => ({
  kind: "tool",
  tool: toolName,
});

export const program = (name: string): MatcherExpr => ({
  kind: "program",
  name,
});

export const arg0In = (values: readonly string[]): MatcherExpr => ({
  kind: "arg0In",
  values: [...values],
});

export const argAt = (index: number, value: string): MatcherExpr => ({
  kind: "argAt",
  index,
  value,
});

export const argCount = (options: CountMatcherOptions): MatcherExpr => ({
  kind: "argCount",
  ...(options.min === undefined ? {} : { min: options.min }),
  ...(options.max === undefined ? {} : { max: options.max }),
});

export const envAssignmentCount = (
  options: CountMatcherOptions,
): MatcherExpr => ({
  kind: "envAssignmentCount",
  ...(options.min === undefined ? {} : { min: options.min }),
  ...(options.max === undefined ? {} : { max: options.max }),
});

export const argMatches = (options: ArgMatchesMatcherOptions): MatcherExpr => ({
  kind: "argMatches",
  index: options.index,
  pattern: options.pattern,
});

export const flagPresent = (name: string): MatcherExpr => ({
  kind: "flagPresent",
  name,
});

export const flagMatches = (
  options: FlagMatchesMatcherOptions,
): MatcherExpr => ({
  kind: "flagMatches",
  ...(options.names === undefined ? {} : { names: [...options.names] }),
  ...(options.prefixes === undefined
    ? {}
    : { prefixes: [...options.prefixes] }),
  ...(options.shortChars === undefined
    ? {}
    : { shortChars: [...options.shortChars] }),
});

export const flagAllowlist = (
  options: FlagAllowlistMatcherOptions = {},
): MatcherExpr => ({
  kind: "flagAllowlist",
  ...(options.names === undefined ? {} : { names: [...options.names] }),
  ...(options.shortChars === undefined
    ? {}
    : { shortChars: [...options.shortChars] }),
});

export const flagValueIn = (
  options: FlagValueInMatcherOptions,
): MatcherExpr => ({
  kind: "flagValueIn",
  names: [...options.names],
  values: [...options.values],
  ...(options.allowUndefinedValue === undefined
    ? {}
    : { allowUndefinedValue: options.allowUndefinedValue }),
});

/** Count flags (optionally name-filtered) on every command stage. */
export const flagCount = (
  options: FlagCountMatcherOptions = {},
): MatcherExpr => ({
  kind: "flagCount",
  ...(options.names === undefined ? {} : { names: [...options.names] }),
  ...(options.shortChars === undefined
    ? {}
    : { shortChars: [...options.shortChars] }),
  ...(options.max === undefined ? {} : { max: options.max }),
  ...(options.min === undefined ? {} : { min: options.min }),
});

/** Some command stage has some argument matching the anchored pattern. */
export const anyArgMatches = (pattern: string): MatcherExpr => ({
  kind: "anyArgMatches",
  pattern,
});

export const envAssignmentNameIn = (
  options: EnvAssignmentNameMatcherOptions,
): MatcherExpr => ({
  kind: "envAssignmentNameIn",
  ...(options.names === undefined ? {} : { names: [...options.names] }),
  ...(options.prefixes === undefined
    ? {}
    : { prefixes: [...options.prefixes] }),
  ...(options.caseInsensitivePrefixes === undefined
    ? {}
    : { caseInsensitivePrefixes: [...options.caseInsensitivePrefixes] }),
});

export const noSubstitution = (): MatcherExpr => ({ kind: "noSubstitution" });

export const noStdoutRedirect = (): MatcherExpr => ({
  kind: "noStdoutRedirect",
});

export const redirect = (
  options: {
    readonly stream?: RedirectStream;
    readonly target?: string;
    readonly targetKind?: Redirect["targetKind"];
  } = {},
): MatcherExpr =>
  options.stream === undefined &&
  options.target === undefined &&
  options.targetKind === undefined
    ? { kind: "redirect" }
    : {
        kind: "redirect",
        ...(options.stream === undefined ? {} : { stream: options.stream }),
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.targetKind === undefined
          ? {}
          : { targetKind: options.targetKind }),
      };

export const pipeline = (target: string): MatcherExpr => ({
  kind: "pipeline",
  target,
});

export const operator = (op: BlockOperator): MatcherExpr => ({
  kind: "operator",
  op,
});

export const stageEvery = (inner: MatcherExpr): MatcherExpr => ({
  kind: "stageEvery",
  inner,
});

export const stageSome = (inner: MatcherExpr): MatcherExpr => ({
  kind: "stageSome",
  inner,
});

export const compoundForm = (form: CompoundForm): MatcherExpr => ({
  kind: "compoundForm",
  form,
});

export const bodyStagesAllReadOnly = (): MatcherExpr => ({
  kind: "bodyStagesAllReadOnly",
});

export const bodyStagesAllScopeIn = (
  options: CompoundScopeMatcherOptions,
): MatcherExpr => ({
  kind: "bodyStagesAllScopeIn",
  scopes: [...options.scopes],
});

export const iteratorScopesAllIn = (
  options: CompoundScopeMatcherOptions,
): MatcherExpr => ({
  kind: "iteratorScopesAllIn",
  scopes: [...options.scopes],
});

export const noBodySubstitution = (): MatcherExpr => ({
  kind: "noBodySubstitution",
});

export const noBodyShellWrap = (): MatcherExpr => ({
  kind: "noBodyShellWrap",
});

export const noBodyRedirectTo = (): MatcherExpr => ({
  kind: "noBodyRedirectTo",
});

export const diagnosticCode = (code: string): MatcherExpr => ({
  kind: "diagnosticCode",
  code,
});

export const composition = (options: {
  readonly stage: MatcherExpr;
  readonly operators: readonly CompositionOperator[];
  readonly allowBackground?: boolean;
  readonly minStages?: number;
  readonly orFallback?: readonly string[];
}): MatcherExpr => ({
  kind: "composition",
  stage: options.stage,
  operators: [...options.operators],
  ...(options.allowBackground === undefined
    ? {}
    : { allowBackground: options.allowBackground }),
  ...(options.minStages === undefined ? {} : { minStages: options.minStages }),
  ...(options.orFallback === undefined
    ? {}
    : { orFallback: [...options.orFallback] }),
});

export const all = (of: readonly MatcherExpr[]): MatcherExpr => ({
  kind: "all",
  of: [...of],
});

export const any = (of: readonly MatcherExpr[]): MatcherExpr => ({
  kind: "any",
  of: [...of],
});

export const not = (of: MatcherExpr): MatcherExpr => ({ kind: "not", of });

export const mutationTool = (
  options: MutationToolMatcherOptions,
): MatcherExpr => ({
  kind: "mutationTool",
  tools: [...options.tools],
});

export const mutationShape = (
  options: MutationShapeMatcherOptions,
): MatcherExpr => ({
  kind: "mutationShape",
  shape: options.shape,
});

export const mutationTrustBoundary = (
  options: MutationTrustBoundaryMatcherOptions,
): MatcherExpr => ({
  kind: "mutationTrustBoundary",
  in: [...options.in],
});

/**
 * Path-scope predicates over `BashCommandShape.pathFacts`. `all-in` requires every
 * selected path fact's winning `scope` to be in `scopes`; `none-in` requires none;
 * `some-in` requires at least one. All three fail closed when `pathFacts` is
 * absent. Input arrays are copied so callers cannot mutate the IR through aliases.
 */
export function pathScopesAllIn(options: PathScopeMatcherOptions): MatcherExpr {
  return makePathScopeMatcher("all-in", options, "one-or-more");
}

export function pathScopesNoneIn(
  options: PathScopeMatcherOptions,
): MatcherExpr {
  return makePathScopeMatcher("none-in", options, undefined);
}

export function pathScopesSomeIn(
  options: PathScopeMatcherOptions,
): MatcherExpr {
  return makePathScopeMatcher("some-in", options, "one-or-more");
}

function makePathScopeMatcher(
  mode: PathScopeMatcherMode,
  options: PathScopeMatcherOptions,
  defaultRequirement: PathFactsRequirement | undefined,
): PathScopeMatcherExpr {
  const requireFacts = options.requireFacts ?? defaultRequirement;
  return {
    kind: "pathScope",
    mode,
    scopes: [...options.scopes],
    ...(options.programs !== undefined
      ? { programs: [...options.programs] }
      : {}),
    ...(options.usages !== undefined ? { usages: [...options.usages] } : {}),
    ...(options.allowExactPaths !== undefined
      ? { allowExactPaths: [...options.allowExactPaths] }
      : {}),
    ...(options.forbidPathSegments !== undefined
      ? { forbidPathSegments: [...options.forbidPathSegments] }
      : {}),
    ...(requireFacts !== undefined ? { requireFacts } : {}),
  };
}

export const inspectable = (expr: MatcherExpr): CompiledMatcher => ({
  kind: "ir",
  expr,
});

/** Total evaluator. Unsupported or malformed matcher data fails closed to `false`. */
/**
 * Advisory specificity hint. Intentionally coarse; `matcherSpecificity` in
 * `matcherSpecificity` below is the authoritative same-effect tie-break
 * consumed by the native-backed interpreter. This helper remains a coarse
 * authoring hint and intentionally shares the same inspectable IR.
 */
export function specificity(expr: MatcherExpr): number {
  switch (expr.kind) {
    case "always":
      return 0;
    case "tool":
      return 1;
    case "program":
    case "arg0In":
    case "argAt":
    case "argMatches":
    case "argCount":
    case "envAssignmentCount":
    case "flagPresent":
    case "noSubstitution":
    case "noStdoutRedirect":
    case "redirect":
    case "pipeline":
    case "operator":
      return 2;
    case "stageEvery":
    case "stageSome":
      return 1 + specificity(expr.inner);
    case "flagMatches":
    case "flagValueIn":
    case "flagCount":
    case "anyArgMatches":
    case "envAssignmentNameIn":
      return 3;
    case "flagAllowlist":
      return 2;
    case "compoundForm":
    case "bodyStagesAllReadOnly":
    case "bodyStagesAllScopeIn":
    case "iteratorScopesAllIn":
    case "noBodySubstitution":
    case "noBodyShellWrap":
    case "noBodyRedirectTo":
    case "diagnosticCode":
      return 3;
    case "composition":
      return 2 + specificity(expr.stage) + expr.operators.length;
    case "all":
      return expr.of.reduce((sum, child) => sum + specificity(child), 0);
    case "any":
      return Math.max(0, ...expr.of.map((child) => specificity(child)));
    case "not":
      return 0;
    case "mutationTool":
      return (
        2 +
        inverseWidth(expr.tools.length || PI_FILE_MUTATION_TOOL_NAMES.length)
      );
    case "mutationShape":
    case "mutationTrustBoundary":
      return 3;
    case "pathScope": {
      // Mirrors the native-backed same-effect comparator for path-scope predicates:
      // broad safety-sentinel outrank, with bonuses only for active coverage
      // guards (`programs` matters when per-command-stage makes it load-bearing).
      let score = 3;
      if (expr.requireFacts === "per-command-stage") {
        score += 1;
        if (expr.programs !== undefined) {
          score += 1;
        }
      }
      return score;
    }
  }
}

function inverseWidth(width: number): number {
  return width <= 0 ? 0 : 1 / width;
}

export interface CompileError {
  readonly packId: string | null;
  readonly ruleId: string | null;
  readonly path: string;
  readonly message: string;
}
export interface PackCompileResult {
  readonly pack: PolicyPack | null;
  readonly errors: readonly CompileError[];
}
export type MatcherCompileResult =
  | { readonly expr: MatcherExpr; readonly errors?: never }
  | { readonly errors: readonly CompileError[]; readonly expr?: never };

export type TriOverlap = NativeOverlap;

export interface PolicyCompositionError {
  readonly packId: string | null;
  readonly ruleId: string | null;
  readonly path: string;
  readonly message: string;
}

export interface PolicyCompositionWarning {
  readonly code: string;
  readonly packId: string | null;
  readonly ruleId: string | null;
  readonly message: string;
}

export type PolicyCompositionResult =
  | {
      readonly ok: true;
      readonly policy: EffectivePolicy;
      readonly warnings: readonly PolicyCompositionWarning[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly PolicyCompositionError[];
      readonly warnings: readonly PolicyCompositionWarning[];
    };

import type {
  Decision as ContractDecision,
  DecisionEffect as ContractDecisionEffect,
  DecisionProvenance as ContractDecisionProvenance,
  DecisionSource as ContractDecisionSource,
  EffectivePolicy as ContractEffectivePolicy,
  PackWarningLevel as ContractPackWarningLevel,
  PolicyPack as ContractPolicyPack,
  PolicyPackDocLink as ContractPolicyPackDocLink,
  PolicyPackExample as ContractPolicyPackExample,
  PolicyPackMetadata as ContractPolicyPackMetadata,
  PolicyPackWarning as ContractPolicyPackWarning,
  PolicyRule as ContractPolicyRule,
} from "../contracts/index.ts";

export type PolicyRule = Omit<ContractPolicyRule, "match"> & {
  readonly match: CompiledMatcher;
};
export type PolicyPack = Omit<ContractPolicyPack, "rules"> & {
  readonly rules: readonly PolicyRule[];
};
export type EffectivePolicy = Omit<
  ContractEffectivePolicy,
  "floor" | "active" | "rules"
> & {
  readonly floor?: readonly PolicyRule[];
  readonly active?: readonly PolicyRule[];
  readonly rules?: readonly PolicyRule[];
};
export type Decision = ContractDecision;
export type DecisionEffect = ContractDecisionEffect;
export type DecisionSource = ContractDecisionSource;
export type PolicyPackMetadata = ContractPolicyPackMetadata;
export type PolicyPackDocLink = ContractPolicyPackDocLink;
export type PolicyPackExample = ContractPolicyPackExample;
export type PolicyPackWarning = ContractPolicyPackWarning;
export type PackWarningLevel = ContractPackWarningLevel;
export type DecisionProvenance = ContractDecisionProvenance;

export function evalMatcher(
  matcher: CompiledMatcher,
  shape: ToolShape,
): boolean {
  try {
    return requireNativeEngine().match(matcher.expr, shape);
  } catch {
    return false;
  }
}
export function getMatcherExpr(matcher: CompiledMatcher): MatcherExpr {
  return matcher.expr;
}

export function compilePack(raw: unknown): PackCompileResult {
  try {
    const result = requireNativeEngine().compilePack(raw);
    return {
      pack: result.pack == null ? null : wrapPack(result.pack),
      errors: result.errors.map(normalizeCompileError),
    };
  } catch (error: unknown) {
    const object = raw as {
      readonly id?: unknown;
      readonly rules?: readonly { readonly id?: unknown }[];
    };
    const cycle = circularValuePath(raw);
    if (cycle !== null) {
      const rule = object?.rules?.[0];
      const packId = typeof object?.id === "string" ? object.id : null;
      const ruleId = typeof rule?.id === "string" ? rule.id : null;
      const path = cycle.startsWith("$.") ? cycle.slice(2) : cycle;
      return {
        pack: null,
        errors: [
          {
            packId,
            ruleId,
            path,
            message: path.includes(".scopes[")
              ? "invalid scope"
              : "circular matcher object",
          },
        ],
      };
    }
    return {
      pack: null,
      errors: [
        {
          packId: null,
          ruleId: null,
          path: "$",
          message: `compiler error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
export function compileMatch(raw: unknown): MatcherCompileResult {
  try {
    const result = requireNativeEngine().compileMatch(raw);
    return result.expr === undefined
      ? { errors: (result.errors ?? []).map(normalizeCompileError) }
      : { expr: result.expr };
  } catch (error: unknown) {
    return {
      errors: [
        {
          packId: null,
          ruleId: null,
          path: "$",
          message: `compiler error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
export function compilePackMetadata(raw: unknown): {
  readonly metadata: PolicyPackMetadata | null;
  readonly errors: readonly CompileError[];
} {
  if (raw === undefined) return { metadata: null, errors: [] };
  try {
    const result = requireNativeEngine().compilePackMetadata(raw);
    return {
      metadata: result.metadata ?? null,
      errors: result.errors.map(normalizeCompileError),
    };
  } catch (error: unknown) {
    return {
      metadata: null,
      errors: [
        {
          packId: null,
          ruleId: null,
          path: "$",
          message: `compiler error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
function normalizeCompileError(
  error: import("../contracts/index.ts").CompileError,
): CompileError {
  return {
    packId: error.packId ?? null,
    ruleId: error.ruleId ?? null,
    path: error.path,
    message: error.message,
  };
}
function circularValuePath(value: unknown): string | null {
  const walk = (
    candidate: unknown,
    path: string,
    seen: WeakSet<object>,
  ): string | null => {
    if (typeof candidate !== "object" || candidate === null) return null;
    if (seen.has(candidate)) return path;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (let index = 0; index < candidate.length; index++) {
        const cycle = walk(candidate[index], `${path}[${index}]`, seen);
        if (cycle !== null) return cycle;
      }
    } else {
      for (const [key, child] of Object.entries(candidate)) {
        const cycle = walk(child, `${path}.${key}`, seen);
        if (cycle !== null) return cycle;
      }
    }
    return null;
  };
  return walk(value, "$", new WeakSet<object>());
}
function wrapPack(pack: ContractPolicyPack): PolicyPack {
  return {
    ...pack,
    rules: pack.rules.map((rule) => ({
      ...rule,
      match: inspectable(rule.match),
    })),
  } as PolicyPack;
}
function serializePack(pack: PolicyPack): unknown {
  return {
    ...pack,
    rules: pack.rules.map((rule) => ({
      ...rule,
      match: unwrapMatcher(rule.match),
    })),
  };
}

function wrapNativeRule(rule: ContractPolicyRule): PolicyRule {
  return { ...rule, match: inspectable(rule.match) };
}

function wrapNativePolicy(policy: {
  readonly floor: readonly unknown[];
  readonly active: readonly unknown[];
}): EffectivePolicy {
  return {
    floor: policy.floor.map((rule) =>
      wrapNativeRule(rule as ContractPolicyRule),
    ),
    active: policy.active.map((rule) =>
      wrapNativeRule(rule as ContractPolicyRule),
    ),
  };
}

function normalizeCompositionError(
  error: NativeCompositionError,
): PolicyCompositionError {
  return {
    packId: error.packId ?? null,
    ruleId: error.ruleId ?? null,
    path: error.path,
    message: error.message,
  };
}

function normalizeCompositionWarning(
  warning: NativeCompositionWarning,
): PolicyCompositionWarning {
  return {
    code: warning.code,
    packId: warning.packId ?? null,
    ruleId: warning.ruleId ?? null,
    message: warning.message,
  };
}

/** Native conservative overlap verdict used by tune-time floor checks. */
export function classifyOverlap(
  left: MatcherExpr,
  right: MatcherExpr,
): TriOverlap {
  try {
    return requireNativeEngine().classifyOverlap(left, right);
  } catch {
    return "unknown";
  }
}

/** Native recognizer for the approved compound allow proof bundle. */
export function validateCompoundAllowCanonicality(expr: MatcherExpr):
  | {
      readonly applies: false;
    }
  | {
      readonly applies: true;
      readonly ok: true;
    }
  | {
      readonly applies: true;
      readonly ok: false;
      readonly reason: string;
    } {
  try {
    const result =
      requireNativeEngine().validateCompoundAllowCanonicality(expr);
    return result.applies
      ? result.ok === true
        ? { applies: true, ok: true }
        : {
            applies: true,
            ok: false,
            reason: result.reason ?? "invalid canonical bundle",
          }
      : { applies: false };
  } catch {
    return {
      applies: true,
      ok: false,
      reason: "native canonical compound validation failed",
    };
  }
}

/** Validate one compiled pack against the native sealed floor gate. */
export function validatePackAgainstFloor(
  floor: PolicyPack,
  pack: PolicyPack,
): {
  readonly errors: readonly PolicyCompositionError[];
  readonly warnings: readonly PolicyCompositionWarning[];
} {
  try {
    const result = requireNativeEngine().validatePackAgainstFloor({
      floor: serializePack(floor),
      pack: serializePack(pack),
    });
    return {
      errors: result.errors.map(normalizeCompositionError),
      warnings: result.warnings.map(normalizeCompositionWarning),
    };
  } catch (error: unknown) {
    return {
      errors: [
        {
          packId: null,
          ruleId: null,
          path: "$",
          message: `native floor validation failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      warnings: [],
    };
  }
}

/** Compose compiled packs through the native sealed-floor overlap gate. */
export function composePolicy(
  floor: PolicyPack,
  active: readonly PolicyPack[],
): PolicyCompositionResult {
  try {
    const result = requireNativeEngine().composePolicy({
      floor: serializePack(floor),
      active: active.map(serializePack),
    });
    const warnings = result.warnings.map(normalizeCompositionWarning);
    const errors = result.errors.map(normalizeCompositionError);
    if (errors.length > 0 || result.policy == null) {
      return { ok: false, errors, warnings };
    }
    return { ok: true, policy: wrapNativePolicy(result.policy), warnings };
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [
        {
          packId: null,
          ruleId: null,
          path: "$",
          message: `native composition failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      warnings: [],
    };
  }
}

function unwrapMatcher(matcher: CompiledMatcher): MatcherExpr {
  return matcher.expr;
}
function serializePolicy(policy: EffectivePolicy): unknown {
  const rules = (
    values: readonly PolicyRule[] | undefined,
  ): readonly unknown[] | undefined =>
    values?.map((rule) => ({ ...rule, match: unwrapMatcher(rule.match) }));
  return {
    ...policy,
    ...(rules(policy.floor) === undefined
      ? {}
      : { floor: rules(policy.floor) }),
    ...(rules(policy.active) === undefined
      ? {}
      : { active: rules(policy.active) }),
    ...(rules(policy.rules) === undefined
      ? {}
      : { rules: rules(policy.rules) }),
  };
}
export interface NativePolicyHandle {
  readonly handle: string;
  readonly free: () => void;
}
export function createNativePolicyHandle(
  policy: EffectivePolicy,
): NativePolicyHandle {
  const result = requireNativeEngine().compilePolicy(serializePolicy(policy));
  const handle = result.handle;
  if (handle === undefined || result.errors.length > 0)
    throw new Error(
      result.errors.join("; ") || "native policy compilation failed",
    );
  let freed = false;
  return {
    handle,
    free: () => {
      if (!freed) {
        freed = true;
        requireNativeEngine().freePolicy(handle);
      }
    },
  };
}
export function decideNativePolicy(
  handle: NativePolicyHandle,
  shape: ToolShape,
): Decision {
  return requireNativeEngine().decide(handle.handle, shape);
}

/** Evaluate multiple shapes in one native JSON crossing. */
export function decideNativePolicyBatch(
  handle: NativePolicyHandle,
  shapes: readonly ToolShape[],
): readonly Decision[] {
  return requireNativeEngine().decideBatch(handle.handle, shapes);
}

export type ChooseWinning = (
  rules: readonly PolicyRule[],
  shape: ToolShape,
) => PolicyRule;
export const defaultChooseWinning: ChooseWinning = (rules) => {
  const first = rules[0];
  if (first === undefined)
    throw new Error("defaultChooseWinning requires at least one rule");
  return first;
};
const EFFECT_RANK: Record<DecisionEffect, number> = {
  allow: 1,
  review: 2,
  deny: 3,
};
const SOURCE_PRIORITY: Record<DecisionSource, number> = {
  generated: 0,
  shipped: 1,
  "trusted-repo": 2,
  package: 2,
  "user-global": 3,
  "user-project": 4,
  default: 0,
};
export function effectRank(effect: DecisionEffect): number {
  return EFFECT_RANK[effect];
}
export function sourcePriority(source: DecisionSource): number {
  return SOURCE_PRIORITY[source];
}
export function matcherSpecificity(expr: MatcherExpr): number {
  switch (expr.kind) {
    case "always":
      return 0;
    case "tool":
      return 1;
    case "mutationTool":
      return 2 + 1 / (expr.tools.length || 2);
    case "mutationShape":
    case "mutationTrustBoundary":
    case "program":
    case "flagMatches":
    case "flagValueIn":
    case "flagCount":
    case "anyArgMatches":
    case "envAssignmentNameIn":
    case "compoundForm":
    case "bodyStagesAllReadOnly":
    case "bodyStagesAllScopeIn":
    case "iteratorScopesAllIn":
    case "noBodySubstitution":
    case "noBodyShellWrap":
    case "noBodyRedirectTo":
    case "diagnosticCode":
      return 3;
    case "arg0In":
      return 2 + (expr.values.length > 0 ? 1 / expr.values.length : 0);
    case "argAt":
      return 3;
    case "argCount":
    case "envAssignmentCount":
    case "argMatches":
    case "flagPresent":
    case "flagAllowlist":
    case "noSubstitution":
    case "noStdoutRedirect":
    case "redirect":
    case "pipeline":
    case "operator":
      return 2;
    case "stageEvery":
      return matcherSpecificity(expr.inner) + 1;
    case "stageSome":
      return matcherSpecificity(expr.inner);
    case "composition":
      return (
        matcherSpecificity(expr.stage) +
        expr.operators.length +
        (expr.allowBackground === true ? 0 : 1)
      );
    case "all":
      return expr.of.reduce((sum, child) => sum + matcherSpecificity(child), 0);
    case "any":
      return Math.max(0, ...expr.of.map(matcherSpecificity));
    case "not":
      return 0;
    case "pathScope":
      return (
        3 +
        (expr.requireFacts === "per-command-stage"
          ? 1 + (expr.programs === undefined ? 0 : 1)
          : 0)
      );
  }
}
export function compareSameEffect(a: PolicyRule, b: PolicyRule): number {
  return (
    matcherSpecificity(getMatcherExpr(a.match)) -
      matcherSpecificity(getMatcherExpr(b.match)) ||
    sourcePriority(a.provenance.source) - sourcePriority(b.provenance.source)
  );
}
export const specificityChooseWinning: ChooseWinning = (rules) => {
  const first = rules[0];
  if (first === undefined)
    throw new Error("specificityChooseWinning requires at least one rule");
  return rules
    .slice(1)
    .reduce(
      (best, rule) => (compareSameEffect(rule, best) > 0 ? rule : best),
      first,
    );
};
export function decide(
  shape: ToolShape,
  policy: EffectivePolicy,
): Decision {
  try {
    const native = createNativePolicyHandle(policy);
    try {
      return decideNativePolicy(native, shape);
    } finally {
      native.free();
    }
  } catch {
    return {
      effect: "review",
      reason: "interpreter error",
      provenance: { source: "default" },
    };
  }
}
function decisionFromRule(rule: PolicyRule): Decision {
  return {
    effect: rule.effect,
    reason: rule.reason.startsWith(`${rule.id}:`)
      ? rule.reason
      : `${rule.id}: ${rule.reason}`,
    provenance: rule.provenance,
  };
}
