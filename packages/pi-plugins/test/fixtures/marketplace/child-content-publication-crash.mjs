import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContentManifest, createMaterializationBinding, hashContent } from "../../../src/domain/content-manifest.js";
import { createResolvedPluginSource } from "../../../src/domain/source.js";
import { createPromotionPlan } from "../../../src/application/content-promotion.js";
import { createNodeContentStoreWithPlatform } from "../../../src/infrastructure/filesystem/create-content-store.js";
import { createNodeContentStorePlatform } from "../../../src/infrastructure/filesystem/content-store-durability.js";

const [hostRoot] = process.argv.slice(2);
if (typeof hostRoot !== "string" || hostRoot.length === 0) throw new Error("host root is required");
const sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const base = createNodeContentStorePlatform();
const platform = {
  ...base,
  async publishDirectoryNoReplace(source, destination) {
    process.stdout.write(`${JSON.stringify({ source, destination })}\n`);
    await new Promise(() => {});
  },
};
const store = await createNodeContentStoreWithPlatform({ hostRoot, platform });
const signal = new AbortController().signal;
const allocation = await store.allocateStaging(signal);
await mkdir(join(allocation.slot.root, "content"));
await writeFile(join(allocation.slot.root, "content", "plugin.txt"), "crash-safe");
const bytes = new TextEncoder().encode("crash-safe");
const manifest = createContentManifest([{ kind: "file", path: "plugin.txt", mode: 0o644, size: bytes.byteLength, digest: hashContent(bytes, sha256) }], sha256);
const source = createResolvedPluginSource({ kind: "git", url: "https://example.com/crash-safe.git", revision: "e".repeat(40) }, sha256);
const plan = createPromotionPlan({ kind: "plugin", allocation, materialized: { root: join(allocation.slot.root, "content"), source, content: manifest, binding: createMaterializationBinding(source.hash, manifest.rootDigest, sha256) } }, sha256);
await store.promote(plan, signal);
