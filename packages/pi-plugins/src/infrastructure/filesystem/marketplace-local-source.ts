import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { MarketplaceSourceSchema } from "../../domain/source.js";
import type { MarketplaceLocalSourcePort } from "../../application/ports/marketplace-registration.js";

/** Canonicalize one explicitly approved user-local Git root without following a symlink leaf. */
export function createNodeMarketplaceLocalSourcePort(): MarketplaceLocalSourcePort {
  const port: MarketplaceLocalSourcePort = {
    async canonicalize(source, signal) {
      signal.throwIfAborted();
      if (!isAbsolute(source.path)) throw new Error("local marketplace path must be absolute");
      const declared = await lstat(source.path);
      if (declared.isSymbolicLink() || !declared.isDirectory()) throw new Error("local marketplace path must be a real directory");
      const canonical = await realpath(source.path);
      signal.throwIfAborted();
      const target = await lstat(canonical);
      if (target.isSymbolicLink() || !target.isDirectory()) throw new Error("local marketplace path must be a real directory");
      return MarketplaceSourceSchema.parse({ ...source, path: canonical }) as Extract<typeof source, { kind: "local-git" }>;
    },
  };
  return Object.freeze(port);
}
