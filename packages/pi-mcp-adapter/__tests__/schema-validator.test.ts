import { describe, expect, it } from "vitest";
import { createMcpJsonSchemaValidator } from "../schema-validator.ts";

describe("createMcpJsonSchemaValidator", () => {
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
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let validate: (data: unknown) => boolean;
    try {
      const validator = createMcpJsonSchemaValidator().getValidator(schema);
      validate = (data: unknown) => validator(data).valid;
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(written.join("")).not.toContain("unknown format");
    expect(validate!({ start_ms: 5, end_ms: 9007199254740993 })).toBe(true);
    expect(validate!({ start_ms: "five" })).toBe(false);
    expect(validate!({})).toBe(false);
  });

  it("enforces integer-width ranges", () => {
    const validator = createMcpJsonSchemaValidator().getValidator({
      type: "object",
      properties: {
        small: { type: "integer", format: "int32" },
        big: { type: "integer", format: "uint64" },
        byte: { type: "integer", format: "uint8" },
      },
    });
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

  it("still validates formats it knows", () => {
    const validator = createMcpJsonSchemaValidator().getValidator({
      type: "object",
      properties: { when: { type: "string", format: "date-time" } },
      required: ["when"],
    });
    expect(validator({ when: "2026-07-26T12:00:00Z" }).valid).toBe(true);
    expect(validator({ when: "not a date" }).valid).toBe(false);
  });
});
