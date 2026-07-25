import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  ClaimedSchema,
  ClaimConflictError,
  NativeHostSchema,
  ProvenanceSchema,
  SourceLocationSchema,
  claim,
  mergeEquivalentClaims,
  type Claimed,
  type Provenance,
} from "../../src/domain/provenance.js";
import type { JsonValue } from "../../src/domain/schema.js";

const location = (
  path: string,
  overrides: Partial<z.infer<typeof SourceLocationSchema>> = {},
) => ({
  host: "claude" as const,
  documentKind: "manifest" as const,
  path,
  ...overrides,
});

const provenance = (path: string, declaration?: JsonValue): Provenance => ({
  location: location(path),
  ...(declaration === undefined ? {} : { declaration }),
});

describe("provenance schemas", () => {
  it("accepts source-located declarations and infers claimed values", () => {
    const stringClaimSchema = ClaimedSchema(z.string());
    const value = stringClaimSchema.parse({
      value: "description",
      provenance: [provenance(".claude-plugin/plugin.json", { description: "description" })],
    });

    expect(value).toEqual({
      value: "description",
      provenance: [
        provenance(".claude-plugin/plugin.json", { description: "description" }),
      ],
    });
    expectTypeOf<z.infer<typeof stringClaimSchema>>().toMatchTypeOf<{
      value: string;
      provenance: readonly Provenance[];
    }>();
  });

  it.each([
    [{ location: { host: "claude", documentKind: "manifest", path: "" } }, "empty path"],
    [{ location: { host: "claude", documentKind: "manifest", path: "manifest", pointer: "name" } }, "pointer without slash"],
    [{ location: { host: "claude", documentKind: "manifest", path: "manifest", pointer: "/name~2value" } }, "invalid escape"],
    [{ location: { host: "claude", documentKind: "manifest", path: "manifest", pointer: "/name~" } }, "dangling escape"],
    [{ location: { host: "claude", documentKind: "manifest", path: "manifest", line: 0 } }, "non-positive line"],
    [{ location: { host: "other", documentKind: "manifest", path: "manifest" } }, "unknown host"],
    [{ location: { host: "claude", documentKind: "unknown", path: "manifest" } }, "unknown document kind"],
  ])("rejects malformed source locations (%s)", (value, _label) => {
    expect(SourceLocationSchema.safeParse(value).success).toBe(false);
  });

  it("accepts the RFC 6901 root, empty tokens, and escaped reference tokens", () => {
    for (const pointer of ["", "/", "/a~0b", "/a~1b", "/a//b", "/a~1b~0c"]) {
      expect(SourceLocationSchema.safeParse({
        host: "claude",
        documentKind: "manifest",
        path: "manifest",
        pointer,
      }).success).toBe(true);
    }
  });

  it("rejects a claimed value with no usable provenance", () => {
    const schema = ClaimedSchema(z.string());
    expect(schema.safeParse({ value: "orphan", provenance: [] }).success).toBe(false);
    expect(
      schema.safeParse({
        value: "orphan",
        provenance: [{ location: { host: "claude", documentKind: "manifest", path: "" } }],
      }).success,
    ).toBe(false);
  });

  it("derives the native host vocabulary from its schema", () => {
    expect(NativeHostSchema.safeParse("claude").success).toBe(true);
    expect(NativeHostSchema.safeParse("codex").success).toBe(true);
    expect(NativeHostSchema.safeParse("pi").success).toBe(false);
    expectTypeOf<z.infer<typeof NativeHostSchema>>().toEqualTypeOf<"claude" | "codex">();
  });
});

describe("claim merging", () => {
  it("retains both distinct provenances in first-seen order", () => {
    const left = claim("same", provenance("claude.json"));
    const right = claim("same", provenance("codex.json"));

    expect(mergeEquivalentClaims(left, right)).toEqual({
      value: "same",
      provenance: [provenance("claude.json"), provenance("codex.json")],
    });
  });

  it("deduplicates repeated source locations without losing distinct fields", () => {
    const sameLocation = location("manifest.json", { pointer: "/description" });
    const duplicateDeclaration = { value: "same" };
    const left: Claimed<string> = {
      value: "same",
      provenance: [
        { location: sameLocation, declaration: duplicateDeclaration },
        { location: location("claude.json", { pointer: "/description" }) },
      ],
    };
    const right: Claimed<string> = {
      value: "same",
      provenance: [
        { location: sameLocation, declaration: duplicateDeclaration },
        { location: location("codex.json", { pointer: "/description" }) },
      ],
    };

    const merged = mergeEquivalentClaims(left, right);
    expect(merged.provenance).toHaveLength(3);
    expect(merged.provenance.map((entry) => entry.location.path)).toEqual([
      "manifest.json",
      "claude.json",
      "codex.json",
    ]);
  });

  it("rejects unequal raw declarations at one exact source location", () => {
    const sourceLocation = location("manifest.json", { pointer: "/description" });
    const left = claim("same", { location: sourceLocation, declaration: "left" });
    const right = claim("same", { location: sourceLocation, declaration: "right" });

    expect(() => mergeEquivalentClaims(left, right)).toThrowError(ClaimConflictError);
  });

  it("supports structural equality for normalized JSON values by default", () => {
    const left = claim({ enabled: true, tags: ["one", "two"] }, provenance("a.json"));
    const right = claim({ enabled: true, tags: ["one", "two"] }, provenance("b.json"));

    expect(mergeEquivalentClaims(left, right).provenance).toHaveLength(2);
  });

  it("allows a domain-specific equivalence relation", () => {
    const left = claim("COMMAND", provenance("a.json"));
    const right = claim("command", provenance("b.json"));

    expect(
      mergeEquivalentClaims(left, right, (a, b) => a.toLowerCase() === b.toLowerCase()),
    ).toEqual({
      value: "COMMAND",
      provenance: [provenance("a.json"), provenance("b.json")],
    });
  });

  it("throws a typed conflict instead of selecting one declaration", () => {
    const left = claim("claude", provenance("claude.json"));
    const right = claim("codex", provenance("codex.json"));

    expect(() => mergeEquivalentClaims(left, right)).toThrow(ClaimConflictError);
    try {
      mergeEquivalentClaims(left, right);
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimConflictError);
      expect(error).toMatchObject({
        code: "CLAIM_CONFLICT",
        left,
        right,
      });
    }
  });

  it("fails fast when a forged claim has invalid provenance", () => {
    expect(() =>
      mergeEquivalentClaims(
        { value: "ok", provenance: [] } as unknown as Claimed<string>,
        claim("ok", provenance("valid.json")),
      ),
    ).toThrow();
  });
});
