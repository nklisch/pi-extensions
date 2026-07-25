import { lstat, realpath, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { derivePluginDataRef } from "../../domain/state/references.js";
import type { Sha256 } from "../../domain/source.js";
import type { PersistentDataRemovalPort } from "../../application/ports/persistent-data-removal.js";
import type { ContentStoreLayout } from "./content-store-layout.js";

/** Remove only the digest-addressed data root proven by scope/plugin/ref evidence. */
export function createNodePersistentDataRemovalPort(input: Readonly<{
  layout: ContentStoreLayout;
  sha256: Sha256;
}>): PersistentDataRemovalPort {
  return Object.freeze({
    async remove(plan: Parameters<PersistentDataRemovalPort["remove"]>[0], signal: AbortSignal) {
      signal.throwIfAborted();
      const expected = derivePluginDataRef({ scope: plan.scope, plugin: plan.plugin, purpose: "persistent-plugin-data" }, input.sha256);
      if (plan.dataRef !== expected || plan.confirmation !== "delete-confirmed") throw new Error("persistent data deletion evidence is invalid");
      const path = input.layout.dataPath(plan.dataRef);
      let stats;
      try { stats = await lstat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "already-absent"; throw error; }
      if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(path) !== path || await realpath(dirname(path)) !== dirname(path)) throw new Error("persistent data root is unsafe");
      await rm(path, { recursive: true, force: false, maxRetries: 0 });
      try { await lstat(path); throw new Error("persistent data root remains after deletion"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return "removed";
    },
  });
}
