import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  JsonValueSchema,
  nonEmptyReadonly,
  schemaValues,
  type JsonValue,
} from "../../src/domain/schema.js";

describe("JsonValueSchema", () => {
  it("accepts recursively valid JSON values", () => {
    const value = {
      name: "plugin",
      enabled: true,
      retries: 2,
      tags: ["one", null, { nested: false }],
    } as const;

    expect(JsonValueSchema.parse(value)).toEqual(value);
  });

  it.each([
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "positive infinity"],
    [Number.NEGATIVE_INFINITY, "negative infinity"],
    [{ nested: undefined }, "undefined object member"],
    [undefined, "undefined"],
  ])("rejects %s (%s)", (value, _label) => {
    expect(JsonValueSchema.safeParse(value).success).toBe(false);
  });

  it("owns the public value type through the schema", () => {
    type InferredJsonValue = z.infer<typeof JsonValueSchema>;
    expectTypeOf<InferredJsonValue>().toEqualTypeOf<JsonValue>();
  });
});

describe("schemaValues", () => {
  const registry = {
    supported: z.object({ kind: z.literal("supported") }),
    incompatible: z.object({ kind: z.literal("incompatible") }),
  } as const;

  it("preserves all registry schemas in declaration order", () => {
    expect(schemaValues(registry)).toEqual([
      registry.supported,
      registry.incompatible,
    ]);
  });

  it("rejects an empty registry deterministically", () => {
    expect(() => schemaValues({})).toThrow(
      "schemaValues requires a non-empty registry",
    );
  });
});

describe("nonEmptyReadonly", () => {
  it("returns a non-empty readonly tuple", () => {
    const values = nonEmptyReadonly(["one", "two"] as const);

    expect(values).toEqual(["one", "two"]);
    expectTypeOf(values).toEqualTypeOf<readonly ["one" | "two", ...("one" | "two")[]]>();
  });

  it("rejects an empty collection deterministically", () => {
    expect(() => nonEmptyReadonly([])).toThrow(
      "nonEmptyReadonly requires at least one value",
    );
  });
});
