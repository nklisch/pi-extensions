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
 * JSON Schema `format` is annotation-only, and servers generated with
 * schemars (Rust MCP services) annotate integers with the OpenAPI width
 * formats. Ajv does not know them and logs
 * `unknown format "uint64" ignored in schema` once per occurrence when the
 * SDK client compiles a tool outputSchema — pure noise for every tool call.
 * Registering them as pass-through validators keeps the annotation on the
 * wire while silencing the warning.
 */
const INTEGER_WIDTH_FORMATS = [
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
] as const;

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
  for (const format of INTEGER_WIDTH_FORMATS) {
    ajv.addFormat(format, () => true);
  }
  return new AjvJsonSchemaValidator(ajv);
}
