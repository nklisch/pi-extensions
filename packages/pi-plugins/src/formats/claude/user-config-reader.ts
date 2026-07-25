import { z } from "zod";
import {
  ConfigurationOptionSchema,
  PluginConfigurationSchema,
  type ConfigurationOption,
  type ConfigurationValue,
  type PluginConfiguration,
} from "../../domain/configuration.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type ReadResult,
} from "../../domain/errors.js";
import { PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import {
  claim,
  ProvenanceSchema,
  type Provenance,
} from "../../domain/provenance.js";
import { JsonValueSchema, type JsonValue } from "../../domain/schema.js";

export type ClaudeUserConfigContext = Readonly<{
  plugin: PluginKey;
  path: string;
  pointer: string;
}>;

type DescriptorRecord = Readonly<Record<string, unknown>>;
type DescriptorEntry = Readonly<{ key: string; descriptor: DescriptorRecord }>;

const descriptorFields = new Set([
  "type",
  "title",
  "label",
  "description",
  "required",
  "sensitive",
  "default",
  "min",
  "max",
  "minItems",
  "maxItems",
  "pattern",
  "multiple",
  "mustExist",
]);
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const typeKinds = new Set(["string", "number", "boolean", "directory", "file"]);

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function contextProvenance(
  context: ClaudeUserConfigContext,
  key: string,
  declaration?: JsonValue,
): Provenance {
  return ProvenanceSchema.parse({
    location: {
      host: "claude",
      documentKind: "manifest",
      path: context.path,
      pointer: `${context.pointer}/${pointerSegment(key)}`,
    },
    ...(declaration === undefined ? {} : { declaration }),
  });
}

function invalid(
  operation: string,
  context: ClaudeUserConfigContext,
  error: unknown,
): ReadResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof z.ZodError
    ? {
        issues: error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String),
          message: issue.message,
        })),
      }
    : undefined;
  return {
    ok: false,
    diagnostics: [DiagnosticSchema.parse({
      code: ErrorCodeRegistry.schemaInvalid,
      severity: "error",
      operation,
      message,
      location: {
        host: "claude",
        documentKind: "manifest",
        path: context.path,
        pointer: context.pointer,
      },
      plugin: PluginKeySchema.parse(context.plugin),
      ...(details === undefined ? {} : { details }),
    })],
  };
}

function isRecord(value: unknown): value is DescriptorRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function entriesOf(input: unknown): DescriptorEntry[] {
  if (Array.isArray(input)) {
    const entries: DescriptorEntry[] = [];
    const seen = new Set<string>();
    for (const [index, candidate] of input.entries()) {
      if (!isRecord(candidate) || typeof candidate.key !== "string") {
        throw new TypeError(`userConfig descriptor at index ${index} must include a string key`);
      }
      if (seen.has(candidate.key)) throw new TypeError(`duplicate userConfig key: ${candidate.key}`);
      seen.add(candidate.key);
      const descriptor = { ...candidate };
      delete (descriptor as { key?: unknown }).key;
      entries.push({ key: candidate.key, descriptor });
    }
    return entries.sort((left, right) => left.key.localeCompare(right.key));
  }
  if (!isRecord(input)) throw new TypeError("userConfig must be an object of descriptors");
  return Object.keys(input).sort().map((key) => {
    if (unsafeKeys.has(key)) throw new TypeError(`unsafe userConfig key: ${key}`);
    const descriptor = input[key];
    if (!isRecord(descriptor)) throw new TypeError(`userConfig descriptor ${key} must be an object`);
    return { key, descriptor };
  });
}

