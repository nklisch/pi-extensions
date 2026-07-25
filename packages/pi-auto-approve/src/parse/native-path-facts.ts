import { requireNativeEngine } from "../native/loader.ts";
import type {
  BashCommandShape,
  BashIteratorEntry,
  BashPathFact,
  BashPathFactContext,
  BashPathFactProvenanceEntry,
  BashPathFacts,
  BashStage,
  PathFactsResolvedConfig,
  PathScope,
  PiBuiltinToolShape,
  SourceSpan,
  ToolPathFacts,
  ToolShape,
} from "./shape.ts";

export type {
  BashPathFactContext,
  PathFactProjectScope,
  PathFactsResolvedConfig,
  ToolPathFactContext,
} from "../contracts/index.ts";

export interface BashPathFactInput {
  readonly raw: string;
  readonly usage: BashPathFact["usage"];
  readonly access: BashPathFact["access"];
  readonly program?: string;
  readonly stageIndex?: number;
  readonly source: SourceSpan;
  readonly effectiveCwd?: string;
  readonly unresolvedCwdPrefix?: boolean;
}

/** Native path-fact enrichment. The Rust engine owns all classification logic. */
export function enrichToolShapeWithPathFacts(
  shape: ToolShape,
  resolvedConfig: PathFactsResolvedConfig,
): ToolShape {
  if (shape.kind !== "bash" && shape.kind !== "pi-tool") {
    return shape;
  }
  try {
    return requireNativeEngine().enrichPathFacts(shape, resolvedConfig);
  } catch (error: unknown) {
    return {
      ...shape,
      diagnostics: [
        ...shape.diagnostics,
        {
          code: `${shape.kind}:path-facts-error`,
          severity: "error",
          message: `path fact derivation failed closed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }
}

/** Compatibility-shaped adapter used by fixture code; it still calls native. */
export function attachBashPathFacts(
  shape: ToolShape,
  context: BashPathFactContext,
): ToolShape {
  return shape.kind === "bash"
    ? enrichToolShapeWithPathFacts(shape, context)
    : shape;
}

export function deriveBashPathFacts(
  shape: BashCommandShape,
  context: BashPathFactContext,
): BashPathFacts {
  const enriched = enrichToolShapeWithPathFacts(shape, context);
  if (enriched.kind !== "bash" || enriched.pathFacts === undefined) {
    throw new Error("native path-fact enrichment did not return bash facts");
  }
  return enriched.pathFacts;
}

export function derivePiBuiltinToolPathFacts(
  shape: PiBuiltinToolShape,
  context: BashPathFactContext,
): ToolPathFacts {
  const enriched = enrichToolShapeWithPathFacts(shape, context);
  if (enriched.kind !== "pi-tool" || enriched.pathFacts === undefined) {
    throw new Error("native path-fact enrichment did not return Pi tool facts");
  }
  return enriched.pathFacts;
}

/** Direct native classifier seam retained for focused path-fact assertions. */
export function classifyBashPathFact(
  input: BashPathFactInput,
  context: BashPathFactContext,
): BashPathFact {
  return requireNativeEngine().classifyPathFact(input, context) as BashPathFact;
}

export interface IteratorReduction {
  readonly sourceKind: "literal-word" | "literal-glob" | "mixed" | "opaque";
  readonly entries: readonly BashPathFactProvenanceEntry[];
  readonly scope: PathScope;
  readonly matchedScopes: readonly PathScope[];
  readonly concreteAbsolutePath?: string;
  readonly staticPrefixAbsolutePath?: string;
  readonly globApproximation: boolean;
  readonly unknownReason?:
    | "opaque-iterator"
    | "iterator-mixed-unknown"
    | "outer-scope-variable";
}

export function reduceIteratorEntry(
  entry: BashIteratorEntry,
  effectiveCwd: string,
  context: BashPathFactContext,
  home?: string,
): BashPathFactProvenanceEntry {
  return requireNativeEngine().reduceIteratorEntry(
    entry,
    effectiveCwd,
    context,
    home,
  ) as BashPathFactProvenanceEntry;
}

export function reduceForLoopIterator(
  stage: Extract<BashStage, { kind: "for-loop" }>,
  effectiveCwd: string,
  context: BashPathFactContext,
  home?: string,
): IteratorReduction {
  return requireNativeEngine().reduceForLoopIterator(
    stage,
    effectiveCwd,
    context,
    home,
  ) as IteratorReduction;
}

/** Platform defaults are data only; native classification uses the same table. */
export function defaultSystemPathPrefixes(): readonly string[] {
  if (process.platform === "win32") {
    return [
      "C:\\Windows",
      "C:\\Windows\\System32",
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "C:\\ProgramData",
    ];
  }
  return [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/dev",
    "/proc",
    "/sys",
    "/boot",
    "/lib",
    "/lib64",
    "/opt",
  ];
}

/** Metadata for the native extractor registry; extraction itself is Rust-owned. */
export interface ProgramPathExtractor {
  readonly program: string;
}

export const PATH_ARGUMENT_EXTRACTORS: Readonly<
  Record<string, ProgramPathExtractor>
> = {
  mkdir: { program: "mkdir" },
  touch: { program: "touch" },
  mktemp: { program: "mktemp" },
  cargo: { program: "cargo" },
  biome: { program: "biome" },
  prettier: { program: "prettier" },
  eslint: { program: "eslint" },
  ruff: { program: "ruff" },
};

export type { BashPathFacts, ToolPathFacts };
