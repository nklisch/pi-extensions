import { z } from "zod";
import { DomainContractError } from "./domain-error.js";
import { ErrorCodeRegistry } from "./error-contract.js";
import { JsonValueSchema, type JsonValue, nonEmptyReadonly } from "./schema.js";
import {
  SourceLocationSchema,
  type SourceLocation,
} from "./provenance-location.js";

export {
  NativeHostSchema,
  SourceDocumentKindSchema,
  SourceLocationSchema,
} from "./provenance-location.js";
export type {
  NativeHost,
  SourceDocumentKind,
  SourceLocation,
} from "./provenance-location.js";

export const ProvenanceSchema = z
  .object({
    location: SourceLocationSchema,
    declaration: JsonValueSchema.optional(),
  })
  .strict()
  .readonly();
export type Provenance = z.infer<typeof ProvenanceSchema>;

const ProvenanceListSchema = z
  .array(ProvenanceSchema)
  .nonempty()
  .readonly();

/**
 * Wrap a normalized value with the source declarations that support it.
 * Provenance is intentionally non-empty: a normalized value without a source
 * cannot be audited or reconciled with a second foreign declaration.
 */
export function ClaimedSchema<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      value,
      provenance: ProvenanceListSchema,
    })
    .strict();
}

export type Claimed<T> = Readonly<{
  value: T;
  provenance: readonly [Provenance, ...Provenance[]];
}>;

function safeJsonSnapshot(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : `[non-finite number: ${String(value)}]`;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}: ${String(value)}]`;
  }
  if (typeof value !== "object") {
    return `[unrepresentable ${typeof value}]`;
  }
  if (seen.has(value)) {
    return "[circular value]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => safeJsonSnapshot(entry, seen));
  }

  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    try {
      result[key] = safeJsonSnapshot((value as Record<string, unknown>)[key], seen);
    } catch {
      result[key] = "[unreadable value]";
    }
  }
  return result;
}

function claimDiagnosticSnapshot<T>(value: Claimed<T>): JsonValue {
  return {
    value: safeJsonSnapshot(value.value),
    // Provenance has already crossed its strict schema boundary. The cast only
    // adapts its readonly structural type to the recursive JSON contract.
    provenance: value.provenance as unknown as JsonValue,
  };
}

/** A typed conflict that participates in the common domain diagnostic path. */
export class ClaimConflictError<T = unknown> extends DomainContractError {
  readonly left: Claimed<T>;
  readonly right: Claimed<T>;

  constructor(left: Claimed<T>, right: Claimed<T>) {
    const validLeft = ProvenanceListSchema.parse(left.provenance);
    const validRight = ProvenanceListSchema.parse(right.provenance);
    super({
      code: ErrorCodeRegistry.claimConflict,
      operation: "mergeEquivalentClaims",
      message: "Cannot merge claims with different values",
      details: {
        left: claimDiagnosticSnapshot({ value: left.value, provenance: validLeft as [Provenance, ...Provenance[]] }),
        right: claimDiagnosticSnapshot({ value: right.value, provenance: validRight as [Provenance, ...Provenance[]] }),
      },
    });
    this.name = "ClaimConflictError";
    this.left = left;
    this.right = right;
  }
}

export function claim<T>(value: T, provenance: Provenance): Claimed<T> {
  const validProvenance = ProvenanceSchema.parse(provenance);
  return {
    value,
    provenance: [validProvenance],
  };
}

function validatedProvenance<T>(
  candidate: Claimed<T>,
  name: string,
): readonly [Provenance, ...Provenance[]] {
  if (candidate === null || typeof candidate !== "object") {
    throw new TypeError(`${name} must be a claimed value`);
  }

  // The value is generic and therefore cannot be schema-validated here. The
  // source list remains a strict boundary contract for every generic claim.
  return nonEmptyReadonly(ProvenanceListSchema.parse(candidate.provenance));
}

function sameSourceLocation(left: SourceLocation, right: SourceLocation): boolean {
  return (
    left.host === right.host &&
    left.documentKind === right.documentKind &&
    left.path === right.path &&
    left.pointer === right.pointer &&
    left.line === right.line &&
    left.column === right.column
  );
}

function defaultEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => defaultEquals(value, right[index]));
  }

  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      defaultEquals(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}

export function mergeEquivalentClaims<T>(
  left: Claimed<T>,
  right: Claimed<T>,
  equals: (a: T, b: T) => boolean = defaultEquals as (a: T, b: T) => boolean,
): Claimed<T> {
  const leftProvenance = validatedProvenance(left, "left");
  const rightProvenance = validatedProvenance(right, "right");

  // A source location identifies one declaration. If two claims reuse that
  // exact location with different raw data, retaining only the first claim
  // would make provenance lie about what the reader observed. This check is
  // intentionally stricter than normalized-value equality: equivalent
  // normalization does not erase a contradictory raw declaration.
  if (leftProvenance.some((leftSource) =>
    rightProvenance.some((rightSource) =>
      sameSourceLocation(leftSource.location, rightSource.location) &&
      !defaultEquals(leftSource.declaration, rightSource.declaration)))) {
    throw new ClaimConflictError(left, right);
  }

  if (!equals(left.value, right.value)) {
    throw new ClaimConflictError(left, right);
  }

  const provenance: Provenance[] = [...leftProvenance];
  for (const candidate of rightProvenance) {
    if (!provenance.some((existing) => sameSourceLocation(existing.location, candidate.location))) {
      provenance.push(candidate);
    }
  }

  return {
    value: left.value,
    provenance: provenance as [Provenance, ...Provenance[]],
  };
}
