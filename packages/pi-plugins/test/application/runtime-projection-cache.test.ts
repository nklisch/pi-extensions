import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeRuntimeProjectionCache, encodeRuntimeProjectionCache } from "../../src/application/runtime-projection-cache.js";
import {
  createActiveProjectionExpectation,
  createPluginRuntimeProjection,
} from "../../src/application/ports/runtime-projection.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

function fixture() {
  const source = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: "a".repeat(40), path: "./plugin" }, sha256);
  const plugin = NormalizedPluginSchema.parse({
    identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" },
    source,
    configuration: { options: [] },
    components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
    metadata: [],
  });
  const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
  const content = createContentManifest([], sha256);
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope: { kind: "user" } }, sha256);
  return createPluginRuntimeProjection({ scope: { kind: "user" }, plugin, compatibility, revision, sha256 });
}

describe("runtime projection cache codec", () => {
  it("round-trips one complete canonical descriptor and keeps payload integrity separate", () => {
    const projection = fixture();
    const encoded = encodeRuntimeProjectionCache(projection, sha256);
    const expectation = createActiveProjectionExpectation(projection, sha256);
    const decoded = decodeRuntimeProjectionCache(encoded.bytes, expectation, sha256);

    expect(decoded.projection).toEqual(projection);
    expect(decoded.expectation).toEqual(expectation);
    expect(decoded.payloadDigest).toBe(encoded.payloadDigest);
    expect(decoded.payloadDigest).not.toBe(projection.digest);
  });

  it("rejects noncanonical bytes and expected-identity mismatches", () => {
    const projection = fixture();
    const encoded = encodeRuntimeProjectionCache(projection, sha256);
    const expectation = createActiveProjectionExpectation(projection, sha256);
    const parsed = JSON.parse(new TextDecoder().decode(encoded.bytes)) as Record<string, unknown>;
    const noncanonical = new TextEncoder().encode(`${JSON.stringify(parsed)}\n`);
    expect(() => decodeRuntimeProjectionCache(noncanonical, expectation, sha256)).toThrow();
    const other = { ...projection, revision: `sha256:${"f".repeat(64)}` };
    expect(() => decodeRuntimeProjectionCache(encoded.bytes, createActiveProjectionExpectation(projection, sha256), sha256)).not.toThrow();
    expect(() => encodeRuntimeProjectionCache(other as typeof projection, sha256)).toThrow();
  });
});