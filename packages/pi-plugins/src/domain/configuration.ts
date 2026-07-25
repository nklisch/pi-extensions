import { z } from "zod";
import { schemaValues } from "./schema.js";
import { ClaimedSchema, ProvenanceSchema } from "./provenance.js";

/** The public configuration vocabulary has one authoritative registry. */
export const ConfigurationValueKindRegistry = {
  string: { tag: "string" },
  number: { tag: "number" },
  boolean: { tag: "boolean" },
  directory: { tag: "directory" },
  file: { tag: "file" },
  strings: { tag: "strings" },
} as const;

const ConfigurationValueSchemaRegistry = {
  string: z
    .object({
      kind: z.literal(ConfigurationValueKindRegistry.string.tag),
      default: z.string().optional(),
      pattern: z.string().optional(),
    })
    .strict(),
  number: z
    .object({
      kind: z.literal(ConfigurationValueKindRegistry.number.tag),
      default: z.number().finite().optional(),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    })
    .strict(),
  boolean: z
    .object({
      kind: z.literal(ConfigurationValueKindRegistry.boolean.tag),
      default: z.boolean().optional(),
    })
    .strict(),
  directory: z
    .object({
      kind: z.literal(ConfigurationValueKindRegistry.directory.tag),
      default: z.string().optional(),
      mustExist: z.boolean().default(true),
    })
    .strict(),
  file: z
    .object({
      kind: z.literal(ConfigurationValueKindRegistry.file.tag),
      default: z.string().optional(),
      mustExist: z.boolean().default(true),
    })
    .strict(),
  strings: z
    .object({
      kind: z.literal(ConfigurationValueKindRegistry.strings.tag),
      default: z.array(z.string()).readonly().optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
    })
    .strict(),
} as const satisfies Record<
  keyof typeof ConfigurationValueKindRegistry,
  z.ZodTypeAny
>;

const ConfigurationValueUnionSchema = z.discriminatedUnion(
  "kind",
  schemaValues(ConfigurationValueSchemaRegistry),
);
type ConfigurationValueDescriptor = z.infer<typeof ConfigurationValueUnionSchema>;

export const ConfigurationKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/**
 * Descriptor patterns are plugin-authored input, not trusted application code.
 * The accepted language has one quantifier budget: at most one repetition
 * operator per pattern. Bounded `{m,n}` operators count toward that budget and
 * have a maximum repeat of 32. Together with the pattern/input limits this
 * gives a finite evaluation bound and rejects a chain such as eight
 * `a{0,32}` operators before the JavaScript regexp engine is reached.
 */
export const ConfigurationPatternPolicy = Object.freeze({
  maxPatternLength: 256,
  maxInputLength: 16_384,
  maxQuantifiers: 1,
  maxBoundedRepeat: 32,
});

type BoundedQuantifier = Readonly<{ end: number; lower: number; upper: number }>;

type BoundedQuantifierScan = BoundedQuantifier | false | undefined;

function boundedQuantifierAt(pattern: string, index: number): BoundedQuantifierScan {
  if (pattern[index] !== "{") return undefined;
  let cursor = index + 1;
  const lowerStart = cursor;
  while (cursor < pattern.length && pattern[cursor] !== "}" && pattern[cursor] !== ",") cursor += 1;
  if (cursor === lowerStart || !/^\d+$/.test(pattern.slice(lowerStart, cursor))) return undefined;
  const lower = Number(pattern.slice(lowerStart, cursor));
  if (!Number.isSafeInteger(lower) || lower > ConfigurationPatternPolicy.maxBoundedRepeat) return { end: cursor, lower, upper: lower };
  if (pattern[cursor] === "}") return { end: cursor, lower, upper: lower };
  cursor += 1;
  const upperStart = cursor;
  while (cursor < pattern.length && pattern[cursor] !== "}") cursor += 1;
  if (cursor === upperStart) return false;
  if (!/^\d+$/.test(pattern.slice(upperStart, cursor))) return undefined;
  const upper = Number(pattern.slice(upperStart, cursor));
  if (!Number.isSafeInteger(upper) || upper > ConfigurationPatternPolicy.maxBoundedRepeat || lower > upper) {
    return { end: cursor, lower, upper };
  }
  return { end: cursor, lower, upper };
}

