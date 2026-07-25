import type { NativeDiagnostic, NativeProvenanceView, SafeDisplayField } from "./native-inspection-contract.js";
import { NativeDisplayLimits, toSafeDisplayField } from "./native-inspection-display.js";

/**
 * User-facing failure text. Everything here speaks in marketplace/plugin
 * terms — Claude and Codex documents, skills, hooks, MCP servers — never in
 * implementation vocabulary (claim conflicts, provenance, digests).
 */

function safe(value: string): SafeDisplayField {
  return toSafeDisplayField(value, { maxScalars: NativeDisplayLimits.descriptionScalars });
}

function factValue(diagnostic: NativeDiagnostic, key: string): string | undefined {
  const fact = diagnostic.facts.find((candidate) => candidate.key === key);
  return fact?.value.text;
}

function documentLabel(provenance: NativeProvenanceView | undefined): string | undefined {
  if (provenance === undefined) return undefined;
  const host = provenance.host === "claude" ? "Claude" : "Codex";
  return `\`${provenance.path.text}\` (${host})`;
}

function reasonSentence(reason: string | undefined): string {
  switch (reason) {
    case "invalid-json": return "isn't valid JSON";
    case "wrong-shape": return "doesn't match the expected format for that file";
    case "missing-target": return "points at a file or directory that isn't in the plugin";
    case "path-escape": return "points outside the plugin's own directory, which isn't allowed";
    case "field-conflict": return "";
    case "source-unreachable": return "couldn't be fetched or resolved";
    case "content-mismatch": return "doesn't match its expected content hash";
    default: return "couldn't be read";
  }
}

function fieldLabel(field: string | undefined): string {
  if (field === undefined) return "the same setting";
  const friendly: Record<string, string> = {
    description: "the plugin description",
    version: "the plugin version",
    name: "the plugin name",
    "policy.availability": "the installation policy",
    "policy.authentication": "the authentication policy",
  };
  return friendly[field] ?? `\`${field}\``;
}

function lineFor(diagnostic: NativeDiagnostic): string | undefined {
  const first = diagnostic.provenance[0];
  const second = diagnostic.provenance[1];
  const document = documentLabel(first);
  switch (diagnostic.code) {
    case "SOURCE_DOCUMENT_INVALID": {
      const reason = reasonSentence(factValue(diagnostic, "reason"));
      return document === undefined
        ? `A plugin document ${reason}.`
        : `${document} ${reason}.`;
    }
    case "SOURCE_DECLARATION_CONFLICT": {
      const field = fieldLabel(factValue(diagnostic, "field"));
      const left = documentLabel(first);
      const right = documentLabel(second);
      if (left !== undefined && right !== undefined && left !== right) {
        return `${left} and ${right} disagree about ${field}.`;
      }
      return left === undefined
        ? `Two plugin declarations disagree about ${field}.`
        : `${left} disagrees with another declaration about ${field}.`;
    }
    case "SOURCE_CONTENT_UNSAFE": {
      const reason = reasonSentence(factValue(diagnostic, "reason"));
      return document === undefined
        ? `The plugin source ${reason}.`
        : `${document} ${reason}.`;
    }
    case "SOURCE_INVALID":
      // Umbrella code: specifics (if any) render their own lines.
      return undefined;
    case "SOURCE_UNAVAILABLE":
      return "The plugin's content isn't available right now; retry in a moment.";
    case "COMPATIBILITY_INCOMPATIBLE":
      // Fires for unsupported declarations AND for capabilities missing from
      // this session; the requirement lines carry the specifics.
      return "Something this plugin declares can't run in this pi session.";
    case "RUNTIME_REQUIREMENT_UNAVAILABLE":
      return "A capability this plugin needs isn't available in this pi session.";
    case "TRUST_REQUIRED":
      return "This exact plugin revision needs your trust approval first.";
    case "TRUST_REVOKED":
      return "Trust for this exact plugin revision was revoked.";
    case "CONFIGURATION_REQUIRED":
      return "This plugin needs configuration values before it can run.";
    case "PROJECT_UNTRUSTED":
      return "This project isn't trusted, so project-scope changes are refused.";
    case "CATALOG_UNAVAILABLE":
      return "The marketplace catalog isn't available; refresh the marketplace and retry.";
    case "CATALOG_STALE":
      return "The marketplace catalog is stale; refresh the marketplace and retry.";
    case "CATALOG_CORRUPT":
      return "The marketplace catalog is corrupt; remove and re-add the marketplace.";
    case "CANDIDATE_MISSING":
      return "That plugin is no longer in the marketplace; refresh and browse again.";
    case "RECOVERY_REQUIRED":
    case "TRANSITION_PENDING":
    case "RECOVERY_BLOCKED":
      return "A previous install or update didn't finish; it will settle on recovery (usually automatic when pi restarts).";
    default:
      return undefined;
  }
}

/**
 * Compose plain-language lines for the diagnostics a user must see. Blocking
 * errors first; the umbrella SOURCE_INVALID code is skipped whenever more
 * specific lines exist.
 */
export function presentNativeDiagnostics(diagnostics: readonly NativeDiagnostic[]): readonly SafeDisplayField[] {
  const lines: string[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "error") continue;
    const line = lineFor(diagnostic);
    if (line !== undefined && !lines.includes(line)) lines.push(line);
  }
  if (lines.length === 0 && diagnostics.some((diagnostic) => diagnostic.code === "SOURCE_INVALID")) {
    lines.push("The plugin couldn't be read; inspect its source for details.");
  }
  return Object.freeze(lines.map((line) => safe(line)));
}

/**
 * Text for results that landed in recovery-required: the work completed far
 * enough to keep, but activation must be finished by the recovery pass.
 */
export function presentRecoveryRequired(): SafeDisplayField {
  return safe("The plugin is installed, but activation didn't finish in this session; the plugin host finishes it on recovery (usually automatic when pi restarts). `/plugin doctor` shows details.");
}

/** Human text for control-level failure codes that carry no detail context. */
export function presentControlFailure(code: string): SafeDisplayField | undefined {
  switch (code) {
    case "CONTROL_TARGET_SELECTION_FAILED":
      // Selection fails for any lifecycle action (add/update/enable/remove),
      // so the text must not name install specifically.
      return safe("That couldn't start — the plugin's current details couldn't be loaded. Refresh and try again.");
    case "CONTROL_SELECTION_UNAVAILABLE":
      return safe("That plugin can't be inspected right now; refresh the marketplace and retry.");
    case "CONTROL_READINESS_BLOCKED":
      return safe("The plugin host isn't ready yet; retry in a moment.");
    case "CONTROL_REQUEST_INVALID":
      return safe("That command didn't parse; plugins are named `<name>@<marketplace>` (for example `agile-workflow@nklisch-skills`).");
    case "CONFIRMATION_REQUIRED":
      return safe("That action needs confirmation.");
    default:
      return undefined;
  }
}
