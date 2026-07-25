import { z } from "zod";
import {
  ConfigurationKeySchema,
  PluginConfigurationSchema,
  type ConfigurationOption,
  type PluginConfiguration,
  testConfigurationPattern,
} from "./configuration.js";
import { ContentDigestSchema, hashContent, type ContentDigest } from "./content-manifest.js";
import { PluginConfigurationRefSchema, type PluginConfigurationRef } from "./state/references.js";
import { ScopeReferenceSchema, type ScopeReference } from "./state/scope.js";
import { PluginKeySchema, type PluginKey } from "./identity.js";
import type { Sha256 } from "./source.js";

const encoder = new TextEncoder();

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function canonicalFileUrl(value: string): boolean {
  if (value.includes("\\") || value.includes("\0") || hasLoneSurrogate(value)) return false;
  if (!value.startsWith("file://")) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:" || parsed.hostname !== "" || parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "" || parsed.pathname.length === 0) return false;
  if (parsed.href !== value || !parsed.pathname.startsWith("/")) return false;
  const rawSegments = parsed.pathname.split("/");
  for (const [index, raw] of rawSegments.entries()) {
    if (index === 0 && raw === "") continue;
    if (raw === "") return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return false;
    }
    if (
      decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") ||
      decoded.includes("\0") || [...decoded].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 0x20 || code === 0x7f;
      })
    ) return false;
  }
  return true;
}

/** One platform-neutral, absolute path spelling. */
export const CanonicalConfigurationPathSchema = z
  .string()
  .superRefine((value, context) => {
    if (!canonicalFileUrl(value)) {
      context.addIssue({ code: "custom", message: "configuration path must be a canonical absolute file URL" });
    }
  })
  .brand<"CanonicalConfigurationPath">();
export type CanonicalConfigurationPath = z.infer<typeof CanonicalConfigurationPathSchema>;

export const ConfiguredValueSchemaRegistry = {
  string: z.object({ kind: z.literal("string"), value: z.string() }).strict().readonly(),
  number: z.object({ kind: z.literal("number"), value: z.number().finite() }).strict().readonly(),
  boolean: z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict().readonly(),
  directory: z.object({ kind: z.literal("directory"), value: CanonicalConfigurationPathSchema }).strict().readonly(),
  file: z.object({ kind: z.literal("file"), value: CanonicalConfigurationPathSchema }).strict().readonly(),
  strings: z.object({ kind: z.literal("strings"), value: z.array(z.string()).readonly() }).strict().readonly(),
} as const;

const configuredValueSchemas = Object.values(ConfiguredValueSchemaRegistry) as [
  (typeof ConfiguredValueSchemaRegistry)[keyof typeof ConfiguredValueSchemaRegistry],
  ...(typeof ConfiguredValueSchemaRegistry)[keyof typeof ConfiguredValueSchemaRegistry][],
];
export const ConfiguredValueSchema = z.discriminatedUnion("kind", configuredValueSchemas).readonly();
export type ConfiguredValue = z.infer<typeof ConfiguredValueSchema>;
export type ConfiguredValueKind = ConfiguredValue["kind"];

export const SecretLocatorSchema = z
  .string()
  .regex(/^secret-v1:sha256:[0-9a-f]{64}$/)
  .brand<"SecretLocator">();
export type SecretLocator = z.infer<typeof SecretLocatorSchema>;

export const ConfigurationWriteIdSchema = z
  .string()
  .regex(/^config-write-v1:[A-Za-z0-9_-]{22,128}$/)
  .brand<"ConfigurationWriteId">();
export type ConfigurationWriteId = z.infer<typeof ConfigurationWriteIdSchema>;

const ConfigurationDocumentValueSchema = z.object({
  key: ConfigurationKeySchema,
  value: ConfiguredValueSchema,
}).strict().readonly();
const ConfigurationDocumentSecretSchema = z.object({
  key: ConfigurationKeySchema,
  locator: SecretLocatorSchema,
}).strict().readonly();

export const PluginConfigurationDocumentSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  configurationRef: PluginConfigurationRefSchema,
  plugin: PluginKeySchema,
  scope: ScopeReferenceSchema,
  descriptorDigest: ContentDigestSchema,
  revision: ContentDigestSchema,
  values: z.array(ConfigurationDocumentValueSchema).readonly(),
  secrets: z.array(ConfigurationDocumentSecretSchema).readonly(),
}).strict().readonly().superRefine((document, context) => {
  const seen = new Set<string>();
  for (const [index, entry] of document.values.entries()) {
    if (seen.has(entry.key)) context.addIssue({ code: "custom", path: ["values", index, "key"], message: "duplicate configuration key" });
    seen.add(entry.key);
  }
  let previousValueKey: string | undefined;
  for (const [index, entry] of document.values.entries()) {
    if (previousValueKey !== undefined && utf8Compare(previousValueKey, entry.key) >= 0) {
      context.addIssue({ code: "custom", path: ["values", index, "key"], message: "configuration values must be in unsigned UTF-8 key order" });
    }
    previousValueKey = entry.key;
  }
  let previousSecretKey: string | undefined;
  for (const [index, entry] of document.secrets.entries()) {
    if (seen.has(entry.key)) context.addIssue({ code: "custom", path: ["secrets", index, "key"], message: "duplicate configuration key" });
    seen.add(entry.key);
    if (previousSecretKey !== undefined && utf8Compare(previousSecretKey, entry.key) >= 0) {
      context.addIssue({ code: "custom", path: ["secrets", index, "key"], message: "configuration secrets must be in unsigned UTF-8 key order" });
    }
    previousSecretKey = entry.key;
  }
});
export type PluginConfigurationDocument = z.infer<typeof PluginConfigurationDocumentSchemaV1>;

