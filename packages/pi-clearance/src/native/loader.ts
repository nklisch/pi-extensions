import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BashStage,
  CompileError,
  Decision,
  MatcherExpr,
  PackCompileResult,
  PolicyPackMetadata,
  ToolShape,
} from "../contracts/index.ts";

export type NativeOverlap = "overlap" | "disjoint" | "unknown";

export interface NativeCompositionError {
  readonly packId: string | null;
  readonly ruleId: string | null;
  readonly path: string;
  readonly message: string;
}

export interface NativeCompositionWarning {
  readonly code: string;
  readonly packId: string | null;
  readonly ruleId: string | null;
  readonly message: string;
}

export interface NativeCompositionResult {
  readonly policy?: {
    readonly floor: readonly unknown[];
    readonly active: readonly unknown[];
  } | null;
  readonly warnings: readonly NativeCompositionWarning[];
  readonly errors: readonly NativeCompositionError[];
}

/** The synchronous health contract exposed by the native Node-API module. */
export interface NativeHealth {
  readonly version: string;
  readonly grammarVersion: string;
  readonly target: string;
}

export interface NativeStageEffect {
  readonly class:
    | "read-only"
    | "write"
    | "destructive"
    | "network"
    | "shell-wrap"
    | "unknown";
  readonly reason: string;
}

export interface NativeClearanceEngine {
  readonly health: () => NativeHealth;
  readonly parseBash: (command: string) => ToolShape;
  readonly analyzeTool: (toolName: string, input: unknown) => ToolShape;
  readonly classifyStageEffect: (stage: BashStage) => NativeStageEffect;
  readonly effectRegistry: () => readonly NativeEffectRegistryEntry[];
  readonly stageFileInputIndices: (stage: BashStage) => readonly number[];
  readonly classifyMutationTrustBoundary: (
    path: string | undefined,
    context: unknown,
  ) => MutationTrustBoundaryClassification;
  readonly enrichPathFacts: (shape: ToolShape, context: unknown) => ToolShape;
  readonly classifyPathFact: (input: unknown, context: unknown) => unknown;
  readonly reduceIteratorEntry: (
    entry: unknown,
    effectiveCwd: string,
    context: unknown,
    home: string | undefined,
  ) => unknown;
  readonly reduceForLoopIterator: (
    stage: unknown,
    effectiveCwd: string,
    context: unknown,
    home: string | undefined,
  ) => unknown;
  readonly compilePack: (pack: unknown) => PackCompileResult;
  readonly compileMatch: (matcher: unknown) => {
    readonly expr?: MatcherExpr;
    readonly errors?: readonly CompileError[];
  };
  readonly compilePackMetadata: (metadata: unknown) => {
    readonly metadata?: PolicyPackMetadata;
    readonly errors: readonly CompileError[];
  };
  readonly createPolicy: (policy: unknown) => {
    readonly handle?: string;
    readonly errors: readonly string[];
  };
  readonly compilePolicy: (policy: unknown) => {
    readonly handle?: string;
    readonly errors: readonly string[];
  };
  readonly composePolicy: (request: unknown) => NativeCompositionResult;
  readonly validatePackAgainstFloor: (request: unknown) => {
    readonly warnings: readonly NativeCompositionWarning[];
    readonly errors: readonly NativeCompositionError[];
  };
  readonly classifyOverlap: (
    left: MatcherExpr,
    right: MatcherExpr,
  ) => NativeOverlap;
  readonly validateCompoundAllowCanonicality: (expr: MatcherExpr) => {
    readonly applies: boolean;
    readonly ok?: boolean;
    readonly reason?: string;
  };
  readonly decide: (handle: string, shape: ToolShape) => Decision;
  readonly decideBatch: (
    handle: string,
    shapes: readonly ToolShape[],
  ) => readonly Decision[];
  readonly match: (matcher: MatcherExpr, shape: ToolShape) => boolean;
  readonly freePolicy: (handle: string) => boolean;
  readonly buildCorpusModel: (
    corpus: unknown,
    handle: string,
    options?: unknown,
  ) => unknown;
  readonly replayDelta: (
    corpus: unknown,
    baselineHandle: string,
    candidateHandle: string,
    options?: unknown,
  ) => unknown;
  readonly adversarialValidate: (
    proposal: unknown,
    baselineHandle: string,
    candidateHandle?: string,
    options?: unknown,
  ) => unknown;
}

export interface MutationTrustBoundaryClassification {
  readonly kind:
    | "none"
    | "project-overlay"
    | "policy-pack"
    | "reviewer-config"
    | "executable-hook"
    | "package-script"
    | "user-owned-config"
    | "sensitive-home"
    | "unknown";
  readonly matchedPattern?: string;
}

