import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createForeignComponent,
  createForeignComponentDeclaration,
} from "../../src/formats/foreign-declaration.js";
import { deriveComponentId } from "../../src/domain/component-identity.js";
import type { Provenance } from "../../src/domain/provenance.js";
import { PluginKeySchema } from "../../src/domain/identity.js";

const provenance: Provenance = {
  location: {
    host: "codex",
    documentKind: "manifest",
    path: ".codex-plugin/plugin.json",
    pointer: "/apps/remote",
  },
};
const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

describe("foreign declaration construction", () => {
  it("validates and preserves raw JSON plus every provenance claim", () => {
    const result = createForeignComponentDeclaration({
      nativeHost: "codex",
      nativeKind: "apps",
      declarationSubkey: "key:remote",
      declaration: { remote: true, capabilities: ["search"] },
      provenance: [provenance, { ...provenance, location: { ...provenance.location, host: "claude" } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.declaration.value).toEqual({ remote: true, capabilities: ["search"] });
    expect(result.value.declaration.provenance).toHaveLength(2);
    expect(result.value).not.toHaveProperty("verdict");
    expect(result.value).not.toHaveProperty("requirement");
    expect(result.value).not.toHaveProperty("activatable");

    const plugin = PluginKeySchema.parse("demo@catalog");
    const component = createForeignComponent(result.value, plugin);
    expect(component.ok).toBe(true);
    if (!component.ok) return;
    expect(component.value).toMatchObject({ kind: "foreign", nativeHost: "codex" });
    expect(component.value.id).toBe(deriveComponentId(plugin, {
      kind: "foreign",
      nativeHost: "codex",
      nativeKind: "apps",
      declarationSubkey: "key:remote",
    }, sha256));
  });

  it("fails closed on malformed raw declarations and identity", () => {
    expect(createForeignComponentDeclaration({
      nativeHost: "codex",
      nativeKind: "",
      declarationSubkey: "key:remote",
      declaration: { remote: true },
      provenance,
    }).ok).toBe(false);
    expect(createForeignComponentDeclaration({
      nativeHost: "codex",
      nativeKind: "apps",
      declarationSubkey: "key:remote",
      declaration: undefined,
      provenance,
    }).ok).toBe(false);
    expect(createForeignComponentDeclaration({
      nativeHost: "codex",
      nativeKind: "apps",
      declarationSubkey: "key:remote",
      declaration: { remote: true },
      provenance: [],
    }).ok).toBe(false);
  });
});
