import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveEffectiveUpdatePolicy } from "../../src/application/update-policy-resolution.js";
import {
  createMarketplaceConfigurationRecord,
  deriveMarketplaceSourceIdentity,
  derivePluginSourceIdentity,
} from "../../src/domain/update-policy.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const source = { kind: "github" as const, repository: "example/community" };
const pluginSource = { kind: "git" as const, url: "https://example.com/demo.git" };
const marketplaceIdentity = deriveMarketplaceSourceIdentity(source, sha256);
const pluginIdentity = derivePluginSourceIdentity(pluginSource, sha256);

function resolve(overrides: Record<string, unknown> = {}) {
  const record = createMarketplaceConfigurationRecord({ marketplace: "community", source, applicationOverride: "automatic" });
  return resolveEffectiveUpdatePolicy({
    plugin: "demo@community",
    record: { ...record, pluginOverrides: [{ plugin: "demo@community", sourceIdentity: pluginIdentity, mode: "manual" }] },
    global: "automatic",
    scope: "automatic",
    marketplaceSourceIdentity: marketplaceIdentity,
    registeredMarketplaceSourceIdentity: marketplaceIdentity,
    pluginSourceIdentity: pluginIdentity,
    ...overrides,
  } as any);
}

describe("effective update policy resolution", () => {
  it("uses exact plugin then marketplace then scope then global precedence", () => {
    expect(resolve()).toMatchObject({ application: "manual", winningLevel: "plugin" });
    expect(resolve({ record: createMarketplaceConfigurationRecord({ marketplace: "community", source, applicationOverride: "automatic" }) })).toMatchObject({ application: "automatic", winningLevel: "marketplace" });
    expect(resolve({ record: createMarketplaceConfigurationRecord({ marketplace: "community", source }), scope: "automatic" })).toMatchObject({ application: "automatic", winningLevel: "scope" });
    expect(resolve({ record: createMarketplaceConfigurationRecord({ marketplace: "community", source }), scope: undefined, global: "automatic" })).toMatchObject({ application: "automatic", winningLevel: "global" });
  });

  it("hard-falls to manual for local, changed, and legacy source authority", () => {
    expect(resolve({ record: createMarketplaceConfigurationRecord({ marketplace: "community", source: { kind: "local-git", path: "/tmp/community" } }) })).toMatchObject({ application: "manual", winningLevel: "guard", sourceGuard: "local" });
    expect(resolve({ registeredMarketplaceSourceIdentity: deriveMarketplaceSourceIdentity({ kind: "github", repository: "other/community" }, sha256) })).toMatchObject({ sourceGuard: "marketplace-source-changed" });
    expect(resolve({ pluginSourceIdentity: "legacy-unavailable" })).toMatchObject({ sourceGuard: "legacy-source" });
    expect(resolve({ pluginSourceIdentity: derivePluginSourceIdentity({ kind: "git", url: "https://example.com/moved.git" }, sha256) })).toMatchObject({ sourceGuard: "plugin-source-changed" });
  });
});
