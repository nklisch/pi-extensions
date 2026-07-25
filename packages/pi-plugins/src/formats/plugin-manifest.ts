import { z } from "zod";
import {
  PluginManifestClaimsSchema,
  PluginManifestPathRegistry,
  type ComponentLocatorClaim,
  type ForeignComponentDeclaration,
  type PluginManifestClaims,
} from "../domain/bundle-ingestion.js";
import {
  DiagnosticSchema,
  type Diagnostic,
  type ReadResult,
} from "../domain/errors.js";
import {
  claim,
  NativeHostSchema,
  ProvenanceSchema,
  type Claimed,
  type NativeHost,
  type Provenance,
} from "../domain/provenance.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { JsonValueSchema, type JsonValue } from "../domain/schema.js";
import { RetainedMetadataSchema, type RetainedMetadata } from "../domain/components.js";
import { splitForeignDeclaration } from "../domain/foreign-identity.js";

export const CLAUDE_PLUGIN_MANIFEST_PATH = PluginManifestPathRegistry.claude;
export const CODEX_PLUGIN_MANIFEST_PATH = PluginManifestPathRegistry.codex;

export type PluginManifestReaderContext = Readonly<{
  path: string;
  plugin: PluginKey;
}>;

export type PluginManifestReader = (
  input: unknown,
  context: PluginManifestReaderContext,
) => ReadResult<PluginManifestClaims>;

export type ManifestHostReaderOptions = Readonly<{
  nativeHost: NativeHost;
  operation: string;
  runtimeFields: ReadonlySet<string>;
}>;

const supportedFields = ["skills", "hooks", "mcpServers"] as const;
type SupportedField = (typeof supportedFields)[number];

/**
 * Only these fields are proven behavior-neutral presentation metadata. The
 * allowlist is intentionally explicit: a new manifest field must remain in
 * foreign inventory until its host semantics are understood.
 */
const presentationFields = new Set([
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "interface",
  "category",
  "tags",
  "displayName",
  "shortDescription",
  "longDescription",
]);

class ManifestReaderFailure extends Error {
  readonly code: "MANIFEST_ROOT_INVALID" | "SCHEMA_INVALID";
  readonly pointer: string;
  readonly details?: JsonValue;

  constructor(
    code: ManifestReaderFailure["code"],
    pointer: string,
    message: string,
    details?: JsonValue,
  ) {
    super(message);
    this.name = "ManifestReaderFailure";
    this.code = code;
    this.pointer = pointer;
    if (details !== undefined) this.details = details;
  }
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointerSegment(key: string | number): string {
  return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(pointer: string, key: string | number): string {
  return `${pointer}/${pointerSegment(key)}`;
}

function sourceProvenance(
  nativeHost: NativeHost,
  path: string,
  pointer: string,
  declaration?: JsonValue,
): Provenance {
  return ProvenanceSchema.parse({
    location: {
      host: nativeHost,
      documentKind: "manifest",
      path,
      pointer,
    },
    ...(declaration === undefined ? {} : { declaration }),
  });
}

function claimedAt<T>(
  value: T,
  nativeHost: NativeHost,
  path: string,
  pointer: string,
  declaration: JsonValue,
): Claimed<T> {
  return claim(value, sourceProvenance(nativeHost, path, pointer, declaration));
}

function fail(
  pointer: string,
  message: string,
  details?: JsonValue,
): never {
  throw new ManifestReaderFailure("SCHEMA_INVALID", pointer, message, details);
}

function rootFail(pointer: string, message: string, details?: JsonValue): never {
  throw new ManifestReaderFailure("MANIFEST_ROOT_INVALID", pointer, message, details);
}

function requireString(
  value: JsonValue | undefined,
  pointer: string,
  field: string,
  nonEmpty = false,
): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) {
    fail(pointer, `${field} must be a${nonEmpty ? " non-empty" : ""} string`);
  }
  return value;
}

function requireStringArray(
  value: JsonValue,
  pointer: string,
  field: string,
): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(pointer, `${field} must be an array of strings`);
  }
  return value as readonly string[];
}

/**
 * Manifest paths are declarations, not filesystem paths. Keep validation
 * lexical here; the finite content index owns materialized containment.
 */
