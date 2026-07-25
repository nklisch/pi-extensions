import { z } from "zod";

/**
 * The JSON data model accepted at foreign-format boundaries.
 *
 * JSON numbers are finite by definition; rejecting NaN and infinities here
 * prevents a JavaScript-only value from crossing a serialized-data boundary.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Turn a non-empty schema registry into the tuple required by a discriminated
 * union. A missing variant is a programmer error, so fail at module setup
 * rather than producing a schema that accepts nothing or fails later.
 */
export function schemaValues<
  T extends Record<string, z.ZodTypeAny>,
>(registry: T): [T[keyof T], ...T[keyof T][]] {
  const values = Object.values(registry) as T[keyof T][];
  if (values.length === 0) {
    throw new Error("schemaValues requires a non-empty registry");
  }
  return values as [T[keyof T], ...T[keyof T][]];
}

/**
 * Assert the tuple invariant used by non-empty domain collections.
 */
export function nonEmptyReadonly<T>(
  values: readonly T[],
): readonly [T, ...T[]] {
  if (values.length === 0) {
    throw new Error("nonEmptyReadonly requires at least one value");
  }
  return values as readonly [T, ...T[]];
}
