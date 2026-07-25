import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createContentManifest, hashContent } from "../../src/domain/content-manifest.js";
import { claim } from "../../src/domain/provenance.js";
import { MarketplaceReadResultSchema } from "../../src/domain/marketplace.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { createMarketplaceInspectionService } from "../../src/application/marketplace-inspection-service.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const provenance = { location: { host: "claude" as const, documentKind: "marketplace" as const, path: ".claude-plugin/marketplace.json", pointer: "" } };
const catalog = MarketplaceReadResultSchema.parse({
  marketplace: {
    name: claim("community", provenance),
    entries: [], metadata: [], sourceDocuments: [provenance],
  },
  diagnostics: [],
});
const source = createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/plugins" }, revision: "a".repeat(40) }, sha256);
const bytes = new TextEncoder().encode("{}");
const content = createContentManifest([
  { kind: "directory", path: ".claude-plugin", mode: 0o755 },
  { kind: "file", path: ".claude-plugin/marketplace.json", mode: 0o644, size: bytes.byteLength, digest: hashContent(bytes, sha256) },
], sha256);

describe("marketplace inspection", () => {
  it("does no I/O during construction and reads only manifest-listed catalog files", async () => {
    const readFile = vi.fn(async () => bytes);
    const service = createMarketplaceInspectionService({
      content: { readFile },
      readers: { claude: () => catalog, merge: () => catalog },
      sha256,
    });
    expect(readFile).not.toHaveBeenCalled();
    const result = await service.inspect({ root: "/staging/content", source, content, binding: `sha256:${"0".repeat(64)}` as never }, signal).catch(() => undefined);
    // The deliberately forged binding is rejected before any content read.
    expect(result).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("passes the verified catalog JSON to the configured reader", async () => {
    const readFile = vi.fn(async () => bytes);
    const reader = vi.fn(() => catalog);
    const service = createMarketplaceInspectionService({ content: { readFile }, readers: { claude: reader, merge: () => catalog }, sha256 });
    const binding = `sha256:${Buffer.from(sha256(new TextEncoder().encode(`${source.hash}\0${content.rootDigest}`))).toString("hex")}`;
    // createMaterializationBinding is the source of truth; use the service's
    // validation path through the known domain helper rather than a path read.
    const { createMaterializationBinding } = await import("../../src/domain/content-manifest.js");
    const result = await service.inspect({ root: "/staging/content", source, content, binding: createMaterializationBinding(source.hash, content.rootDigest, sha256) }, signal);
    expect(result.marketplace.name.value).toBe("community");
    expect(reader).toHaveBeenCalledWith({}, { path: ".claude-plugin/marketplace.json" });
    expect(readFile).toHaveBeenCalledOnce();
    void binding;
  });
});
