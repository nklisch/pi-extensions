import { Ajv } from "ajv";
import addFormatsImport from "ajv-formats";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

// ajv-formats is CJS: under some interop modes the callable is the default
// export, under others the namespace itself.
const addFormats: (ajv: Ajv) => unknown =
  typeof addFormatsImport === "function"
    ? addFormatsImport
    : (addFormatsImport as { default: (ajv: Ajv) => unknown }).default;

/**
 * Servers generated with schemars (Rust MCP services) annotate integers with
 * the OpenAPI width formats. Ajv does not know them and logs
 * `unknown format "uint64" ignored in schema` once per occurrence when the
 * SDK client compiles a tool outputSchema — pure noise for every tool call.
 * Registering real validators both silences the warning and makes the
 * annotation true: widths up to 32 bits are range-checked exactly; 64-bit
 * checks assert integer-ness and sign because JSON numbers cannot carry the
 * full 64-bit range with exact precision anyway.
 */
const bounded = (min: number, max: number) => (value: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

const INTEGER_WIDTH_FORMATS: Record<string, (value: number) => boolean> = {
  int8: bounded(-(2 ** 7), 2 ** 7 - 1),
  int16: bounded(-(2 ** 15), 2 ** 15 - 1),
  int32: bounded(-(2 ** 31), 2 ** 31 - 1),
  int64: (value) => Number.isInteger(value),
  uint8: bounded(0, 2 ** 8 - 1),
  uint16: bounded(0, 2 ** 16 - 1),
  uint32: bounded(0, 2 ** 32 - 1),
  uint64: (value) => Number.isInteger(value) && value >= 0,
};

/**
 * Build the JSON Schema validator handed to every MCP client. Mirrors the
 * SDK default (AjvJsonSchemaValidator's built-in Ajv configuration) plus the
 * integer-width formats above.
 */
export function createMcpJsonSchemaValidator(): AjvJsonSchemaValidator {
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
  });
  addFormats(ajv);
  for (const [format, validate] of Object.entries(INTEGER_WIDTH_FORMATS)) {
    ajv.addFormat(format, { type: "number", validate });
  }
  return new AjvJsonSchemaValidator(ajv);
}