export function normalizeManifestPath(value: unknown, pointer: string): string {
  if (typeof value !== "string" || value.length < 3 || !value.startsWith("./")) {
    fail(pointer, "manifest paths must begin with ./");
  }
  if (value.includes("\\") || value.includes("\u0000")) {
    fail(pointer, "manifest paths cannot contain backslashes or NUL bytes");
  }
  const body = value.slice(2).endsWith("/") ? value.slice(2, -1) : value.slice(2);
  const rawSegments = body.split("/");
  if (
    rawSegments.length === 0 ||
    rawSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    /^[A-Za-z]:/.test(rawSegments[0] ?? "")
  ) {
    fail(pointer, "manifest path contains an invalid segment");
  }
  return `./${rawSegments.join("/")}`;
}

function locator(
  nativeHost: NativeHost,
  path: string,
  pointer: string,
  declaration: JsonValue,
  componentKind: ComponentLocatorClaim["componentKind"],
  target: ComponentLocatorClaim["target"],
): ComponentLocatorClaim {
  return {
    nativeHost,
    componentKind,
    authority: "authoritative",
    source: "manifest",
    target,
    provenance: [sourceProvenance(nativeHost, path, pointer, declaration)],
  };
}

function pathTarget(
  nativeHost: NativeHost,
  path: string,
  pointer: string,
  declaration: JsonValue,
  componentKind: "skill" | "hook" | "mcp-server",
  targetKind: "file" | "directory",
  rawPath: unknown,
): ComponentLocatorClaim {
  const targetPath = normalizeManifestPath(rawPath, pointer);
  return locator(nativeHost, path, pointer, declaration, componentKind, {
    kind: targetKind,
    path: targetPath,
  });
}

function readPathLocators(
  raw: JsonValue,
  nativeHost: NativeHost,
  path: string,
  pointer: string,
  field: SupportedField,
): ComponentLocatorClaim[] {
  const componentKind = field === "skills" ? "skill" : field === "hooks" ? "hook" : "mcp-server";
  const targetKind = field === "skills" ? "directory" : "file";

  if (field === "skills" && Array.isArray(raw)) {
    return raw.map((value, index) => pathTarget(
      nativeHost,
      path,
      childPointer(pointer, index),
      value,
      componentKind,
      targetKind,
      value,
    ));
  }

  if (field !== "skills" && isRecord(raw)) {
    // Hook and MCP declarations may be embedded in a manifest. They remain
    // opaque JSON until their dedicated readers run in the next unit.
    return [locator(nativeHost, path, pointer, raw, componentKind, {
      kind: "inline",
      declaration: raw,
    })];
  }

  return [pathTarget(nativeHost, path, pointer, raw, componentKind, targetKind, raw)];
}

function foreignDeclarations(
  nativeHost: NativeHost,
  path: string,
  pointer: string,
  field: string,
  declaration: JsonValue,
): readonly ForeignComponentDeclaration[] {
  const provenance = sourceProvenance(nativeHost, path, pointer, declaration);
  const claimValue = claim(declaration, provenance);
  return splitForeignDeclaration(field, claimValue).map((item) => ({
    nativeHost,
    nativeKind: claim(field, item.declaration.provenance[0]!),
    declarationSubkey: item.declarationSubkey,
    declaration: item.declaration,
  }));
}

function validatePresentation(field: string, value: JsonValue, pointer: string): void {
  switch (field) {
    case "author":
    case "interface":
      if (!isRecord(value)) fail(pointer, `${field} must be an object`);
      return;
    case "keywords":
    case "tags":
      requireStringArray(value, pointer, field);
      return;
    case "homepage":
    case "repository":
    case "license":
    case "category":
    case "displayName":
    case "shortDescription":
    case "longDescription":
      requireString(value, pointer, field);
      return;
    default:
      return;
  }
}

function metadata(
  nativeHost: NativeHost,
  path: string,
  pointer: string,
  field: string,
  declaration: JsonValue,
): RetainedMetadata {
  return RetainedMetadataSchema.parse({
    key: `${nativeHost}.${field}`,
    claimed: claimedAt(declaration, nativeHost, path, pointer, declaration),
  });
}

function zodDetails(error: z.ZodError): JsonValue {
  return {
    issues: error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
      message: issue.message,
    })),
  };
}

function readerDiagnostic(
  failure: ManifestReaderFailure,
  options: ManifestHostReaderOptions,
  context: PluginManifestReaderContext,
): Diagnostic {
  const location = sourceProvenance(
    options.nativeHost,
    context.path,
    failure.pointer,
  ).location;
  return DiagnosticSchema.parse({
    code: failure.code,
    severity: "error",
    operation: options.operation,
    message: failure.message,
    location,
    plugin: PluginKeySchema.parse(context.plugin),
    ...(failure.details === undefined ? {} : { details: failure.details }),
  });
}