export interface NativeEffectCondition {
  readonly requireAnyFlag?: readonly string[];
  readonly forbidAnyFlag?: readonly string[];
  readonly forbidFlagNamePrefixes?: readonly string[];
  readonly forbidShortFlagChars?: readonly string[];
  readonly forbidArgumentFlags?: readonly string[];
  readonly requireArgumentShape?: "sed-print-only" | "none";
}

export interface NativeEffectRegistryEntry {
  readonly program: string;
  readonly class: NativeStageEffect["class"];
  readonly condition?: NativeEffectCondition;
  readonly fileInputs?: {
    readonly kind: "none" | "positional";
    readonly mode?: "all" | "program-specific";
  };
  readonly reason: string;
}

export type NativeEngineStatus =
  | {
      readonly ok: true;
      readonly engine: NativeClearanceEngine;
      readonly health: NativeHealth;
      readonly modulePath: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly attemptedPaths: readonly string[];
    };

const require = createRequire(import.meta.url);
const NATIVE_MODULE_BASENAME = "clearance-core";
let cachedStatus: NativeEngineStatus | undefined;

/**
 * Resolve the platform artifact supported by this package.
 *
 * These names match napi-rs's platform optional-package suffixes and the
 * prebuild files staged by `native:prepare`.
 */
export function nativePlatformTriple(): string | undefined {
  // Map the host platform/arch to a napi-rs platform-package suffix. Every
  // common dev platform is covered. The list of *built* prebuilds is the
  // narrower one in `package.json` `napi.targets`; this function returns a
  // suffix for any platform Node can run on so the load path produces a
  // precise "no prebuild for this platform" error rather than a generic
  // "unsupported native platform" when the host is genuinely novel.
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64-gnu";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64-msvc";
  if (process.platform === "win32" && process.arch === "arm64") return "win32-arm64-msvc";
  return undefined;
}

/**
 * Lazily load and validate the native engine once.
 *
 * A failed load is memoized deliberately: retrying a broken binary during a
 * tool call can turn one startup problem into inconsistent runtime behavior.
 */
export function loadNativeEngine(): NativeEngineStatus {
  if (cachedStatus !== undefined) return cachedStatus;

  const triple = nativePlatformTriple();
  if (triple === undefined) {
    cachedStatus = {
      ok: false,
      reason: `unsupported native platform ${process.platform}/${process.arch}`,
      attemptedPaths: [],
    };
    return cachedStatus;
  }

  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const modulePath = join(
    packageRoot,
    "native",
    `${NATIVE_MODULE_BASENAME}.${triple}.node`,
  );
  const attemptedPaths = [modulePath];

  try {
    const candidate: unknown = require(modulePath);
    const engine = asNativeEngine(candidate);
    const health = engine.health();
    cachedStatus = { ok: true, engine, health, modulePath };
  } catch (error: unknown) {
    cachedStatus = {
      ok: false,
      reason: nativeLoadError(error),
      attemptedPaths,
    };
  }
  return cachedStatus;
}

/** Require the native engine for extension activation; failure is fail-closed. */
export function requireNativeEngine(): NativeClearanceEngine {
  const status = loadNativeEngine();
  if (!status.ok) {
    const paths =
      status.attemptedPaths.length === 0
        ? "no artifact for this platform"
        : status.attemptedPaths.join(", ");
    throw new Error(
      `Pi Clearance native engine unavailable; extension refused to arm: ${status.reason}. Tried: ${paths}`,
    );
  }
  return status.engine;
}

/** Compact operator-facing label for status-line diagnostics. */
export function nativeHealthLabel(health: NativeHealth): string {
  return `native engine ${health.version} · ${health.grammarVersion} · ${health.target}`;
}

/** Test-only cache reset; production callers must keep one load lifecycle. */
export function __resetNativeEngineForTests(): void {
  cachedStatus = undefined;
}

