import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  DEFAULT_PROJECT_SCOPE_BEHAVIOR,
  DEFAULT_REVIEWER_CONTEXT_MODE,
  DEFAULT_REVIEWER_ESCALATION,
  DEFAULT_REVIEWER_PROMPT_POSTURE,
  DEFAULT_REVIEWER_RECENT_CONTEXT,
  DEFAULT_REVIEWER_TOKEN_BUDGET,
  DEFAULT_REVIEW_NOTE_DISPLAY,
  DEFAULT_UNKNOWN_TOOL_POSTURE,
} from "./defaults.ts";
import { EXACT_NON_BASH_TOOL_NAME_PATTERN } from "./gated-tools.ts";

export const CONFIG_SCHEMA_VERSION = 1 as const;

const STRICT_OBJECT_OPTIONS = { additionalProperties: false } as const;

export const CLEARANCE_MODES = ["off", "ask", "auto"] as const;
export type ClearanceMode = (typeof CLEARANCE_MODES)[number];

const ClearanceModeLiteral = Type.Union(
  [Type.Literal("off"), Type.Literal("ask"), Type.Literal("auto")],
  { default: "ask" },
);

const DecisionEffectLiteral = Type.Union([
  Type.Literal("allow"),
  Type.Literal("deny"),
  Type.Literal("review"),
]);

export const REVIEW_NOTE_MODES = [
  "reason+accent",
  "accent-only",
  "reason+model",
  "off",
] as const;

export type ReviewNoteMode = (typeof REVIEW_NOTE_MODES)[number];

const [
  REVIEW_NOTE_MODE_REASON_ACCENT,
  REVIEW_NOTE_MODE_ACCENT_ONLY,
  REVIEW_NOTE_MODE_REASON_MODEL,
  REVIEW_NOTE_MODE_OFF,
] = REVIEW_NOTE_MODES;

function reviewNoteModeLiteral(
  options: { readonly default?: ReviewNoteMode } = {},
) {
  return Type.Union(
    [
      Type.Literal(REVIEW_NOTE_MODE_REASON_ACCENT),
      Type.Literal(REVIEW_NOTE_MODE_ACCENT_ONLY),
      Type.Literal(REVIEW_NOTE_MODE_REASON_MODEL),
      Type.Literal(REVIEW_NOTE_MODE_OFF),
    ],
    options,
  );
}

export const ReviewNoteModeLiteral = reviewNoteModeLiteral();

export function isReviewNoteMode(value: unknown): value is ReviewNoteMode {
  return (
    typeof value === "string" &&
    (REVIEW_NOTE_MODES as readonly string[]).includes(value)
  );
}

const ProvenanceSourceLiteral = Type.Union([
  Type.Literal("shipped"),
  Type.Literal("user-global"),
  Type.Literal("user-project"),
  Type.Literal("trusted-repo"),
  Type.Literal("package"),
  Type.Literal("generated"),
  Type.Literal("default"),
]);

// Pack-level matcher structure is intentionally shallow here. The policy DSL
// compiler owns deep matcher validation so schema and matcher features do not drift.
const RawMatcherSchema = Type.Record(Type.String(), Type.Unknown());

export const PackRuleSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    effect: DecisionEffectLiteral,
    match: RawMatcherSchema,
    reason: Type.String({ minLength: 1 }),
    provenance: Type.Object(
      {
        source: ProvenanceSourceLiteral,
      },
      { ...STRICT_OBJECT_OPTIONS, default: { source: "user-global" } },
    ),
  },
  STRICT_OBJECT_OPTIONS,
);

const PackWarningLevelLiteral = Type.Union([
  Type.Literal("info"),
  Type.Literal("warning"),
  Type.Literal("danger"),
]);

const PolicyPackDocLinkSchema = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    href: Type.String({ minLength: 1 }),
  },
  STRICT_OBJECT_OPTIONS,
);

const PolicyPackWarningSchema = Type.Object(
  {
    level: PackWarningLevelLiteral,
    message: Type.String({ minLength: 1 }),
  },
  STRICT_OBJECT_OPTIONS,
);