function optionalBoolean(
  descriptor: DescriptorRecord,
  field: "required" | "sensitive" | "multiple" | "mustExist",
  defaultValue: boolean,
): boolean {
  const value = descriptor[field];
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

function optionalString(
  descriptor: DescriptorRecord,
  field: "title" | "label" | "description" | "pattern",
): string | undefined {
  const value = descriptor[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

function rawJson(value: unknown, field: string): JsonValue {
  const parsed = JsonValueSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${field} must be JSON-compatible`);
  return parsed.data;
}

function buildValue(descriptor: DescriptorRecord): ConfigurationValue {
  const type = descriptor.type;
  if (typeof type !== "string" || !typeKinds.has(type)) {
    throw new TypeError(`unknown userConfig descriptor type: ${String(type)}`);
  }
  const hasMultiple = Object.prototype.hasOwnProperty.call(descriptor, "multiple");
  const multiple = optionalBoolean(descriptor, "multiple", false);
  if (hasMultiple && type !== "string") {
    throw new TypeError("multiple is only valid for string descriptors");
  }
  if (type !== "number" && (descriptor.min !== undefined || descriptor.max !== undefined)) {
    throw new TypeError("min and max are only valid for number descriptors");
  }
  if (type !== "string" && (descriptor.pattern !== undefined || descriptor.minItems !== undefined || descriptor.maxItems !== undefined)) {
    throw new TypeError("pattern and array bounds are only valid for string descriptors");
  }
  if (type === "string" && !multiple && (descriptor.minItems !== undefined || descriptor.maxItems !== undefined)) {
    throw new TypeError("array bounds require multiple string descriptors");
  }
  if (descriptor.mustExist !== undefined && type !== "directory" && type !== "file") {
    throw new TypeError("mustExist is only valid for file and directory descriptors");
  }
  if (type === "string" && multiple && descriptor.pattern !== undefined) {
    throw new TypeError("pattern is not valid for multiple string descriptors");
  }

  const hasDefault = Object.prototype.hasOwnProperty.call(descriptor, "default") && descriptor.default !== undefined;
  const defaultValue = hasDefault ? rawJson(descriptor.default, "default") : undefined;
  const result: Record<string, unknown> = {
    kind: multiple ? "strings" : type,
  };

  if (hasDefault) result.default = defaultValue;

  if (type === "string" && !multiple) {
    const pattern = optionalString(descriptor, "pattern");
    if (pattern !== undefined) result.pattern = pattern;
  }
  if (type === "number") {
    for (const field of ["min", "max"] as const) {
      const value = descriptor[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
      result[field] = value;
    }
  }
  if (multiple) {
    for (const field of ["minItems", "maxItems"] as const) {
      const value = descriptor[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a non-negative integer`);
      }
      result[field] = value;
    }
  }
  if (type === "directory" || type === "file") {
    result.mustExist = optionalBoolean(descriptor, "mustExist", true);
  }
  return result as ConfigurationValue;
}

function buildOption(
  key: string,
  descriptor: DescriptorRecord,
  context: ClaudeUserConfigContext,
): ConfigurationOption {
  for (const field of Object.keys(descriptor)) {
    if (!descriptorFields.has(field)) throw new TypeError(`unknown userConfig descriptor field: ${field}`);
  }
  if (unsafeKeys.has(key)) throw new TypeError(`unsafe userConfig key: ${key}`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`invalid userConfig key: ${key}`);

  const title = optionalString(descriptor, "title");
  const label = optionalString(descriptor, "label");
  if (title !== undefined && label !== undefined && title !== label) {
    throw new TypeError("title and label disagree");
  }
  const labelValue = title ?? label ?? key;
  if (labelValue.length === 0) throw new TypeError("userConfig label must be non-empty");
  const provenance = contextProvenance(context, key, rawJson(descriptor, "descriptor"));
  const value = buildValue(descriptor);
  const option: Record<string, unknown> = {
    key,
    label: claim(labelValue, provenance),
    value,
    required: optionalBoolean(descriptor, "required", false),
    sensitive: optionalBoolean(descriptor, "sensitive", false),
    provenance: [provenance],
  };
  const description = optionalString(descriptor, "description");
  if (description !== undefined) option.description = claim(description, provenance);
  return ConfigurationOptionSchema.parse(option);
}

/**
 * Normalize Claude's userConfig declarations without collecting any values.
 * Defaults are declarations, not substitutions; filesystem and secret-store
 * concerns deliberately do not cross this pure format boundary.
 */
export function readClaudeUserConfig(
  input: unknown,
  context: Readonly<{ plugin: PluginKey; path: string; pointer: string }>,
): ReadResult<PluginConfiguration> {
  const operation = "readClaudeUserConfig";
  try {
    const validContext: ClaudeUserConfigContext = {
      plugin: PluginKeySchema.parse(context.plugin),
      path: z.string().min(1).parse(context.path),
      pointer: z.string().parse(context.pointer),
    };
    const options = entriesOf(input).map(({ key, descriptor }) => buildOption(key, descriptor, validContext));
    const configuration = PluginConfigurationSchema.parse({ options });
    return { ok: true, value: configuration, diagnostics: [] };
  } catch (error) {
    return invalid(operation, context, error);
  }
}
