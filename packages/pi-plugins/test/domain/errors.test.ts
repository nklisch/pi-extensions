import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  BoundaryError,
  ClaimConflictError as ErrorModuleClaimConflictError,
  DiagnosticSchema,
  DomainContractError,
  ErrorCodeRegistry,
  ErrorCodeSchema,
  FatalBoundaryCodeSchema,
  ReadResultSchema,
  diagnosticFromZodError,
  type Diagnostic,
  type ReadResult,
} from "../../src/domain/errors.js";
import { ClaimConflictError as ProvenanceClaimConflictError, claim } from "../../src/domain/provenance.js";
import { PluginKeySchema } from "../../src/domain/identity.js";

const location = {
  host: "codex" as const,
  documentKind: "marketplace" as const,
  path: ".agents/plugins/marketplace.json",
  pointer: "/plugins/0",
};

const plugin = PluginKeySchema.parse("demo@community");

describe("error and diagnostic registries", () => {
  it("derives the accepted error codes from one registry", () => {
    for (const code of Object.values(ErrorCodeRegistry)) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(ErrorCodeSchema.safeParse("NOT_A_DOMAIN_CODE").success).toBe(false);
    expect(FatalBoundaryCodeSchema.safeParse(ErrorCodeRegistry.adapterFailed).success).toBe(true);
    expect(FatalBoundaryCodeSchema.safeParse(ErrorCodeRegistry.entryInvalid).success).toBe(false);
  });

  it("keeps causes out of serializable diagnostics", () => {
    const cause = new Error("filesystem is unavailable");
    const error = new DomainContractError({
      code: ErrorCodeRegistry.entryInvalid,
      operation: "readMarketplaceEntry",
      message: "entry is malformed",
      location,
      plugin,
      details: { entryIndex: 2 },
      cause,
    });

    expect(error).toBeInstanceOf(DomainContractError);
    expect(error.cause).toBe(cause);
    expect(error.toDiagnostic()).toEqual({
      code: ErrorCodeRegistry.entryInvalid,
      severity: "error",
      operation: "readMarketplaceEntry",
      message: "entry is malformed",
      location,
      plugin,
      details: { entryIndex: 2 },
    });
    expect(JSON.stringify(error.toDiagnostic())).not.toContain("filesystem is unavailable");
    expect("cause" in error.toDiagnostic()).toBe(false);
  });

  it("restricts BoundaryError to fatal root and adapter failures", () => {
    const cause = { adapter: "git", reason: "timeout" };
    const error = new BoundaryError({
      code: ErrorCodeRegistry.sourceResolutionFailed,
      operation: "resolvePluginSource",
      message: "source resolution failed",
      cause,
    });

    expect(error).toBeInstanceOf(DomainContractError);
    expect(error).toBeInstanceOf(BoundaryError);
    expect(error.name).toBe("BoundaryError");
    expect(error.cause).toBe(cause);
    expect(() =>
      new BoundaryError({
        code: ErrorCodeRegistry.entryInvalid as never,
        operation: "readEntry",
        message: "not a root failure",
      }),
    ).toThrow();
  });

  it("integrates the existing claim conflict class into common diagnostics without a cycle", () => {
    expect(ErrorModuleClaimConflictError).toBe(ProvenanceClaimConflictError);
    const left = claim("claude", { location });
    const right = claim("codex", { location: { ...location, path: "codex.json" } });
    const conflict = new ProvenanceClaimConflictError(left, right);
    expect(conflict).toBeInstanceOf(DomainContractError);
    expect(conflict.toDiagnostic()).toMatchObject({
      code: ErrorCodeRegistry.claimConflict,
      severity: "error",
      details: { left: { value: "claude" }, right: { value: "codex" } },
    });
    expect(conflict.left).toEqual(left);
    expect(conflict.right).toEqual(right);
  });
});

describe("recoverable diagnostics", () => {
  it("converts Zod failures to stable source-located diagnostics", () => {
    const parsed = z.object({ name: z.string().min(1) }).safeParse({ name: "" });
    if (parsed.success) {
      throw new Error("fixture should fail");
    }

    const first = diagnosticFromZodError(parsed.error, {
      operation: "readMarketplaceEntry",
      location,
      plugin,
    });
    const second = diagnosticFromZodError(parsed.error, {
      operation: "readMarketplaceEntry",
      location,
      plugin,
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      code: ErrorCodeRegistry.schemaInvalid,
      severity: "error",
      operation: "readMarketplaceEntry",
      location,
      plugin,
    });
    expect(first.details).toMatchObject({
      issues: [{ code: "too_small", path: ["name"] }],
    });
    expect(JSON.stringify(first)).not.toContain("cause");
  });

  it("rejects unknown diagnostic codes at the serialization boundary", () => {
    expect(
      DiagnosticSchema.safeParse({
        code: "UNKNOWN_CODE",
        severity: "error",
        operation: "read",
        message: "bad input",
      }).success,
    ).toBe(false);
  });
});

describe("partial read result schemas", () => {
  const valueSchema = z.object({ id: z.string() });
  const readResultSchema = ReadResultSchema(valueSchema);

  it("preserves valid values and warnings", () => {
    const warning: Diagnostic = {
      code: ErrorCodeRegistry.unsupportedDeclaration,
      severity: "warning",
      operation: "readEntry",
      message: "unknown metadata retained",
    };
    const result = readResultSchema.parse({
      ok: true,
      value: { id: "one" },
      diagnostics: [warning],
    });

    expect(result).toEqual({
      ok: true,
      value: { id: "one" },
      diagnostics: [warning],
    });
  });

  it("enforces warning-only success and at least one error on failure", () => {
    expect(
      readResultSchema.safeParse({
        ok: true,
        value: { id: "one" },
        diagnostics: [{
          code: ErrorCodeRegistry.entryInvalid,
          severity: "error",
          operation: "readEntry",
          message: "contradictory success diagnostic",
        }],
      }).success,
    ).toBe(false);
    expect(
      readResultSchema.safeParse({
        ok: false,
        diagnostics: [{
          code: ErrorCodeRegistry.unsupportedDeclaration,
          severity: "warning",
          operation: "readEntry",
          message: "warning is not a failure explanation",
        }],
      }).success,
    ).toBe(false);
    expect(
      readResultSchema.safeParse({
        ok: false,
        diagnostics: [{
          code: ErrorCodeRegistry.entryInvalid,
          severity: "error",
          operation: "readEntry",
          message: "invalid entry",
        }],
      }).success,
    ).toBe(true);

    type Result = ReadResult<{ id: string }>;
    expectTypeOf<Result>().toMatchTypeOf<{
      readonly ok: boolean;
      readonly diagnostics: readonly Diagnostic[];
    }>();
    expectTypeOf<z.infer<typeof readResultSchema>>().toMatchTypeOf<{
      readonly ok: boolean;
      readonly diagnostics: readonly Diagnostic[];
    }>();
  });
});
