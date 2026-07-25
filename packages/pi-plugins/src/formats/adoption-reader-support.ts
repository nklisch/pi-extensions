import { z } from "zod";
import {
  AdoptionDocumentKindSchema,
  AdoptionDeclarationSchema,
  type AdoptionDeclaration,
  type AdoptionDocumentKind,
} from "../domain/adoption.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type CollectionReadResult,
  type Diagnostic,
} from "../domain/errors.js";
import {
  claim,
  type Claimed,
  type NativeHost,
  type Provenance,
} from "../domain/provenance.js";
import { SourceLocationSchema, type SourceLocation } from "../domain/provenance-location.js";
import { JsonValueSchema, type JsonValue } from "../domain/schema.js";
import { MarketplaceNameSchema, type MarketplaceName } from "../domain/identity.js";
import { MarketplaceSourceSchema, type MarketplaceSource } from "../domain/source.js";

export type AdoptionReaderContext = Readonly<{
  path: string;
}>;

export function jsonPointer(...segments: readonly (string | number)[]): string {
  if (segments.length === 0) return "";
  return `/${segments.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

export function sourceLocation(
  host: NativeHost,
  document: AdoptionDocumentKind,
  path: string,
  pointer: string,
): SourceLocation {
  return SourceLocationSchema.parse({
    host,
    documentKind: "foreign-state",
    path,
    pointer,
  });
}

export function sourceProvenance(
  host: NativeHost,
  document: AdoptionDocumentKind,
  path: string,
  pointer: string,
  declaration: JsonValue,
): Provenance {
  return { location: sourceLocation(host, document, path, pointer), declaration };
}

export function claimedAt<T>(
  value: T,
  host: NativeHost,
  document: AdoptionDocumentKind,
  path: string,
  pointer: string,
  declaration: JsonValue,
): Claimed<T> {
  return claim(value, sourceProvenance(host, document, path, pointer, declaration));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJsonRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function rootDiagnostic(
  host: NativeHost,
  document: AdoptionDocumentKind,
  path: string,
  message: string,
  details?: JsonValue,
): Diagnostic {
  return DiagnosticSchema.parse({
    code: ErrorCodeRegistry.foreignStateRootInvalid,
    severity: "error",
    operation: `read${document}`,
    message,
    location: sourceLocation(host, document, path, ""),
    ...(details === undefined ? {} : { details }),
  });
}

export function entryDiagnostic(
  host: NativeHost,
  document: AdoptionDocumentKind,
  path: string,
  pointer: string,
  code: Diagnostic["code"],
  message: string,
  details?: JsonValue,
): Diagnostic {
  return DiagnosticSchema.parse({
    code,
    severity: "error",
    operation: `read${document}`,
    message,
    location: sourceLocation(host, document, path, pointer),
    ...(details === undefined ? {} : { details }),
  });
}

export function schemaDiagnostic(
  host: NativeHost,
  document: AdoptionDocumentKind,
  path: string,
  pointer: string,
  error: z.ZodError,
): Diagnostic {
  return entryDiagnostic(
    host,
    document,
    path,
    pointer,
    ErrorCodeRegistry.sourceInvalid,
    "Foreign source declaration is not a supported Pi marketplace source",
    {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map(String),
        message: issue.message,
      })),
    },
  );
}

export function makeDeclaration(input: Readonly<{
  host: NativeHost;
  document: AdoptionDocumentKind;
  alias: MarketplaceName;
  source: MarketplaceSource;
  path: string;
  aliasPointer: string;
  sourcePointer: string;
  rawSource: JsonValue;
}>): AdoptionDeclaration {
  return AdoptionDeclarationSchema.parse({
    host: input.host,
    document: AdoptionDocumentKindSchema.parse(input.document),
    suggestedMarketplace: claimedAt(
      MarketplaceNameSchema.parse(input.alias),
      input.host,
      input.document,
      input.path,
      input.aliasPointer,
      input.rawSource,
    ),
    source: claimedAt(
      MarketplaceSourceSchema.parse(input.source),
      input.host,
      input.document,
      input.path,
      input.sourcePointer,
      input.rawSource,
    ),
  });
}

export function parseJsonRoot(
  source: string,
  host: NativeHost,
  document: AdoptionDocumentKind,
  path: string,
): { value?: JsonValue; diagnostics: readonly Diagnostic[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return { diagnostics: [rootDiagnostic(host, document, path, "Foreign-state JSON is syntactically invalid")] };
  }
  const result = JsonValueSchema.safeParse(parsed);
  if (!result.success || !isJsonRecord(result.data)) {
    return {
      diagnostics: [rootDiagnostic(host, document, path, "Foreign-state JSON root must be an object")],
    };
  }
  return { value: result.data, diagnostics: [] };
}

export function collection<T>(items: readonly T[], diagnostics: readonly Diagnostic[]): CollectionReadResult<T> {
  return { items, diagnostics };
}

export function asString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function recordToJson(value: Record<string, unknown>): JsonValue | undefined {
  const parsed = JsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