const PolicyPackExampleSchema = Type.Object(
  {
    outcome: DecisionEffectLiteral,
    shape: Type.String({ minLength: 1 }),
    note: Type.Optional(Type.String()),
  },
  STRICT_OBJECT_OPTIONS,
);

/**
 * Inert pack metadata. Every field is optional and has no default so existing
 * packs without metadata normalize unchanged; the registry derives display
 * defaults when metadata is absent. Strict nested objects reject unknown keys.
 */
const PolicyPackMetadataSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String({ minLength: 1 })),
    docs: Type.Optional(Type.Array(PolicyPackDocLinkSchema)),
    tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    warnings: Type.Optional(Type.Array(PolicyPackWarningSchema)),
    examples: Type.Optional(Type.Array(PolicyPackExampleSchema)),
  },
  STRICT_OBJECT_OPTIONS,
);

export const PolicyPackSchema = Type.Object(
  {
    version: Type.Literal(CONFIG_SCHEMA_VERSION),
    id: Type.String({ minLength: 1 }),
    metadata: Type.Optional(PolicyPackMetadataSchema),
    rules: Type.Array(PackRuleSchema),
  },
  STRICT_OBJECT_OPTIONS,
);

export const ReviewNoteDisplaySchema = Type.Object(
  {
    mode: reviewNoteModeLiteral({ default: DEFAULT_REVIEW_NOTE_DISPLAY.mode }),
    showModelLabel: Type.Boolean({
      default: DEFAULT_REVIEW_NOTE_DISPLAY.showModelLabel,
    }),
    accent: Type.Boolean({ default: DEFAULT_REVIEW_NOTE_DISPLAY.accent }),
  },
  { ...STRICT_OBJECT_OPTIONS, default: {} },
);

export const DisplayConfigSchema = Type.Object(
  { reviewNote: ReviewNoteDisplaySchema },
  { ...STRICT_OBJECT_OPTIONS, default: {} },
);

export const ReviewerConfigSchema = Type.Object(
  {
    promptPosture: Type.String({ default: DEFAULT_REVIEWER_PROMPT_POSTURE }),
    promptAppends: Type.Array(Type.String(), { default: [] }),
    projectPromptAppends: Type.Array(Type.String(), { default: [] }),
    promptOverride: Type.Union([Type.String(), Type.Null()], { default: null }),
    model: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      default: null,
    }),
    tokenBudget: Type.Object(
      {
        window: Type.String({ default: DEFAULT_REVIEWER_TOKEN_BUDGET.window }),
        limit: Type.Union([Type.Number(), Type.Null()], {
          default: DEFAULT_REVIEWER_TOKEN_BUDGET.limit,
        }),
      },
      {
        ...STRICT_OBJECT_OPTIONS,
        default: DEFAULT_REVIEWER_TOKEN_BUDGET,
      },
    ),
    contextMode: Type.Union(
      [Type.Literal("minimal"), Type.Literal("recentContext")],
      { default: DEFAULT_REVIEWER_CONTEXT_MODE },
    ),
    recentContext: Type.Object(
      {
        decisionLimit: Type.Integer({
          default: DEFAULT_REVIEWER_RECENT_CONTEXT.decisionLimit,
        }),
        decisionWindow: Type.String({
          default: DEFAULT_REVIEWER_RECENT_CONTEXT.decisionWindow,
        }),
        conversationTurns: Type.Integer({
          default: DEFAULT_REVIEWER_RECENT_CONTEXT.conversationTurns,
        }),
        userTurns: Type.Integer({
          default: DEFAULT_REVIEWER_RECENT_CONTEXT.userTurns,
        }),
        conversationCharLimit: Type.Integer({
          default: DEFAULT_REVIEWER_RECENT_CONTEXT.conversationCharLimit,
        }),
      },
      {
        ...STRICT_OBJECT_OPTIONS,
        default: {
          ...DEFAULT_REVIEWER_RECENT_CONTEXT,
        },
      },
    ),
    escalation: Type.Object(
      {
        enabled: Type.Boolean({
          default: DEFAULT_REVIEWER_ESCALATION.enabled,
        }),
        denialLimit: Type.Integer({
          default: DEFAULT_REVIEWER_ESCALATION.denialLimit,
        }),
        window: Type.String({ default: DEFAULT_REVIEWER_ESCALATION.window }),
      },
      {
        ...STRICT_OBJECT_OPTIONS,
        default: DEFAULT_REVIEWER_ESCALATION,
      },
    ),
  },
  { ...STRICT_OBJECT_OPTIONS, default: {} },
);

