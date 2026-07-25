import { z } from "zod";
import {
  ForeignComponentSchema,
  type ForeignComponent,
} from "../domain/components.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type ReadResult,
} from "../domain/errors.js";
import {
  ForeignComponentDeclarationSchema,
  type ForeignComponentDeclaration,
} from "../domain/bundle-ingestion.js";
import {
  NativeHostSchema,
  ProvenanceSchema,
  type NativeHost,
  type Provenance,
} from "../domain/provenance.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { JsonValueSchema, type JsonValue } from "../domain/schema.js";
import { stableComponentId } from "./stable-component-id.js";

export type ForeignComponentDeclarationContext = Readonly<{
  nativeHost: NativeHost;
  nativeKind: string;
  declarationSubkey: string;
  provenance: Provenance | readonly Provenance[];
}>;

export type ForeignComponentDeclarationInput = Readonly<ForeignComponentDeclarationContext & {
  declaration: unknown;
}>;

function provenanceList(
  value: Provenance | readonly Provenance[],
): readonly [Provenance, ...Provenance[]] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) throw new TypeError("foreign declaration provenance cannot be empty");
  return values.map((entry) => ProvenanceSchema.parse(entry)) as [Provenance, ...Provenance[]];
}

function invalid(
  operation: string,
  error: unknown,
  provenance?: Provenance,
): ReadResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof z.ZodError
    ? {
        issues: error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String),
          message: issue.message,
        })),
      }
    : undefined;
  return {
    ok: false,
    diagnostics: [DiagnosticSchema.parse({
      code: ErrorCodeRegistry.schemaInvalid,
      severity: "error",
      operation,
      message,
      ...(provenance === undefined ? {} : { location: provenance.location }),
      ...(details === undefined ? {} : { details }),
    })],
  };
}

/**
 * Construct the inventory declaration used for runtime-bearing native shapes.
 * This function is intentionally blind to the meaning of `declaration`: raw
 * JSON and all source claims cross this boundary unchanged.
 */
export function createForeignComponentDeclaration(
  input: ForeignComponentDeclarationInput,
): ReadResult<ForeignComponentDeclaration>;
export function createForeignComponentDeclaration(
  declaration: unknown,
  context: ForeignComponentDeclarationContext,
): ReadResult<ForeignComponentDeclaration>;
export function createForeignComponentDeclaration(
  inputOrDeclaration: ForeignComponentDeclarationInput | unknown,
  context?: ForeignComponentDeclarationContext,
): ReadResult<ForeignComponentDeclaration> {
  const input: ForeignComponentDeclarationInput = context === undefined
    ? inputOrDeclaration as ForeignComponentDeclarationInput
    : { ...context, declaration: inputOrDeclaration };
  try {
    const nativeHost = NativeHostSchema.parse(input.nativeHost);
    const nativeKind = z.string().min(1).parse(input.nativeKind);
    const declarationSubkey = z.string().min(1).parse(input.declarationSubkey);
    const declaration = JsonValueSchema.parse(input.declaration);
    const provenance = provenanceList(input.provenance);
    return {
      ok: true,
      value: ForeignComponentDeclarationSchema.parse({
        nativeHost,
        nativeKind: { value: nativeKind, provenance },
        declarationSubkey,
        declaration: { value: declaration, provenance },
      }),
      diagnostics: [],
    };
  } catch (error) {
    const provenance = (() => {
      try {
        const candidate = Array.isArray(input.provenance)
          ? input.provenance[0]
          : input.provenance;
        return candidate === undefined ? undefined : ProvenanceSchema.parse(candidate);
      } catch {
        return undefined;
      }
    })();
    return invalid("createForeignComponentDeclaration", error, provenance);
  }
}

/**
 * Materialize the declaration as the normalized foreign component shape. The
 * caller supplies the plugin key because host and semantic declaration identity
 * are intentionally part of the persisted component id.
 */
export function createForeignComponent(
  declaration: ForeignComponentDeclaration,
  plugin: PluginKey,
): ReadResult<ForeignComponent> {
  try {
    const valid = ForeignComponentDeclarationSchema.parse(declaration);
    const validPlugin = PluginKeySchema.parse(plugin);
    const provenance = valid.declaration.provenance;
    const identity = {
      kind: "foreign" as const,
      nativeHost: valid.nativeHost,
      nativeKind: valid.nativeKind.value,
      declarationSubkey: valid.declarationSubkey,
    };
    return {
      ok: true,
      value: ForeignComponentSchema.parse({
        kind: "foreign",
        id: stableComponentId(validPlugin, identity),
        nativeHost: valid.nativeHost,
        nativeKind: {
          value: valid.nativeKind.value,
          provenance,
        },
        declarationSubkey: valid.declarationSubkey,
        declaration: {
          value: valid.declaration.value,
          provenance,
        },
      }),
      diagnostics: [],
    };
  } catch (error) {
    const provenance = (() => {
      try {
        return declaration.declaration.provenance[0];
      } catch {
        return undefined;
      }
    })();
    return invalid("createForeignComponent", error, provenance);
  }
}

export type { ForeignComponentDeclaration, JsonValue };
