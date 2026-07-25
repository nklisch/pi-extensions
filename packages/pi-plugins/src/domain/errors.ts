import { z } from "zod";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  FatalBoundaryCodeSchema,
  type Diagnostic,
  type FatalBoundaryCode,
} from "./error-contract.js";
import { DomainContractError } from "./domain-error.js";
import { PluginKeySchema, type PluginKey } from "./identity.js";
import { SourceLocationSchema, type SourceLocation } from "./provenance-location.js";
import { JsonValueSchema } from "./schema.js";
import "./provenance.js";

export {
  ErrorCodeRegistry,
  ErrorCodeSchema,
  FatalBoundaryCodeSchema,
  DiagnosticSchema,
} from "./error-contract.js";
export type {
  Diagnostic,
  ErrorCode,
  FatalBoundaryCode,
} from "./error-contract.js";
export { DomainContractError } from "./domain-error.js";
export { ClaimConflictError } from "./provenance.js";

/** Errors that make the enclosing marketplace, manifest, or adapter unusable. */
export class BoundaryError extends DomainContractError {
  constructor(
    input: Readonly<{
      code: FatalBoundaryCode;
      operation: string;
      message: string;
      location?: SourceLocation;
      plugin?: PluginKey;
      details?: z.infer<typeof JsonValueSchema>;
      cause?: unknown;
    }>,
  ) {
    super({ ...input, code: FatalBoundaryCodeSchema.parse(input.code) });
    this.name = "BoundaryError";
  }
}

/**
 * A schema factory for entry readers. Successful values may only carry
 * warnings; failed values must carry at least one error diagnostic. Keeping
 * these severities mutually exclusive prevents callers from treating a value
 * as usable while silently carrying a fatal entry error.
 */
export function ReadResultSchema<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion("ok", [
    z
      .object({
        ok: z.literal(true),
        value,
        diagnostics: z.array(DiagnosticSchema).readonly(),
      })
      .strict()
      .superRefine((result, context) => {
        if (result.diagnostics.some((diagnostic) => diagnostic.severity !== "warning")) {
          context.addIssue({
            code: "custom",
            path: ["diagnostics"],
            message: "successful read results may contain warning diagnostics only",
          });
        }
      }),
    z
      .object({
        ok: z.literal(false),
        diagnostics: z.array(DiagnosticSchema).min(1).readonly(),
      })
      .strict()
      .superRefine((result, context) => {
        if (!result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
          context.addIssue({
            code: "custom",
            path: ["diagnostics"],
            message: "failed read results must contain at least one error diagnostic",
          });
        }
      }),
  ]);
}

export type ReadResult<T> =
  | Readonly<{
      ok: true;
      value: T;
      diagnostics: readonly Diagnostic[];
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    }>;

/** A collection can retain valid siblings while reporting invalid entries. */
export function CollectionReadResultSchema<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      items: z.array(value).readonly(),
      diagnostics: z.array(DiagnosticSchema).readonly(),
    })
    .strict()
    .readonly();
}

export type CollectionReadResult<T> = Readonly<{
  items: readonly T[];
  diagnostics: readonly Diagnostic[];
}>;

function diagnosticIssuePath(path: readonly PropertyKey[]): readonly string[] {
  return path.map((segment) => String(segment));
}

/** Convert a Zod boundary failure into deterministic, source-aware JSON. */
export function diagnosticFromZodError(
  error: z.ZodError,
  context: Readonly<{
    operation: string;
    location?: SourceLocation;
    plugin?: PluginKey;
  }>,
): Diagnostic {
  if (!(error instanceof z.ZodError)) {
    throw new TypeError("diagnosticFromZodError requires a ZodError");
  }

  const issues = error.issues.map((issue) => ({
    code: issue.code,
    path: diagnosticIssuePath(issue.path),
    message: issue.message,
  }));
  const firstIssue = issues[0];
  const message = firstIssue === undefined
    ? `${context.operation} input is invalid`
    : `${context.operation} input is invalid at ${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}`;

  return DiagnosticSchema.parse({
    code: ErrorCodeRegistry.schemaInvalid,
    severity: "error",
    operation: z.string().min(1).parse(context.operation),
    message,
    ...(context.location === undefined
      ? {}
      : { location: SourceLocationSchema.parse(context.location) }),
    ...(context.plugin === undefined
      ? {}
      : { plugin: PluginKeySchema.parse(context.plugin) }),
    details: { issues },
  });
}