function asNativeEngine(candidate: unknown): NativeClearanceEngine {
  if (
    !isRecord(candidate) ||
    typeof candidate.health !== "function" ||
    typeof candidate.parseBash !== "function" ||
    typeof candidate.analyzeTool !== "function" ||
    typeof candidate.classifyStageEffect !== "function" ||
    typeof candidate.effectRegistry !== "function" ||
    typeof candidate.stageFileInputIndices !== "function" ||
    typeof candidate.classifyMutationTrustBoundary !== "function" ||
    typeof candidate.enrichPathFacts !== "function" ||
    typeof candidate.classifyPathFact !== "function" ||
    typeof candidate.reduceIteratorEntry !== "function" ||
    typeof candidate.reduceForLoopIterator !== "function" ||
    typeof candidate.compilePack !== "function" ||
    typeof candidate.compileMatch !== "function" ||
    typeof candidate.compilePackMetadata !== "function" ||
    typeof candidate.createPolicy !== "function" ||
    typeof candidate.compilePolicy !== "function" ||
    typeof candidate.composePolicy !== "function" ||
    typeof candidate.validatePackAgainstFloor !== "function" ||
    typeof candidate.classifyOverlap !== "function" ||
    typeof candidate.validateCompoundAllowCanonicality !== "function" ||
    typeof candidate.decide !== "function" ||
    typeof candidate.decideBatch !== "function" ||
    typeof candidate.match !== "function" ||
    typeof candidate.freePolicy !== "function" ||
    typeof candidate.buildCorpusModel !== "function" ||
    typeof candidate.replayDelta !== "function" ||
    typeof candidate.adversarialValidate !== "function"
  ) {
    throw new Error("native module does not expose the S8 clearance API");
  }
  const healthFn = candidate.health;
  const parseBashFn = candidate.parseBash;
  const analyzeToolFn = candidate.analyzeTool;
  const classifyStageEffectFn = candidate.classifyStageEffect;
  const effectRegistryFn = candidate.effectRegistry;
  const stageFileInputIndicesFn = candidate.stageFileInputIndices;
  const classifyMutationTrustBoundaryFn =
    candidate.classifyMutationTrustBoundary;
  const enrichPathFactsFn = candidate.enrichPathFacts;
  const classifyPathFactFn = candidate.classifyPathFact;
  const reduceIteratorEntryFn = candidate.reduceIteratorEntry;
  const reduceForLoopIteratorFn = candidate.reduceForLoopIterator;
  const compilePackFn = candidate.compilePack;
  const compileMatchFn = candidate.compileMatch;
  const compilePackMetadataFn = candidate.compilePackMetadata;
  const createPolicyFn = candidate.createPolicy;
  const compilePolicyFn = candidate.compilePolicy;
  const composePolicyFn = candidate.composePolicy;
  const validatePackAgainstFloorFn = candidate.validatePackAgainstFloor;
  const classifyOverlapFn = candidate.classifyOverlap;
  const validateCompoundAllowCanonicalityFn =
    candidate.validateCompoundAllowCanonicality;
  const decideFn = candidate.decide;
  const decideBatchFn = candidate.decideBatch;
  const matchFn = candidate.match;
  const freePolicyFn = candidate.freePolicy;
  const buildCorpusModelFn = candidate.buildCorpusModel;
  const replayDeltaFn = candidate.replayDelta;
  const adversarialValidateFn = candidate.adversarialValidate;

  return {
    health: () => {
      const health = healthFn();
      if (!isNativeHealth(health)) {
        throw new Error("native health() returned an invalid payload");
      }
      return health;
    },
    parseBash: (command) =>
      decodeNativeJson<ToolShape>(parseBashFn(command), "parseBash"),
    analyzeTool: (toolName, input) => {
      const encoded = JSON.stringify(input === undefined ? null : input);
      return decodeNativeJson<ToolShape>(
        analyzeToolFn(toolName, encoded),
        "analyzeTool",
      );
    },
    classifyStageEffect: (stage) =>
      decodeNativeJson<NativeStageEffect>(
        classifyStageEffectFn(JSON.stringify(stage)),
        "classifyStageEffect",
      ),
    effectRegistry: () =>
      decodeNativeJson<readonly NativeEffectRegistryEntry[]>(
        effectRegistryFn(),
        "effectRegistry",
      ),
    stageFileInputIndices: (stage) =>
      decodeNativeJson<readonly number[]>(
        stageFileInputIndicesFn(JSON.stringify(stage)),
        "stageFileInputIndices",
      ),
    classifyMutationTrustBoundary: (path, context) =>
      decodeNativeJson<MutationTrustBoundaryClassification>(
        classifyMutationTrustBoundaryFn(
          path,
          JSON.stringify(context === undefined ? null : context),
        ),
        "classifyMutationTrustBoundary",
      ),
    enrichPathFacts: (shape, context) =>
      decodeNativeJson<ToolShape>(
        enrichPathFactsFn(
          JSON.stringify(shape),
          JSON.stringify(context === undefined ? null : context),
        ),
        "enrichPathFacts",
      ),
    classifyPathFact: (input, context) =>
      decodeNativeJson<unknown>(
        classifyPathFactFn(
          JSON.stringify(input),
          JSON.stringify(context === undefined ? null : context),
        ),
        "classifyPathFact",
      ),
    reduceIteratorEntry: (entry, effectiveCwd, context, home) =>
      decodeNativeJson<unknown>(
        reduceIteratorEntryFn(
          JSON.stringify(entry),
          effectiveCwd,
          JSON.stringify(context === undefined ? null : context),
          home,
        ),
        "reduceIteratorEntry",
      ),
    reduceForLoopIterator: (stage, effectiveCwd, context, home) =>
      decodeNativeJson<unknown>(
        reduceForLoopIteratorFn(
          JSON.stringify(stage),
          effectiveCwd,
          JSON.stringify(context === undefined ? null : context),
          home,
        ),
        "reduceForLoopIterator",
      ),
    compilePack: (pack) =>
      decodeNativeJson<PackCompileResult>(
        compilePackFn(JSON.stringify(pack === undefined ? null : pack)),
        "compilePack",
      ),
    compileMatch: (matcher) =>
      decodeNativeJson<{
        readonly expr?: MatcherExpr;
        readonly errors?: readonly CompileError[];
      }>(
        compileMatchFn(JSON.stringify(matcher === undefined ? null : matcher)),
        "compileMatch",
      ),
    compilePackMetadata: (metadata) =>
      decodeNativeJson<{
        readonly metadata?: PolicyPackMetadata;
        readonly errors: readonly CompileError[];
      }>(
        compilePackMetadataFn(
          JSON.stringify(metadata === undefined ? null : metadata),
        ),
        "compilePackMetadata",
      ),
    createPolicy: (policy) =>
      decodeNativeJson<{
        readonly handle?: string;
        readonly errors: readonly string[];
      }>(
        createPolicyFn(JSON.stringify(policy === undefined ? null : policy)),
        "createPolicy",
      ),
    compilePolicy: (policy) =>
      decodeNativeJson<{
        readonly handle?: string;
        readonly errors: readonly string[];
      }>(
        compilePolicyFn(JSON.stringify(policy === undefined ? null : policy)),
        "compilePolicy",
      ),
    composePolicy: (request) =>
      decodeNativeJson<NativeCompositionResult>(
        composePolicyFn(JSON.stringify(request === undefined ? null : request)),
        "composePolicy",
      ),
    validatePackAgainstFloor: (request) =>
      decodeNativeJson<{
        readonly warnings: readonly NativeCompositionWarning[];
        readonly errors: readonly NativeCompositionError[];
      }>(
        validatePackAgainstFloorFn(
          JSON.stringify(request === undefined ? null : request),
        ),
        "validatePackAgainstFloor",
      ),
    classifyOverlap: (left, right) => {
      const verdict = classifyOverlapFn(
        JSON.stringify(left),
        JSON.stringify(right),
      );
      if (
        verdict !== "overlap" &&
        verdict !== "disjoint" &&
        verdict !== "unknown"
      ) {
        throw new Error("native classifyOverlap() returned an invalid verdict");
      }
      return verdict;
    },
    validateCompoundAllowCanonicality: (expr) =>
      decodeNativeJson<{
        readonly applies: boolean;
        readonly ok?: boolean;
        readonly reason?: string;
      }>(
        validateCompoundAllowCanonicalityFn(JSON.stringify(expr)),
        "validateCompoundAllowCanonicality",
      ),
    decide: (handle, shape) =>
      decodeNativeJson<Decision>(
        decideFn(handle, JSON.stringify(shape)),
        "decide",
      ),
    decideBatch: (handle, shapes) =>
      decodeNativeJson<readonly Decision[]>(
        decideBatchFn(handle, JSON.stringify(shapes)),
        "decideBatch",
      ),
    match: (matcher, shape) =>
      matchFn(JSON.stringify(matcher), JSON.stringify(shape)),
    freePolicy: (handle) => freePolicyFn(handle),
    buildCorpusModel: (corpus, handle, options) =>
      decodeNativeJson<unknown>(
        buildCorpusModelFn(
          JSON.stringify(corpus === undefined ? null : corpus),
          handle,
          options === undefined ? undefined : JSON.stringify(options),
        ),
        "buildCorpusModel",
      ),
    replayDelta: (corpus, baselineHandle, candidateHandle, options) =>
      decodeNativeJson<unknown>(
        replayDeltaFn(
          JSON.stringify(corpus === undefined ? null : corpus),
          baselineHandle,
          candidateHandle,
          options === undefined ? undefined : JSON.stringify(options),
        ),
        "replayDelta",
      ),
    adversarialValidate: (proposal, baselineHandle, candidateHandle, options) =>
      decodeNativeJson<unknown>(
        adversarialValidateFn(
          JSON.stringify(proposal === undefined ? null : proposal),
          baselineHandle,
          candidateHandle,
          options === undefined ? undefined : JSON.stringify(options),
        ),
        "adversarialValidate",
      ),
  };
}

function isNativeHealth(value: unknown): value is NativeHealth {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    typeof value.grammarVersion === "string" &&
    typeof value.target === "string"
  );
}

function decodeNativeJson<T>(value: unknown, method: string): T {
  if (typeof value !== "string") {
    throw new Error(`native ${method}() returned a non-JSON response`);
  }
  try {
    return JSON.parse(value) as T;
  } catch (error: unknown) {
    throw new Error(
      `native ${method}() returned invalid JSON: ${nativeLoadError(error)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nativeLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
