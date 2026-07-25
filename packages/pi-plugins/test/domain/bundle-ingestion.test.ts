import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  ComponentLocatorClaimSchema,
  ComponentLocatorTargetSchema,
  ForeignComponentDeclarationSchema,
  PluginManifestClaimsSchema,
  type ComponentLocatorClaim,
  type ForeignComponentDeclaration,
} from "../../src/domain/bundle-ingestion.js";
import { claim, type Provenance } from "../../src/domain/provenance.js";

const manifest: Provenance = {
  location: {
    host: "claude",
    documentKind: "manifest",
    path: ".claude-plugin/plugin.json",
    pointer: "/components/0",
  },
};

const locator = {
  nativeHost: "claude" as const,
  componentKind: "skill" as const,
  authority: "authoritative" as const,
  source: "manifest" as const,
  target: { kind: "directory" as const, path: "./skills/demo" },
  provenance: [manifest],
};

describe("bundle-ingestion contracts", () => {
  it("derives locator and declaration types from strict schemas", () => {
    expect(ComponentLocatorTargetSchema.parse(locator.target)).toEqual(locator.target);
    expect(ComponentLocatorClaimSchema.parse(locator)).toEqual(locator);
    expectTypeOf<z.infer<typeof ComponentLocatorClaimSchema>>().toEqualTypeOf<ComponentLocatorClaim>();

    const declaration: ForeignComponentDeclaration = {
      nativeHost: "codex",
      nativeKind: claim("apps", manifest),
      declarationSubkey: "key:remote",
      declaration: claim({ name: "remote" }, manifest),
    };
    expect(ForeignComponentDeclarationSchema.parse(declaration)).toEqual(declaration);
    expectTypeOf<z.infer<typeof ForeignComponentDeclarationSchema>>().toEqualTypeOf<ForeignComponentDeclaration>();
  });

  it("retains normalized manifest claims without assigning compatibility", () => {
    const result = PluginManifestClaimsSchema.parse({
      nativeHost: "claude",
      document: manifest,
      name: claim("demo", manifest),
      locators: [locator],
      configuration: [],
      foreign: [],
      metadata: [],
    });
    expect(result.nativeHost).toBe("claude");
    expect(result.foreign).toEqual([]);
    expect(result).not.toHaveProperty("verdict");
    expect(result).not.toHaveProperty("activatable");
  });

  it("rejects malformed and contradictory locator authority", () => {
    expect(ComponentLocatorClaimSchema.safeParse({
      ...locator,
      authority: "conventional",
    }).success).toBe(false);
    expect(ComponentLocatorClaimSchema.safeParse({
      ...locator,
      source: "convention",
      authority: "authoritative",
    }).success).toBe(false);
    expect(ComponentLocatorClaimSchema.safeParse({
      ...locator,
      target: { kind: "file", path: "" },
    }).success).toBe(false);
    expect(ForeignComponentDeclarationSchema.safeParse({
      nativeHost: "codex",
      nativeKind: claim("apps", manifest),
      declarationSubkey: "",
      declaration: claim({}, manifest),
    }).success).toBe(false);
  });
});
