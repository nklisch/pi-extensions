import { compareUtf8 } from "../domain/canonical-json.js";
import type { Sha256 } from "../domain/source.js";
import {
  NativeDiagnosticFactSchema,
  NativeDiagnosticSchema,
  NativeProvenanceViewSchema,
  type NativeDiagnostic,
  type NativeInspectionCondition,
} from "./native-inspection-contract.js";
import {
  NativeDiagnosticRegistry,
  type NativeDiagnosticRegistryKey,
} from "./native-diagnostic-registry.js";
import { NativeDisplayLimits, toSafeDisplayField } from "./native-inspection-display.js";

const encoder = new TextEncoder();

export type NativeDiagnosticFinding = Readonly<{
  key: NativeDiagnosticRegistryKey;
  subjectId?: import("./native-inspection-contract.js").InspectionDetailId;
  componentId?: import("../domain/components.js").ComponentId;
  facts?: readonly import("./native-inspection-contract.js").NativeDiagnostic["facts"][number][];
  provenance?: readonly import("./native-inspection-contract.js").NativeProvenanceView[];
}>;

export type NativeDiagnosticInput = Readonly<{
  findings: readonly NativeDiagnosticFinding[];
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("diagnostic identity is not serializable");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function digest(value: unknown, sha256: Sha256): string {
  const bytes = sha256(encoder.encode(`native-diagnostic-v1\0${canonical(value)}`));
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) throw new Error("SHA-256 function must return exactly 32 bytes");
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedFinding(finding: NativeDiagnosticFinding) {
  const definition = NativeDiagnosticRegistry[finding.key];
  if (definition === undefined) throw new TypeError("unknown native diagnostic registry key");
  const facts = (finding.facts ?? []).map((fact) => NativeDiagnosticFactSchema.parse(fact))
    .sort((left, right) => compareUtf8(left.key, right.key) || compareUtf8(canonical(left.value), canonical(right.value)));
  const provenance = (finding.provenance ?? []).map((value) => NativeProvenanceViewSchema.parse(value))
    .sort((left, right) => compareUtf8(canonical(left), canonical(right)));
  const identity = {
    code: definition.code,
    ...(finding.subjectId === undefined ? {} : { subjectId: finding.subjectId }),
    ...(finding.componentId === undefined ? {} : { componentId: finding.componentId }),
    facts,
    provenance,
  };
  return { definition, finding, facts, provenance, identity, canonicalIdentity: canonical(identity) };
}

/** Compile only registry-selected, schema-whitelisted evidence. */
export function compileNativeDiagnostics(input: NativeDiagnosticInput, sha256: Sha256): readonly NativeDiagnostic[] {
  if (input === null || typeof input !== "object" || !Array.isArray(input.findings)) throw new TypeError("native diagnostic findings are required");
  const unique = new Map<string, ReturnType<typeof normalizedFinding>>();
  for (const finding of input.findings) {
    const normalized = normalizedFinding(finding);
    unique.set(normalized.canonicalIdentity, normalized);
  }
  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  const ordered = [...unique.values()].sort((left, right) =>
    left.definition.rank - right.definition.rank ||
    severityRank[left.definition.severity] - severityRank[right.definition.severity] ||
    compareUtf8(left.finding.subjectId ?? "", right.finding.subjectId ?? "") ||
    compareUtf8(left.finding.componentId ?? "", right.finding.componentId ?? "") ||
    compareUtf8(left.definition.code, right.definition.code) ||
    compareUtf8(left.canonicalIdentity, right.canonicalIdentity));
  return Object.freeze(ordered.map(({ definition, finding, facts, provenance, identity }) => NativeDiagnosticSchema.parse({
    id: `native-diagnostic-v1:sha256:${digest(identity, sha256)}`,
    code: definition.code,
    category: definition.category,
    severity: definition.severity,
    ...(finding.subjectId === undefined ? {} : { subjectId: finding.subjectId }),
    ...(finding.componentId === undefined ? {} : { componentId: finding.componentId }),
    summary: toSafeDisplayField(definition.summary, { maxScalars: NativeDisplayLimits.descriptionScalars }),
    facts,
    provenance,
    action: definition.action,
  })));
}

export function deriveNativeInspectionCondition(diagnostics: readonly NativeDiagnostic[]): NativeInspectionCondition {
  const definitions = new Map(Object.values(NativeDiagnosticRegistry).map((entry) => [entry.code, entry]));
  if (diagnostics.some((diagnostic) => definitions.get(diagnostic.code)?.blocks === true)) return "blocked";
  if (diagnostics.some((diagnostic) => definitions.get(diagnostic.code)?.unavailable === true)) return "unavailable";
  if (diagnostics.some((diagnostic) => diagnostic.severity === "warning")) return "degraded";
  return "ready";
}

export function countNativeDiagnostics(diagnostics: readonly NativeDiagnostic[]) {
  return Object.freeze({
    error: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warning: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    info: diagnostics.filter((diagnostic) => diagnostic.severity === "info").length,
  });
}

/** Fixed subsystem labels only; native messages and causes never enter facts. */
export function unavailableEvidenceFinding(
  subsystem: "state" | "catalog" | "capability" | "runtime" | "source" | "configuration" | "trust" | "adoption",
  subjectId?: NativeDiagnosticFinding["subjectId"],
): NativeDiagnosticFinding {
  return Object.freeze({
    key: "evidenceUnavailable",
    ...(subjectId === undefined ? {} : { subjectId }),
    facts: Object.freeze([NativeDiagnosticFactSchema.parse({
      key: "subsystem",
      value: toSafeDisplayField(subsystem, { maxScalars: NativeDisplayLimits.labelScalars }),
    })]),
  });
}