export const PackEnablementSchema = Type.Object(
  {
    enabledPackagePacks: Type.Array(Type.String({ minLength: 1 }), {
      default: [],
    }),
    disabledPackagePacks: Type.Array(Type.String({ minLength: 1 }), {
      default: [],
    }),
    disabledConfigPacks: Type.Array(Type.String({ minLength: 1 }), {
      default: [],
    }),
  },
  { ...STRICT_OBJECT_OPTIONS, default: {} },
);

const GatedToolName = Type.String({
  minLength: 1,
  // Tool opt-in is deliberately exact-name only. Keep the field a strict
  // schema boundary so wildcard/future-tool consent cannot slip into config.
  pattern: EXACT_NON_BASH_TOOL_NAME_PATTERN,
});

export const GlobalConfigSchema = Type.Object(
  {
    version: Type.Literal(CONFIG_SCHEMA_VERSION),
    mode: ClearanceModeLiteral,
    gatedTools: Type.Array(GatedToolName, {
      default: [],
      uniqueItems: true,
    }),
    unknownToolPosture: Type.Optional(
      Type.Union(
        [Type.Literal("allow"), Type.Literal("deny"), Type.Literal("review")],
        { default: DEFAULT_UNKNOWN_TOOL_POSTURE },
      ),
    ),
    packs: Type.Array(PolicyPackSchema, { default: [] }),
    packEnablement: PackEnablementSchema,
    reviewer: ReviewerConfigSchema,
    display: DisplayConfigSchema,
  },
  STRICT_OBJECT_OPTIONS,
);

/** Fresh array schema for a project-scope path list. Each call returns its own schema. */
function pathListSchema() {
  return Type.Array(Type.String({ minLength: 1 }), { default: [] });
}

/**
 * User-owned project-scope config. Lives only on the project overlay so checked-in
 * repo policy cannot widen path scope. `unknownPathBehavior` deliberately has no
 * `allow` value: dynamic or ambiguous paths must never satisfy a constructive
 * allow rule. Missing config normalizes to safe empty defaults.
 */
export const ProjectScopeSchema = Type.Object(
  {
    roots: pathListSchema(),
    writableDirectories: pathListSchema(),
    tempDirectories: pathListSchema(),
    deniedDirectories: pathListSchema(),
    safeHomeDirectories: pathListSchema(),
    safeHomeUseDefaults: Type.Boolean({
      default: DEFAULT_PROJECT_SCOPE_BEHAVIOR.safeHomeUseDefaults,
    }),
    /** Optional custom Pi support roots; built-in roots remain enabled by default. */
    agentSupportDirectories: Type.Optional(pathListSchema()),
    agentSupportUseDefaults: Type.Optional(
      Type.Boolean({
        default: DEFAULT_PROJECT_SCOPE_BEHAVIOR.agentSupportUseDefaults,
      }),
    ),
    unknownPathBehavior: Type.Union(
      [Type.Literal("review"), Type.Literal("deny")],
      { default: DEFAULT_PROJECT_SCOPE_BEHAVIOR.unknownPathBehavior },
    ),
    /**
     * Behavior for paths the engine classifies as sensitive home
     * (credentials, keys, auth files). `"deny"` hard-blocks them; the
     * default keeps them review-gated. Deliberately no `"allow"` value.
     */
    sensitivePathBehavior: Type.Union(
      [Type.Literal("review"), Type.Literal("deny")],
      { default: DEFAULT_PROJECT_SCOPE_BEHAVIOR.sensitivePathBehavior },
    ),
    /**
     * `"review"` claws back baseline home-scope read auto-allows so any
     * call touching home paths goes to review (the project-only preset).
     */
    homePathBehavior: Type.Union(
      [Type.Literal("allow"), Type.Literal("review")],
      { default: DEFAULT_PROJECT_SCOPE_BEHAVIOR.homePathBehavior },
    ),
  },
  { ...STRICT_OBJECT_OPTIONS, default: {} },
);