function utf8Compare(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.byteLength - b.byteLength;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort(utf8Compare).map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function digestJson(tag: string, value: unknown, sha256: Sha256): ContentDigest {
  return ContentDigestSchema.parse(hashContent(
    encoder.encode(`${tag}\0${JSON.stringify(canonicalize(value))}`),
    sha256,
  ));
}

function descriptorProjection(option: ConfigurationOption): Record<string, unknown> {
  return {
    key: option.key,
    value: option.value,
    required: option.required,
    sensitive: option.sensitive,
  };
}

/** Hash validation and execution descriptors, not labels or provenance. */
export function digestConfigurationDescriptors(
  configuration: PluginConfiguration,
  sha256: Sha256,
): ContentDigest {
  const valid = PluginConfigurationSchema.parse(configuration);
  return digestJson(
    "configuration-descriptor-v1",
    valid.options.map(descriptorProjection).sort((left, right) => utf8Compare(String(left.key), String(right.key))),
    sha256,
  );
}

/** Derive a locator from all scope/config identity fields plus an unpredictable write id. */
export function deriveSecretLocator(
  input: Readonly<{
    scope: ScopeReference;
    plugin: PluginKey;
    configurationRef: PluginConfigurationRef;
    key: string;
    writeId: ConfigurationWriteId;
  }>,
  sha256: Sha256,
): SecretLocator {
  const scope = ScopeReferenceSchema.parse(input.scope);
  const plugin = PluginKeySchema.parse(input.plugin);
  const configurationRef = PluginConfigurationRefSchema.parse(input.configurationRef);
  const key = ConfigurationKeySchema.parse(input.key);
  const writeId = ConfigurationWriteIdSchema.parse(input.writeId);
  return SecretLocatorSchema.parse(digestJson(
    "secret-locator-v1",
    { scope, plugin, configurationRef, key, writeId },
    sha256,
  ).replace(/^sha256:/, "secret-v1:sha256:"));
}

function sortDocument(document: Omit<PluginConfigurationDocument, "revision">): Omit<PluginConfigurationDocument, "revision"> {
  return {
    ...document,
    values: [...document.values].sort((left, right) => utf8Compare(left.key, right.key)),
    secrets: [...document.secrets].sort((left, right) => utf8Compare(left.key, right.key)),
  };
}

function documentRevision(document: Omit<PluginConfigurationDocument, "revision">, sha256: Sha256): ContentDigest {
  return digestJson("plugin-configuration-document-v1", sortDocument(document), sha256);
}

const ConfigurationDocumentInputSchema = z.object({
  schemaVersion: z.literal(1),
  configurationRef: PluginConfigurationRefSchema,
  plugin: PluginKeySchema,
  scope: ScopeReferenceSchema,
  descriptorDigest: ContentDigestSchema,
  revision: ContentDigestSchema.optional(),
  values: z.array(ConfigurationDocumentValueSchema).readonly(),
  secrets: z.array(ConfigurationDocumentSecretSchema).readonly(),
}).strict();

/** Build a sorted document and derive its CAS revision; caller claims are checked. */
export function createPluginConfigurationDocument(input: unknown, sha256: Sha256): PluginConfigurationDocument {
  const value = ConfigurationDocumentInputSchema.parse(input);
  const withoutRevision = sortDocument({
    schemaVersion: 1,
    configurationRef: value.configurationRef,
    plugin: value.plugin,
    scope: value.scope,
    descriptorDigest: value.descriptorDigest,
    values: value.values,
    secrets: value.secrets,
  });
  const revision = documentRevision(withoutRevision, sha256);
  if (value.revision !== undefined && value.revision !== revision) {
    throw new Error("configuration document revision does not match its content");
  }
  return PluginConfigurationDocumentSchemaV1.parse({ ...withoutRevision, revision });
}

function optionByKey(configuration: PluginConfiguration): Map<string, ConfigurationOption> {
  return new Map(configuration.options.map((option) => [option.key, option]));
}

/** Verify descriptor binding, sensitivity partition, kinds, constraints, order, and revision. */
export function verifyPluginConfigurationDocument(
  input: unknown,
  descriptors: PluginConfiguration,
  sha256: Sha256,
): PluginConfigurationDocument {
  // A persisted document must already be canonical; creation is the only API
  // that normalizes caller ordering before deriving a revision.
  PluginConfigurationDocumentSchemaV1.parse(input);
  const document = createPluginConfigurationDocument(input, sha256);
  const configuration = PluginConfigurationSchema.parse(descriptors);
  const expectedDescriptorDigest = digestConfigurationDescriptors(configuration, sha256);
  if (document.descriptorDigest !== expectedDescriptorDigest) throw new Error("configuration descriptor digest does not match document");
  const options = optionByKey(configuration);
  const keys = new Set<string>();
  for (const entry of document.values) {
    const option = options.get(entry.key);
    if (option === undefined || option.sensitive || entry.value.kind !== option.value.kind) throw new Error("configuration value does not match its descriptor");
    if (!valueSatisfiesDescriptor(entry.value, option)) throw new Error("configuration value violates its descriptor");
    keys.add(entry.key);
  }
  for (const entry of document.secrets) {
    const option = options.get(entry.key);
    if (option === undefined || !option.sensitive || keys.has(entry.key)) throw new Error("configuration secret does not match its descriptor");
    keys.add(entry.key);
  }
  for (const option of configuration.options) {
    if (option.required && !keys.has(option.key)) throw new Error("required configuration value is missing");
  }
  return document;
}

function valueSatisfiesDescriptor(value: ConfiguredValue, option: ConfigurationOption): boolean {
  if (value.kind !== option.value.kind) return false;
  switch (option.value.kind) {
    case "string":
      return value.kind === "string" &&
        (option.value.pattern === undefined || testConfigurationPattern(option.value.pattern, value.value));
    case "number":
      return value.kind === "number" &&
        (option.value.min === undefined || value.value >= option.value.min) &&
        (option.value.max === undefined || value.value <= option.value.max);
    case "boolean": return value.kind === "boolean";
    case "directory":
    case "file": return value.kind === option.value.kind;
    case "strings":
      return value.kind === "strings" &&
        (option.value.minItems === undefined || value.value.length >= option.value.minItems) &&
        (option.value.maxItems === undefined || value.value.length <= option.value.maxItems);
    default: return assertNever(option.value);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled configuration descriptor: ${String(value)}`);
}

export type {
  ConfigurationOption,
  PluginConfiguration,
  PluginConfigurationRef,
  PluginKey,
  ScopeReference,
};
