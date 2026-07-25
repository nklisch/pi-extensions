import { ErrorCodeRegistry } from "../domain/error-contract.js";
import type { Diagnostic } from "../domain/errors.js";
import type { NativeDiagnosticFinding } from "./native-diagnostic-compiler.js";
import { NativeProvenanceViewSchema, type NativeProvenanceView, type InspectionDetailId } from "./native-inspection-contract.js";
import { NativeDisplayLimits, toSafeDisplayField } from "./native-inspection-display.js";

/**
 * Fixed failure-reason vocabulary. Facts never carry native error messages or
 * causes; the presenter maps these stable tokens to plain-language sentences
 * in marketplace/plugin terms.
 */
export const SourceFailureReasonSchema = {
  invalidJson: "invalid-json",
  wrongShape: "wrong-shape",
  missingTarget: "missing-target",
  pathEscape: "path-escape",
  fieldConflict: "field-conflict",
  sourceUnreachable: "source-unreachable",
  contentMismatch: "content-mismatch",
  unreadable: "unreadable",
} as const;
export type SourceFailureReason = (typeof SourceFailureReasonSchema)[keyof typeof SourceFailureReasonSchema];

function fact(key: string, value: string) {
  return { key, value: toSafeDisplayField(value, { maxScalars: NativeDisplayLimits.labelScalars }) };
}

function provenanceOf(diagnostic: Diagnostic): NativeProvenanceView | undefined {
  const location = diagnostic.location;
  if (location === undefined) return undefined;
  const parsed = NativeProvenanceViewSchema.safeParse({
    host: location.host,
    documentKind: location.documentKind,
    path: toSafeDisplayField(location.path, { maxScalars: NativeDisplayLimits.pathScalars }),
    ...(location.pointer === undefined
      ? {}
      : { pointer: toSafeDisplayField(location.pointer, { maxScalars: NativeDisplayLimits.pathScalars }) }),
    ...(location.line === undefined ? {} : { line: location.line }),
    ...(location.column === undefined ? {} : { column: location.column }),
  });
  return parsed.success ? parsed.data : undefined;
}

function detailField(diagnostic: Diagnostic): string | undefined {
  const details = diagnostic.details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  const field = (details as Record<string, unknown>).field;
  // Composite fields are null-separated ("locator.skill skills"); the
  // first segment is the user-meaningful part.
  return typeof field === "string" ? field.split(" ")[0] ?? undefined : undefined;
}

function targetMissing(diagnostic: Diagnostic): boolean {
  const details = diagnostic.details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return false;
  const record = details as Record<string, unknown>;
  return record.expected !== undefined && record.actual === undefined;
}

/**
 * Translate inspector failure diagnostics into native findings whose facts
 * are whitelisted presentation tokens. The umbrella `sourceInvalid` finding
 * stays first so existing consumers keep a stable blocking code; the
 * translated findings carry the actionable specifics.
 */
export function projectInspectionFailureFindings(
  diagnostics: readonly Diagnostic[],
  subjectId?: InspectionDetailId,
): NativeDiagnosticFinding[] {
  const findings: NativeDiagnosticFinding[] = [
    Object.freeze({
      key: "sourceInvalid" as const,
      ...(subjectId === undefined ? {} : { subjectId }),
    }),
  ];
  for (const diagnostic of diagnostics) {
    const provenance = provenanceOf(diagnostic);
    const shared = {
      ...(subjectId === undefined ? {} : { subjectId }),
      ...(provenance === undefined ? {} : { provenance: Object.freeze([provenance]) }),
    } as const;
    switch (diagnostic.code) {
      case ErrorCodeRegistry.claimConflict: {
        const field = detailField(diagnostic);
        findings.push(Object.freeze({
          key: "sourceDeclarationConflict" as const,
          ...shared,
          facts: Object.freeze([
            fact("reason", SourceFailureReasonSchema.fieldConflict),
            ...(field === undefined ? [] : [fact("field", field)]),
          ]),
        }));
        break;
      }
      case ErrorCodeRegistry.pathContainmentFailed: {
        findings.push(Object.freeze({
          key: "sourceContentUnsafe" as const,
          ...shared,
          facts: Object.freeze([fact("reason", targetMissing(diagnostic)
            ? SourceFailureReasonSchema.missingTarget
            : SourceFailureReasonSchema.pathEscape)]),
        }));
        break;
      }
      case ErrorCodeRegistry.sourceResolutionFailed:
        findings.push(Object.freeze({
          key: "sourceContentUnsafe" as const,
          ...shared,
          facts: Object.freeze([fact("reason", SourceFailureReasonSchema.sourceUnreachable)]),
        }));
        break;
      case ErrorCodeRegistry.contentVerificationFailed:
        findings.push(Object.freeze({
          key: "sourceContentUnsafe" as const,
          ...shared,
          facts: Object.freeze([fact("reason", SourceFailureReasonSchema.contentMismatch)]),
        }));
        break;
      case ErrorCodeRegistry.marketplaceRootInvalid:
      case ErrorCodeRegistry.manifestRootInvalid:
        findings.push(Object.freeze({
          key: "sourceDocumentInvalid" as const,
          ...shared,
          facts: Object.freeze([fact("reason", SourceFailureReasonSchema.invalidJson)]),
        }));
        break;
      case ErrorCodeRegistry.schemaInvalid:
      case ErrorCodeRegistry.entryInvalid:
      case ErrorCodeRegistry.identityInvalid:
        findings.push(Object.freeze({
          key: "sourceDocumentInvalid" as const,
          ...shared,
          facts: Object.freeze([fact("reason", SourceFailureReasonSchema.wrongShape)]),
        }));
        break;
      default:
        findings.push(Object.freeze({
          key: "sourceDocumentInvalid" as const,
          ...shared,
          facts: Object.freeze([fact("reason", SourceFailureReasonSchema.unreadable)]),
        }));
    }
  }
  return findings;
}