function readRecord(
  input: unknown,
  context: PluginManifestReaderContext,
  options: ManifestHostReaderOptions,
): ReadResult<PluginManifestClaims> {
  try {
    const nativeHost = NativeHostSchema.parse(options.nativeHost);
    const plugin = PluginKeySchema.parse(context.plugin);
    const value = JsonValueSchema.parse(input);
    if (!isRecord(value)) {
      rootFail("", "plugin manifest root must be a JSON object");
    }

    const document = sourceProvenance(nativeHost, context.path, "", value);
    const rawName = value.name;
    const name = claimedAt(
      requireString(rawName, "/name", "name", true),
      nativeHost,
      context.path,
      "/name",
      rawName as JsonValue,
    );

    const version = rawValueClaim(value, "version", nativeHost, context.path, true);
    const description = rawValueClaim(value, "description", nativeHost, context.path, false);
    if (description !== undefined && typeof description.value !== "string") {
      fail("/description", "description must be a string");
    }

    const locators: ComponentLocatorClaim[] = [];
    const foreign: ForeignComponentDeclaration[] = [];
    const retainedMetadata: RetainedMetadata[] = [];

    for (const field of supportedFields) {
      const raw = value[field];
      if (raw === undefined) continue;
      const pointer = `/${field}`;
      locators.push(...readPathLocators(raw, nativeHost, context.path, pointer, field));
    }

    const excluded = new Set<string>([
      "name",
      "version",
      "description",
      ...supportedFields,
    ]);
    for (const field of Object.keys(value).sort()) {
      if (excluded.has(field)) continue;
      const raw = value[field];
      if (raw === undefined) continue;
      const pointer = `/${pointerSegment(field)}`;
      if (presentationFields.has(field)) {
        validatePresentation(field, raw, pointer);
        retainedMetadata.push(metadata(nativeHost, context.path, pointer, field, raw));
      } else {
        // Known runtime fields and unknown fields follow the same fail-closed
        // path. The host registry documents known runtime vocabulary, but a
        // field name alone is never evidence that an unknown value is safe to
        // retain as presentation metadata.
        foreign.push(...foreignDeclarations(nativeHost, context.path, pointer, field, raw));
      }
    }

    return {
      ok: true,
      value: PluginManifestClaimsSchema.parse({
        nativeHost,
        document,
        name,
        ...(version === undefined ? {} : { version }),
        ...(description === undefined ? {} : { description }),
        locators,
        configuration: [],
        foreign,
        metadata: retainedMetadata,
      }),
      diagnostics: [],
    };
  } catch (error) {
    if (error instanceof ManifestReaderFailure) {
      return { ok: false, diagnostics: [readerDiagnostic(error, options, context)] };
    }
    if (error instanceof z.ZodError) {
      const failure = new ManifestReaderFailure(
        "SCHEMA_INVALID",
        "",
        "plugin manifest does not satisfy its normalized contract",
        zodDetails(error),
      );
      return { ok: false, diagnostics: [readerDiagnostic(failure, options, context)] };
    }
    const failure = new ManifestReaderFailure(
      "SCHEMA_INVALID",
      "",
      error instanceof Error ? error.message : "plugin manifest is invalid",
    );
    return { ok: false, diagnostics: [readerDiagnostic(failure, options, context)] };
  }
}

function rawValueClaim<T extends string>(
  record: { readonly [key: string]: JsonValue },
  field: string,
  nativeHost: NativeHost,
  path: string,
  nonEmpty: boolean,
): Claimed<T> | undefined {
  const raw = record[field];
  if (raw === undefined) return undefined;
  const value = requireString(raw, `/${field}`, field, nonEmpty) as T;
  return claimedAt(value, nativeHost, path, `/${field}`, raw);
}

export function readManifestRecord(
  input: unknown,
  context: PluginManifestReaderContext,
  options: ManifestHostReaderOptions,
): ReadResult<PluginManifestClaims> {
  return readRecord(input, context, options);
}

export {
  PluginManifestClaimsSchema,
  PluginManifestPathRegistry,
};
export type {
  ComponentLocatorClaim,
  ForeignComponentDeclaration,
  PluginManifestClaims,
};
