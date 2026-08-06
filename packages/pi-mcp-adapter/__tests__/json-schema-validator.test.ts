import { describe, expect, it } from "vitest";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { createJsonSchemaValidator } from "../json-schema-validator.ts";

const draft07 = "http://json-schema.org/draft-07/schema#";
const draft07Https = "https://json-schema.org/draft-07/schema#";

function validate(schema: Record<string, unknown>, value: unknown) {
  return createJsonSchemaValidator().getValidator(schema as JsonSchemaType)(value);
}

/**
 * Capture Ajv's `unknown format` stderr noise so the integer-width formats can
 * be proven to silence it. Mirrors the original schema-validator test approach.
 */
function captureStderr<T>(fn: () => T): { output: string; result: T } {
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = fn();
    return { output: written.join(""), result };
  } finally {
    process.stderr.write = originalWrite;
  }
}

describe("createJsonSchemaValidator", () => {
  it.each([draft07, draft07Https])("routes %s to draft-07 semantics", schema => {
    const result = validate({
      $schema: schema,
      type: "object",
      properties: {
        values: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
          additionalItems: false,
        },
      },
      required: ["values"],
    }, { values: ["ok", 1] });

    expect(result).toMatchObject({ valid: true, data: { values: ["ok", 1] } });
    expect(validate({
      $schema: schema,
      type: "object",
      properties: {
        values: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
          additionalItems: false,
        },
      },
      required: ["values"],
    }, { values: ["ok", 1, true] }).valid).toBe(false);
  });

  it("enforces draft-07 formats", () => {
    const schema = {
      $schema: draft07,
      type: "object",
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
    };

    expect(validate(schema, { email: "valid@example.com" }).valid).toBe(true);
    expect(validate(schema, { email: "not-an-email" }).valid).toBe(false);
  });

  it("keeps 2020-12 tuple semantics for explicit and unstamped schemas", () => {
    const schema = {
      type: "object",
      properties: {
        values: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
          items: false,
        },
      },
      required: ["values"],
    };

    for (const candidate of [schema, { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }]) {
      expect(validate(candidate, { values: ["ok", 1] }).valid).toBe(true);
      expect(validate(candidate, { values: ["ok", 1, true] }).valid).toBe(false);
    }
  });

  it("accepts unstamped schemas that use draft-07-compatible keywords", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
      additionalProperties: false,
    };

    expect(validate(schema, { name: "ok" }).valid).toBe(true);
    expect(validate(schema, { name: "" }).valid).toBe(false);
    expect(validate(schema, { name: "ok", extra: true }).valid).toBe(false);
  });

  it("does not downgrade an unsupported explicit dialect", () => {
    expect(() => validate({
      $schema: "https://example.com/custom-schema",
      type: "object",
    }, {})).toThrow(/unsupported.*dialect|2020-12/i);
  });

  it("creates isolated validator providers", () => {
    const first = createJsonSchemaValidator();
    const second = createJsonSchemaValidator();
    const firstSchema = { $schema: draft07, $id: "https://example.com/shared-schema", type: "string" };
    const secondSchema = { $schema: draft07, $id: "https://example.com/shared-schema", type: "number" };

    expect(first.getValidator(firstSchema as JsonSchemaType)("ok").valid).toBe(true);
    expect(second.getValidator(secondSchema as JsonSchemaType)(42).valid).toBe(true);
  });

  describe("integer-width formats (schemars-compatible)", () => {
    it("compiles schemars-style integer-width formats without warnings", () => {
      const schema = {
        type: "object",
        properties: {
          start_ms: { type: "integer", format: "int64" },
          end_ms: { type: "integer", format: "uint64" },
          count: { type: "integer", format: "uint32" },
          offset: { type: "integer", format: "int32" },
        },
        required: ["start_ms"],
      };
      const { output, result: getValidator } = captureStderr(() =>
        createJsonSchemaValidator().getValidator(schema as JsonSchemaType));
      const valid = (data: unknown) => getValidator(data).valid;

      expect(output).not.toContain("unknown format");
      expect(valid({ start_ms: 5, end_ms: 9007199254740993 })).toBe(true);
      expect(valid({ start_ms: "five" })).toBe(false);
      expect(valid({})).toBe(false);
    });

    it("enforces integer-width ranges on draft-07 schemas", () => {
      const validator = createJsonSchemaValidator().getValidator({
        $schema: draft07,
        type: "object",
        properties: {
          small: { type: "integer", format: "int32" },
          big: { type: "integer", format: "uint64" },
          byte: { type: "integer", format: "uint8" },
        },
      } as JsonSchemaType);
      const valid = (data: unknown) => validator(data).valid;
      expect(valid({ small: 2 ** 31 - 1, big: 0, byte: 255 })).toBe(true);
      expect(valid({ small: -(2 ** 31), big: 2 ** 53, byte: 0 })).toBe(true);
      expect(valid({ small: 2 ** 31 })).toBe(false); // exceeds int32
      expect(valid({ small: -(2 ** 31) - 1 })).toBe(false);
      expect(valid({ big: -1 })).toBe(false); // uint64 is unsigned
      expect(valid({ big: 1.5 })).toBe(false); // not an integer
      expect(valid({ byte: 256 })).toBe(false);
      expect(valid({ byte: -1 })).toBe(false);
    });

    it("enforces integer-width ranges on unstamped (2020-12) schemas", () => {
      // Tool input/output schemas usually arrive unstamped; the modern
      // dialect instance must register the same integer-width formats.
      const validator = createJsonSchemaValidator().getValidator({
        type: "object",
        properties: {
          small: { type: "integer", format: "int16" },
          big: { type: "integer", format: "uint64" },
          byte: { type: "integer", format: "uint8" },
        },
      } as JsonSchemaType);
      const valid = (data: unknown) => validator(data).valid;
      expect(valid({ small: 2 ** 15 - 1, big: 0, byte: 255 })).toBe(true);
      expect(valid({ small: 2 ** 15 })).toBe(false); // exceeds int16
      expect(valid({ big: -1 })).toBe(false); // uint64 is unsigned
      expect(valid({ byte: 256 })).toBe(false);
    });
  });
});