export const ProjectOverlaySchema = Type.Object(
  {
    version: Type.Literal(CONFIG_SCHEMA_VERSION),
    packs: Type.Array(PolicyPackSchema, { default: [] }),
    packEnablement: PackEnablementSchema,
    projectScope: ProjectScopeSchema,
    promptAppends: Type.Array(Type.String(), { default: [] }),
  },
  STRICT_OBJECT_OPTIONS,
);

export const RepositoryPolicySchema = Type.Object(
  {
    version: Type.Literal(CONFIG_SCHEMA_VERSION),
    packs: Type.Array(PolicyPackSchema, { default: [] }),
    promptAppends: Type.Array(Type.String(), { default: [] }),
  },
  STRICT_OBJECT_OPTIONS,
);

type DeepReadonly<T> = T extends (...args: readonly never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type RawPolicyPackRule = DeepReadonly<Static<typeof PackRuleSchema>>;
export type RawPolicyPackMetadata = DeepReadonly<
  Static<typeof PolicyPackMetadataSchema>
>;
export type RawPolicyPack = DeepReadonly<Static<typeof PolicyPackSchema>>;
export type ReviewNoteDisplayConfig = DeepReadonly<
  Static<typeof ReviewNoteDisplaySchema>
>;
export type DisplayConfig = DeepReadonly<Static<typeof DisplayConfigSchema>>;
export type ReviewerConfig = DeepReadonly<Static<typeof ReviewerConfigSchema>>;
export type PackEnablementConfig = DeepReadonly<
  Static<typeof PackEnablementSchema>
>;
export type GlobalConfig = DeepReadonly<Static<typeof GlobalConfigSchema>>;
export type ProjectScopeConfig = DeepReadonly<
  Static<typeof ProjectScopeSchema>
>;
export type ProjectOverlayConfig = DeepReadonly<
  Static<typeof ProjectOverlaySchema>
>;
export type RepositoryPolicyConfig = DeepReadonly<
  Static<typeof RepositoryPolicySchema>
>;

export interface ConfigValidationError {
  readonly path: string;
  readonly message: string;
}

type NormalizedConfig<T extends TSchema> =
  | { readonly ok: true; readonly value: Static<T> }
  | { readonly ok: false; readonly errors: readonly ConfigValidationError[] };

export function normalizeConfig<T extends TSchema>(
  schema: T,
  raw: unknown,
  basePath = "$",
): NormalizedConfig<T> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [
        {
          path: basePath,
          message: "expected config object",
        },
      ],
    };
  }

  const withDefaults = Value.Default(schema, raw);
  if (Value.Check(schema, withDefaults)) {
    return { ok: true, value: withDefaults as Static<T> };
  }

  return {
    ok: false,
    errors: [...Value.Errors(schema, withDefaults)].map((error) => ({
      path: pathFor(basePath, error.path),
      message: error.message,
    })),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathFor(basePath: string, pointerPath: string): string {
  const relativePath = pointerToPath(pointerPath);
  if (relativePath.length === 0) {
    return basePath;
  }
  return basePath === "$" ? `$.${relativePath}` : `${basePath}.${relativePath}`;
}

function pointerToPath(pointerPath: string): string {
  if (pointerPath.length === 0) {
    return "";
  }

  return pointerPath
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((part) => (/^\d+$/.test(part) ? `[${part}]` : part))
    .join(".")
    .replaceAll(".[", "[");
}
