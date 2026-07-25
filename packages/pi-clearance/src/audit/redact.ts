import type {
  BashBlock,
  BashCommandShape,
  BashPipeline,
  BashStage,
  BashStageProgram,
  Redirect,
  ToolShape,
} from "../parse/shape.ts";
import type {
  AuditEntry,
  PolicyDecisionEntry,
  ReviewerDecisionEntry,
} from "./entry.ts";

export interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

export interface RedactionOptions {
  readonly maxStringLength?: number;
  readonly redactEnvValues?: boolean;
  readonly secretRules?: readonly RedactionRule[];
}

const DEFAULT_MAX_STRING_LENGTH = 256;
const REDACTED_VALUE = "[redacted]";

export const DEFAULT_SECRETS: readonly RedactionRule[] = [
  {
    pattern: /(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    replacement: `$1${REDACTED_VALUE}`,
  },
  {
    pattern: /\b((?:oauth[_-]?)?(?:access[_-]?)?token\s*[=:]\s*)[^\s&;,'"]+/gi,
    replacement: `$1${REDACTED_VALUE}`,
  },
  {
    pattern: /\b((?:password|secret)\s*[=:]\s*)[^\s&;,'"]+/gi,
    replacement: `$1${REDACTED_VALUE}`,
  },
  {
    pattern: /\b(api[_-]?key\s*[=:]\s*)[^\s&;,'"]+/gi,
    replacement: `$1${REDACTED_VALUE}`,
  },
  {
    pattern: /\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{16,}\b/g,
    replacement: REDACTED_VALUE,
  },
];

function optionsWithDefaults(
  options: RedactionOptions | undefined,
): Required<RedactionOptions> {
  return {
    maxStringLength: options?.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    redactEnvValues: options?.redactEnvValues ?? true,
    secretRules: options?.secretRules ?? DEFAULT_SECRETS,
  };
}

function globalPattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

export function redactString(
  value: string,
  options?: RedactionOptions,
): string {
  const resolved = optionsWithDefaults(options);
  let redacted = value;

  for (const rule of resolved.secretRules) {
    redacted = redacted.replace(globalPattern(rule.pattern), rule.replacement);
  }

  if (redacted.length > resolved.maxStringLength) {
    return `[redacted:len=${value.length}]`;
  }

  return redacted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function redactValue(
  value: unknown,
  options?: RedactionOptions,
): unknown {
  if (typeof value === "string") {
    return redactString(value, options);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactValue(item, options),
    ]),
  );
}

function redactEnvironmentValue(
  value: string,
  options: RedactionOptions | undefined,
): string {
  if (optionsWithDefaults(options).redactEnvValues) {
    return REDACTED_VALUE;
  }

  return redactString(value, options);
}

function redactProgram(
  program: BashStageProgram,
  options: RedactionOptions | undefined,
): BashStageProgram {
  return {
    ...program,
    environment: program.environment.map((assignment) => ({
      ...assignment,
      value: redactEnvironmentValue(assignment.value, options),
    })),
  };
}

function redactRedirect(
  redirect: Redirect,
  options: RedactionOptions | undefined,
): Redirect {
  return {
    ...redirect,
    target: redactString(redirect.target, options),
  };
}

function redactStage(
  stage: BashStage,
  options: RedactionOptions | undefined,
): BashStage {
  if (stage.kind !== "command") {
    return { ...stage };
  }

  return {
    ...stage,
    program: redactProgram(stage.program, options),
    redirects: stage.redirects.map((redirect) =>
      redactRedirect(redirect, options),
    ),
  };
}

function redactPipeline(
  pipeline: BashPipeline,
  options: RedactionOptions | undefined,
): BashPipeline {
  return {
    ...pipeline,
    stages: pipeline.stages.map((stage) => redactStage(stage, options)),
    pipeTargets: pipeline.pipeTargets.map((target) =>
      redactString(target, options),
    ),
  };
}

function redactBlock(
  block: BashBlock,
  options: RedactionOptions | undefined,
): BashBlock {
  return {
    ...block,
    pipeline: redactPipeline(block.pipeline, options),
  };
}

function redactBashShape(
  shape: BashCommandShape,
  options: RedactionOptions | undefined,
): BashCommandShape {
  return {
    ...shape,
    rawCommand: redactString(shape.rawCommand, options),
    ...(shape.cwdPrefix === undefined
      ? {}
      : { cwdPrefix: redactString(shape.cwdPrefix, options) }),
    blocks: shape.blocks.map((block) => redactBlock(block, options)),
    stages: shape.stages.map((stage) => redactStage(stage, options)),
    diagnostics: shape.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

export function redactToolShape(
  shape: ToolShape,
  options?: RedactionOptions,
): ToolShape {
  if (shape.kind === "bash") {
    return redactBashShape(shape, options);
  }

  return redactValue(shape, options) as ToolShape;
}

function redactPolicyDecisionEntry<T extends PolicyDecisionEntry>(
  entry: T,
  options: RedactionOptions | undefined,
): T {
  const { shape, toolInput, ...rest } = entry;
  return {
    ...(redactValue(rest, options) as Omit<T, "shape" | "toolInput">),
    toolInput: redactValue(toolInput, options),
    ...(shape === undefined ? {} : { shape: redactToolShape(shape, options) }),
  } as T;
}

function redactReviewerDecisionEntry<T extends ReviewerDecisionEntry>(
  entry: T,
  options: RedactionOptions | undefined,
): T {
  const { toolInput, ...rest } = entry;
  return {
    ...(redactValue(rest, options) as Omit<T, "toolInput">),
    toolInput: redactValue(toolInput, options),
  } as T;
}

export function redactEntry<T extends AuditEntry>(
  entry: T,
  options?: RedactionOptions,
): T {
  switch (entry.entryType) {
    case "policy.decision":
      return redactPolicyDecisionEntry(entry, options) as T;
    case "reviewer.decision":
      return redactReviewerDecisionEntry(entry, options) as T;
    case "trust.event":
    case "config.event":
    case "replay.input":
    case "ratchet.proposal-decision":
      return redactValue(entry, options) as T;
  }
}
