import { canonicalJson, compareUtf8 } from "./canonical-json.js";
import {
  SourceLocationSchema,
  type SourceLocation,
} from "./provenance-location.js";
import { ProvenanceSchema, type Provenance } from "./provenance.js";
import { JsonValueSchema, type JsonValue } from "./schema.js";

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  return (left ?? 0) - (right ?? 0);
}

/** Exact source-location ordering; strings compare by UTF-8 without normalization. */
export function compareSourceLocationsUtf8(left: SourceLocation, right: SourceLocation): number {
  return compareUtf8(left.host, right.host) ||
    compareUtf8(left.documentKind, right.documentKind) ||
    compareUtf8(left.path, right.path) ||
    compareUtf8(left.pointer ?? "", right.pointer ?? "") ||
    compareOptionalNumber(left.line, right.line) ||
    compareOptionalNumber(left.column, right.column);
}

function canonicalSourceLocation(value: SourceLocation): SourceLocation {
  const valid = SourceLocationSchema.parse(value);
  // Missing and empty pointers both denote the document root in the existing
  // comparison contract; omission is the canonical spelling.
  return SourceLocationSchema.parse({
    host: valid.host,
    documentKind: valid.documentKind,
    path: valid.path,
    ...(valid.pointer === undefined || valid.pointer === "" ? {} : { pointer: valid.pointer }),
    ...(valid.line === undefined ? {} : { line: valid.line }),
    ...(valid.column === undefined ? {} : { column: valid.column }),
  });
}

export function canonicalSourceLocations(
  values: readonly SourceLocation[],
): readonly SourceLocation[] {
  const sorted = values.map(canonicalSourceLocation).sort(compareSourceLocationsUtf8);
  return sorted.filter((value, index) =>
    index === 0 || compareSourceLocationsUtf8(value, sorted[index - 1]!) !== 0);
}

/** Rebuild JSON objects in explicit UTF-8 key order while preserving array order. */
export function canonicalizeJsonValue(input: JsonValue): JsonValue {
  const value = JsonValueSchema.parse(input);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  const record = value as Readonly<Record<string, JsonValue>>;
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareUtf8)
      .map((key) => [key, canonicalizeJsonValue(record[key]!)]),
  );
}

export function compareProvenanceUtf8(left: Provenance, right: Provenance): number {
  const location = compareSourceLocationsUtf8(left.location, right.location);
  if (location !== 0) return location;
  if (left.declaration === undefined || right.declaration === undefined) {
    return left.declaration === right.declaration ? 0 : left.declaration === undefined ? -1 : 1;
  }
  return compareUtf8(canonicalJson(left.declaration), canonicalJson(right.declaration));
}

/** Provenance is set-like evidence: canonicalize declarations, sort, and dedupe exact tuples. */
export function canonicalProvenance(
  values: readonly Provenance[],
): readonly [Provenance, ...Provenance[]] {
  const sorted = values.map((value) => {
    const valid = ProvenanceSchema.parse(value);
    return ProvenanceSchema.parse({
      location: canonicalSourceLocation(valid.location),
      ...(valid.declaration === undefined
        ? {}
        : { declaration: canonicalizeJsonValue(valid.declaration) }),
    });
  }).sort(compareProvenanceUtf8);
  const unique = sorted.filter((value, index) =>
    index === 0 || compareProvenanceUtf8(value, sorted[index - 1]!) !== 0);
  if (unique.length === 0) throw new TypeError("canonical provenance cannot be empty");
  return unique as [Provenance, ...Provenance[]];
}
