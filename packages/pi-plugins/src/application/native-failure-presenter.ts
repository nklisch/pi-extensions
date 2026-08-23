import type { NativeDiagnostic, NativeProvenanceView, SafeDisplayField } from "./native-inspection-contract.js";
import { NativeDisplayLimits, toSafeDisplayField } from "./native-inspection-display.js";
import type { MarketplaceAddRejectionCode } from "./marketplace-management-contract.js";

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
    case "PLUGIN_DEGRADED":
      return "This plugin is degraded; repair it or roll back to its previous revision.";
    case "PLUGIN_FALLBACK_ACTIVE":
      return "This plugin is running its previous revision; repair the selected revision or keep this fallback with rollback.";
    case "CONVERGENCE_BLOCKED":
      return "Startup convergence could not finish; inspect the plugin host and retry repair.";
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

/** Actionable human text for a rejected marketplace registration. */
export function presentMarketplaceAddFailure(code: MarketplaceAddRejectionCode): SafeDisplayField {
  switch (code) {
    case "INVALID_SOURCE":
      return safe("That repository address isn't valid. For GitHub, use `owner/repository`; for a Git URL, use the complete `https://…` or `ssh://…` address.");
    case "PROJECT_UNTRUSTED":
      return safe("This project isn't trusted, so it can't register a project marketplace. Trust the project or add the marketplace globally.");
    case "NOT_PORTABLE":
      return safe("A local checkout can't be registered for a project because other machines couldn't resolve it. Use a GitHub repository or Git URL instead.");
    case "NAME_CONFLICT":
      return safe("This catalog uses the same marketplace name as a different configured source. Remove the existing marketplace or give one catalog a distinct name.");
    case "SOURCE_NAME_CHANGED":
      return safe("This repository now declares a different marketplace name. Remove its existing registration, then add it again.");
    case "SOURCE_UNAVAILABLE":
      return safe("The repository couldn't be fetched or resolved. Check that it exists, that this machine can access it, and that private-repository credentials are available.");
    case "CATALOG_INVALID":
      return safe("The repository was fetched, but its marketplace catalog is missing, invalid, or internally conflicting. Check `.claude-plugin/marketplace.json` or `.agents/plugins/marketplace.json`.");
    case "PROMOTION_FAILED":
      return safe("The catalog was fetched, but pi couldn't save its verified content locally. Check the plugin-host storage permissions and available disk space, then retry.");
    case "STATE_CORRUPT":
      return safe("The plugin host's marketplace state couldn't be read safely. Run `/plugins doctor` before retrying.");
    case "STATE_STALE":
      return safe("Marketplace state changed while the source was being added. Refresh and retry.");
  }
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
