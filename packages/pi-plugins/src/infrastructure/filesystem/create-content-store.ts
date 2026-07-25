import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import type { ContentStorePort } from "../../application/ports/content-store.js";
import type { InstalledPluginLoader } from "../../application/ports/installed-plugin-loader.js";
import type { ContentStorePlatform } from "../../application/ports/content-store-platform.js";
import type { PersistentDataRemovalPort } from "../../application/ports/persistent-data-removal.js";
import { createContentStoreLayout } from "./content-store-layout.js";
import { createStagingAllocator, type RandomBytes } from "./staging-allocator.js";
import { createNodeContentStorePlatform } from "./content-store-durability.js";
import { createImmutableContentStore } from "./immutable-content-store.js";
import { createContentRootResolver } from "./content-root-resolver.js";
import { createRuntimeRootStore } from "./runtime-root-store.js";
import { createInstalledPluginLoader } from "./installed-plugin-loader.js";
import { createNodePersistentDataRemovalPort } from "./persistent-data-removal.js";

const nodeSha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

export type NodeContentStoreOptions = Readonly<{
  hostRoot: string;
}>;

type InternalNodeContentStoreOptions = Readonly<{
  hostRoot: string;
  platform?: ContentStorePlatform;
  randomBytes?: RandomBytes;
}>;

/**
 * Compose the lifecycle-facing store. The public factory deliberately accepts
 * only the host root; platform primitives and allocation tokens stay inside
 * this module. Tests and alternate platform packages use the internal factory
 * below to inject a capability implementation.
 */
export type NodeContentInfrastructure = Readonly<{
  content: ContentStorePort;
  installed: InstalledPluginLoader;
  dataRemoval: PersistentDataRemovalPort;
}>;

export async function createNodeContentStore(options: NodeContentStoreOptions): Promise<ContentStorePort> {
  return (await createNodeContentInfrastructure(options)).content;
}

export async function createNodeContentInfrastructure(
  options: NodeContentStoreOptions,
): Promise<NodeContentInfrastructure> {
  return createNodeContentInfrastructureWithPlatform(options);
}

export async function createNodeContentStoreWithPlatform(options: InternalNodeContentStoreOptions): Promise<ContentStorePort> {
  return (await createNodeContentInfrastructureWithPlatform(options)).content;
}

export async function createNodeContentInfrastructureWithPlatform(
  options: InternalNodeContentStoreOptions,
): Promise<NodeContentInfrastructure> {
  if (options === null || typeof options !== "object" || typeof options.hostRoot !== "string") {
    throw new TypeError("Node content store requires a host root");
  }
  const layout = await createContentStoreLayout(options.hostRoot);
  const randomBytes = options.randomBytes ?? ((size: number) => new Uint8Array(nodeRandomBytes(size)));
  const allocator = createStagingAllocator(layout, { randomBytes });
  const platform = options.platform ?? createNodeContentStorePlatform();
  const immutable = createImmutableContentStore({ layout, allocator, platform, sha256: nodeSha256, randomBytes });
  const resolver = createContentRootResolver({ layout, sha256: nodeSha256 });
  const roots = createRuntimeRootStore({ layout, platform, sha256: nodeSha256, randomBytes });
  const content: ContentStorePort = Object.freeze({
    capabilities: immutable.capabilities,
    allocateStaging: allocator.allocateStaging,
    discardStaging: allocator.discardStaging,
    promote: immutable.promote,
    resolveMarketplace: resolver.resolveMarketplace,
    resolvePlugin: resolver.resolvePlugin,
    ensureDataRoot: roots.ensureDataRoot,
    allocateProjectionRoot: roots.allocateProjectionRoot,
    sealProjectionRoot: roots.sealProjectionRoot,
    discardProjectionRoot: roots.discardProjectionRoot,
    resolveProjectionRoot: roots.resolveProjectionRoot,
  });
  return Object.freeze({
    content,
    installed: createInstalledPluginLoader({ content, sha256: nodeSha256 }),
    dataRemoval: createNodePersistentDataRemovalPort({ layout, sha256: nodeSha256 }),
  });
}