export function isSafeConfigurationPattern(pattern: string): boolean {
  if (typeof pattern !== "string" || pattern.length > ConfigurationPatternPolicy.maxPatternLength) return false;
  // Backreferences, Unicode property escapes, and lookarounds require
  // matching strategies outside this deliberately bounded language.
  if (/\\(?:[1-9]|k<)|\\p\{|\(\?[<!=]/.test(pattern)) return false;
  // Wildcard repetition is both unnecessary for descriptors and a common
  // source of catastrophic backtracking.
  if (pattern.includes(".*") || pattern.includes(".+")) return false;

  let quantifiers = 0;
  let inCharacterClass = false;
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]") {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    // Groups and alternation let a backtracking engine revisit an unbounded
    // number of ambiguous paths even without a second repetition operator.
    // The descriptor language is therefore concatenative: atoms, anchors, and
    // at most one atom quantifier only.
    if (character === "(" || character === ")" || character === "|") return false;

    if (character === "{") {
      const quantifier = boundedQuantifierAt(pattern, index);
      if (quantifier === false) return false;
      if (quantifier === undefined) continue;
      // Reject malformed/oversized bounds without compiling the pattern. The
      // `end` cursor still lets this scanner continue in linear time.
      if (pattern[index - 1] === ")") return false;
      if (
        !Number.isSafeInteger(quantifier.lower) ||
        !Number.isSafeInteger(quantifier.upper) ||
        quantifier.lower < 0 ||
        quantifier.upper > ConfigurationPatternPolicy.maxBoundedRepeat ||
        quantifier.lower > quantifier.upper
      ) return false;
      quantifiers += 1;
      if (quantifiers > ConfigurationPatternPolicy.maxQuantifiers) return false;
      index = quantifier.end;
      continue;
    }
    if (character === "*" || character === "+" || character === "?") {
      // A group repetition would make the single-quantifier bound misleading:
      // the group may contain alternatives with different lengths.
      if (pattern[index - 1] === ")") return false;
      quantifiers += 1;
      if (quantifiers > ConfigurationPatternPolicy.maxQuantifiers) return false;
    }
  }

  try {
    // The scan above is the safety gate. Compilation only checks that the
    // already-bounded language is valid JavaScript regexp syntax.
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export function testConfigurationPattern(pattern: string, input: string): boolean {
  if (!isSafeConfigurationPattern(pattern) || input.length > ConfigurationPatternPolicy.maxInputLength) return false;
  return new RegExp(pattern).test(input);
}

function hasDefault(value: ConfigurationValueDescriptor): boolean {
  return "default" in value && value.default !== undefined;
}

function addIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function validatePattern(
  value: Extract<ConfigurationValueDescriptor, { kind: "string" }>,
  context: z.RefinementCtx,
  pathPrefix: readonly (string | number)[],
): void {
  if (value.pattern === undefined) {
    return;
  }

  if (!isSafeConfigurationPattern(value.pattern)) {
    addIssue(
      context,
      [...pathPrefix, "pattern"],
      "pattern must satisfy the bounded safe-regex policy",
    );
  }
}

function validateNumberBounds(
  value: Extract<ConfigurationValueDescriptor, { kind: "number" }>,
  context: z.RefinementCtx,
  pathPrefix: readonly (string | number)[],
): void {
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
    addIssue(context, [...pathPrefix, "min"], "min must not exceed max");
  }
  if (value.default !== undefined && value.min !== undefined && value.default < value.min) {
    addIssue(context, [...pathPrefix, "default"], "default must be at least min");
  }
  if (value.default !== undefined && value.max !== undefined && value.default > value.max) {
    addIssue(context, [...pathPrefix, "default"], "default must be at most max");
  }
}

function validateStringBounds(
  value: Extract<ConfigurationValueDescriptor, { kind: "strings" }>,
  context: z.RefinementCtx,
  pathPrefix: readonly (string | number)[],
): void {
  if (
    value.minItems !== undefined &&
    value.maxItems !== undefined &&
    value.minItems > value.maxItems
  ) {
    addIssue(context, [...pathPrefix, "minItems"], "minItems must not exceed maxItems");
  }
  if (
    value.default !== undefined &&
    value.minItems !== undefined &&
    value.default.length < value.minItems
  ) {
    addIssue(context, [...pathPrefix, "default"], "default contains fewer than minItems values");
  }
  if (
    value.default !== undefined &&
    value.maxItems !== undefined &&
    value.default.length > value.maxItems
  ) {
    addIssue(context, [...pathPrefix, "default"], "default contains more than maxItems values");
  }
}

function validateValueDescriptor(
  value: ConfigurationValueDescriptor,
  context: z.RefinementCtx,
  pathPrefix: readonly (string | number)[],
): void {
  switch (value.kind) {
    case "string":
      validatePattern(value, context, pathPrefix);
      break;
    case "number":
      validateNumberBounds(value, context, pathPrefix);
      break;
    case "strings":
      validateStringBounds(value, context, pathPrefix);
      break;
    case "boolean":
    case "directory":
    case "file":
      break;
    default:
      assertNever(value);
  }
}

export const ConfigurationValueSchema = ConfigurationValueUnionSchema.superRefine(
  (value, context) => validateValueDescriptor(value, context, []),
);
export type ConfigurationValue = z.infer<typeof ConfigurationValueSchema>;
export type ConfigurationValueKind = ConfigurationValue["kind"];

export const ConfigurationOptionSchema = z
  .object({
    key: ConfigurationKeySchema,
    label: ClaimedSchema(z.string().min(1)),
    description: ClaimedSchema(z.string()).optional(),
    value: ConfigurationValueSchema,
    required: z.boolean(),
    sensitive: z.boolean(),
    provenance: z.array(ProvenanceSchema).nonempty().readonly(),
  })
  .strict()
  .readonly()
  .superRefine((option, context) => {
    if (option.sensitive && hasDefault(option.value)) {
      addIssue(
        context,
        ["value", "default"],
        "sensitive configuration descriptors cannot carry default values",
      );
    }
  });
export type ConfigurationOption = z.infer<typeof ConfigurationOptionSchema>;

export const PluginConfigurationSchema = z
  .object({
    options: z.array(ConfigurationOptionSchema).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((configuration, context) => {
    const firstByKey = new Map<string, number>();
    configuration.options.forEach((option, index) => {
      const firstIndex = firstByKey.get(option.key);
      if (firstIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["options", index, "key"],
          message: `duplicate configuration key; first declared at index ${firstIndex}`,
        });
      } else {
        firstByKey.set(option.key, index);
      }
    });
  });
export type PluginConfiguration = z.infer<typeof PluginConfigurationSchema>;

function assertNever(value: never): never {
  throw new Error(`Unhandled configuration value kind: ${String(value)}`);
}
