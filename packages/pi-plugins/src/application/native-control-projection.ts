import type { JsonValue } from "../domain/schema.js";
import { toSafeDisplayField } from "./native-inspection-display.js";
import type { SafeDisplayField } from "./native-inspection-contract.js";
import type {
  NativeControlDiagnostic,
  NativeControlExit,
  NativeControlOperationHandle,
  NativeControlStatus,
} from "./native-control-contract.js";
import { NativeControlCommandRegistry, type NativeControlCommandId } from "./native-control-registry.js";
import { projectNativeControlSchemaJson } from "./native-control-redaction.js";
import { presentControlFailure, presentNativeDiagnostics } from "./native-failure-presenter.js";
import type { NativeDiagnostic } from "./native-inspection-contract.js";

export type NativeControlDispatchResult = Readonly<{
  status: NativeControlStatus;
  data?: JsonValue;
  operation?: NativeControlOperationHandle;
  page?: Readonly<{ next?: string }>;
  exitOverride?: NativeControlExit;
  diagnostics: readonly NativeControlDiagnostic[];
  human: readonly SafeDisplayField[];
}>;

export function controlDiagnostic(
  code: string,
  severity: NativeControlDiagnostic["severity"],
  action: NativeControlDiagnostic["action"],
): NativeControlDiagnostic {
  return Object.freeze({ code, severity, action });
}

/** Validate through the owner schema before crossing the redaction boundary. */
export function projectNativeControlResponse(
  command: NativeControlCommandId,
  result: unknown,
  input: Readonly<{
    status?: NativeControlStatus;
    operation?: NativeControlOperationHandle;
    next?: string;
    diagnostics?: readonly NativeControlDiagnostic[];
    human?: readonly SafeDisplayField[];
  }> = {},
): NativeControlDispatchResult {
  const definition = NativeControlCommandRegistry[command];
  const owner = definition.response.parse(result);
  const projected = definition.projectResponse === undefined
    ? projectNativeControlSchemaJson(owner)
    : definition.projectResponse(owner);
  // Projection is a second real boundary. Reparse the emitted shape so a
  // redaction transform cannot silently remove required fields or change a
  // source/path field into a different contract.
  const safeResponse = definition.projectedResponse.parse(projected);
  const jsonResponse = projectNativeControlSchemaJson(safeResponse);
  const reparsedResponse = definition.projectedResponse.parse(jsonResponse);
  return Object.freeze({
    status: input.status ?? "ok",
    data: projectNativeControlSchemaJson(reparsedResponse),
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.next === undefined ? {} : { page: Object.freeze({ next: input.next }) }),
    diagnostics: Object.freeze([...(input.diagnostics ?? [])]),
    human: Object.freeze([...(input.human ?? [toSafeDisplayField(NativeControlCommandRegistry[command].summary.text, { maxScalars: 256 })])]),
  });
}

export function projectNativeControlFailure(
  status: NativeControlStatus,
  code: string,
  action: NativeControlDiagnostic["action"],
  human?: readonly SafeDisplayField[],
): NativeControlDispatchResult {
  // Every failure envelope carries user-facing text: callers may pass richer
  // lines composed from the underlying inspection diagnostics; otherwise the
  // presenter maps the control code to plain marketplace/plugin language.
  // Raw error context is deliberately never promoted into the envelope.
  const fallback = presentControlFailure(code);
  const lines = human ?? (fallback === undefined ? [] : [fallback]);
  return Object.freeze({
    status,
    diagnostics: Object.freeze([controlDiagnostic(code, "error", action)]),
    human: Object.freeze([...lines]),
  });
}

/**
 * Human lines for a selection failure: the underlying inspection diagnostics
 * (document, host, reason) when the target existed but couldn't be prepared.
 */
export function humanForSelectionFailure(
  failure: Readonly<{ diagnostics?: readonly NativeDiagnostic[] }>,
): readonly SafeDisplayField[] | undefined {
  if (failure.diagnostics === undefined) return undefined;
  const lines = presentNativeDiagnostics(failure.diagnostics);
  return lines.length > 0 ? lines : undefined;
}
