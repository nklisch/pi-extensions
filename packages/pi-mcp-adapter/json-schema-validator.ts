import { Ajv } from "ajv";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator as JsonSchemaValidatorProvider,
} from "@modelcontextprotocol/client";

// ajv-formats types target its bundled ajv; the runtime accepts both instances.
const addFormats = addFormatsImport as unknown as (instance: Ajv) => void;

type SchemaDialect =
  | { status: "unstamped" }
  | { status: "stamped"; uri: string };

const DRAFT_07_SCHEMA_URIS: ReadonlySet<string> = new Set([
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema",
]);
const DRAFT_2020_12_SCHEMA_URIS: ReadonlySet<string> = new Set([
  "https://json-schema.org/draft/2020-12/schema",
]);

/**
 * Servers generated with schemars (Rust MCP services) annotate integers with
 * OpenAPI width formats. Ajv does not know them and logs
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

function registerIntegerWidthFormats(ajv: Ajv): void {
  for (const [format, validate] of Object.entries(INTEGER_WIDTH_FORMATS)) {
    ajv.addFormat(format, { type: "number", validate });
  }
}

function schemaDialect(schema: JsonSchemaType): SchemaDialect {
  if (!("$schema" in schema) || typeof schema.$schema !== "string") {
    return { status: "unstamped" };
  }
  return {
    status: "stamped",
    uri: schema.$schema.endsWith("#") ? schema.$schema.slice(0, -1) : schema.$schema,
  };
}

export function createJsonSchemaValidator(): JsonSchemaValidatorProvider {
  let draft07Validator: AjvJsonSchemaValidator | undefined;
  let draft2020Validator: AjvJsonSchemaValidator | undefined;

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const dialect = schemaDialect(schema);
      if (dialect.status === "unstamped" || DRAFT_2020_12_SCHEMA_URIS.has(dialect.uri)) {
        draft2020Validator ??= (() => {
          const Ajv2020 = Ajv2020Import as unknown as typeof Ajv;
          // validateFormats: true opts the 2020-12 instance into treating
          // `format` as a validation keyword (the spec default is annotation-only).
          // The fork's historic validator enforced formats on every schema;
          // unstamped schemas route here, so the integer-width ranges must
          // still be checked, not just announced.
          const ajv = new Ajv2020({ strict: false, validateFormats: true, allErrors: true });
          addFormats(ajv);
          // Integer-width formats are dialect-agnostic; register them on the
          // 2020-12 instance too so unstamped modern schemas (the common case
          // for tool input/output schemas) get the same treatment.
          registerIntegerWidthFormats(ajv);
          return new AjvJsonSchemaValidator(ajv);
        })();
        return draft2020Validator.getValidator<T>(schema);
      }
      if (!DRAFT_07_SCHEMA_URIS.has(dialect.uri)) {
        throw new Error(`Unsupported JSON Schema dialect: ${dialect.uri}`);
      }

      draft07Validator ??= (() => {
        const ajv = new Ajv({
          strict: false,
          validateFormats: true,
          validateSchema: false,
          allErrors: true,
        });
        addFormats(ajv);
        registerIntegerWidthFormats(ajv);
        return new AjvJsonSchemaValidator(ajv);
      })();
      return draft07Validator.getValidator<T>(schema);
    },
  };
}
