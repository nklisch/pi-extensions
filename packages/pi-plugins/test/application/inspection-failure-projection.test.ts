import { describe, expect, it } from "vitest";
import { projectInspectionFailureFindings } from "../../src/application/inspection-failure-projection.js";
import { presentNativeDiagnostics, presentControlFailure } from "../../src/application/native-failure-presenter.js";
import { compileNativeDiagnostics } from "../../src/application/native-diagnostic-compiler.js";
import { createHash } from "node:crypto";
import type { Diagnostic } from "../../src/domain/errors.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

function diagnostic(code: string, location?: { host: "claude" | "codex"; documentKind: "manifest"; path: string; pointer?: string }, details?: unknown): Diagnostic {
  return {
    code,
    severity: "error",
    operation: "test",
    message: "internal message that must never leak",
    ...(location === undefined ? {} : { location }),
    ...(details === undefined ? {} : { details }),
  } as Diagnostic;
}

describe("inspection failure projection", () => {
  it("keeps the umbrella sourceInvalid first and maps claim conflicts to conflict findings with whitelisted facts", () => {
    const findings = projectInspectionFailureFindings([
      diagnostic("CLAIM_CONFLICT", { host: "claude", documentKind: "manifest", path: ".claude-plugin/plugin.json", pointer: "/description" }, { field: "description" }),
    ]);
    expect(findings[0]?.key).toBe("sourceInvalid");
    const conflict = findings[1];
    expect(conflict?.key).toBe("sourceDeclarationConflict");
    expect(conflict?.facts?.map((entry) => [entry.key, entry.value.text])).toEqual([
      ["reason", "field-conflict"],
      ["field", "description"],
    ]);
    expect(conflict?.provenance?.[0]?.path.text).toBe(".claude-plugin/plugin.json");
    expect(JSON.stringify(findings)).not.toContain("internal message that must never leak");
  });

  it("distinguishes missing targets from path escapes using declaration details", () => {
    const [missing] = projectInspectionFailureFindings([
      diagnostic("PATH_CONTAINMENT_FAILED", undefined, { path: "./skills", expected: "directory" }),
    ]).filter((finding) => finding.key === "sourceContentUnsafe");
    expect(missing?.facts?.[0]?.value.text).toBe("missing-target");
    const [escape] = projectInspectionFailureFindings([
      diagnostic("PATH_CONTAINMENT_FAILED", undefined, { path: "../outside", expected: "directory", actual: "file" }),
    ]).filter((finding) => finding.key === "sourceContentUnsafe");
    expect(escape?.facts?.[0]?.value.text).toBe("path-escape");
  });

  it("maps root-document failures to invalid-json and schema failures to wrong-shape", () => {
    const findings = projectInspectionFailureFindings([
      diagnostic("MANIFEST_ROOT_INVALID"),
      diagnostic("SCHEMA_INVALID"),
    ]);
    const reasons = findings.filter((finding) => finding.key === "sourceDocumentInvalid")
      .map((finding) => finding.facts?.[0]?.value.text);
    expect(reasons).toEqual(["invalid-json", "wrong-shape"]);
  });
});

describe("native failure presenter", () => {
  it("composes plain-language lines in host document terms and skips the umbrella code", () => {
    const compiled = compileNativeDiagnostics({
      findings: projectInspectionFailureFindings([
        diagnostic("CLAIM_CONFLICT", { host: "claude", documentKind: "manifest", path: ".claude-plugin/plugin.json", pointer: "/description" }, { field: "description" }),
      ]),
    }, sha256);
    const lines = presentNativeDiagnostics(compiled).map((line) => line.text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(".claude-plugin/plugin.json");
    expect(lines[0]).toContain("Claude");
    expect(lines[0]).toContain("plugin description");
    expect(lines[0]).not.toContain("CLAIM_CONFLICT");
    expect(lines[0]).not.toContain("sourceInvalid");
  });

  it("falls back to a plain umbrella sentence when no specific finding exists", () => {
    const compiled = compileNativeDiagnostics({
      findings: [{ key: "sourceInvalid" }],
    }, sha256);
    const lines = presentNativeDiagnostics(compiled).map((line) => line.text);
    expect(lines).toEqual(["The plugin couldn't be read; inspect its source for details."]);
  });

  it("maps control failure codes to marketplace/plugin language", () => {
    expect(presentControlFailure("CONTROL_REQUEST_INVALID")?.text).toContain("@<marketplace>");
    expect(presentControlFailure("CONTROL_TARGET_SELECTION_FAILED")?.text).not.toContain("CONTROL_");
  });
});
