import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConfigurationPathResultSchema,
  type ConfigurationPathPort,
} from "../../application/ports/configuration-path.js";
import type { ProjectRootAuthorityPort } from "../../application/ports/project-root-authority.js";
import {
  revalidateTrustedProjectRoot,
  resolveProjectPathWithoutSymlinks,
} from "../project/node-project-path-authority.js";

type BoundConfigurationSession = Readonly<{
  current(): Readonly<{ cwd: string }>;
}>;

/** Session-bound path adapter; no caller-selected project root is accepted. */
export function createNodeConfigurationPathPort(input: Readonly<{
  binding: BoundConfigurationSession;
  projectRoots: ProjectRootAuthorityPort;
}>): ConfigurationPathPort {
  if (input === null || typeof input !== "object") throw new TypeError("configuration path dependencies are required");
  return Object.freeze({
    async normalizeAndInspect(
      request: Parameters<ConfigurationPathPort["normalizeAndInspect"]>[0],
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      try {
        const scope = request.context.scope;
        let base: string;
        if (scope.kind === "project") {
          const capability = request.context.trustedProjectRoot;
          if (capability === undefined) return ConfigurationPathResultSchema.parse({ kind: "invalid" });
          base = (await revalidateTrustedProjectRoot(capability, input.projectRoots, signal)).path;
        } else {
          base = input.binding.current().cwd;
          if (request.context.trustedBaseDirectory !== undefined && resolve(request.context.trustedBaseDirectory) !== resolve(base)) {
            return ConfigurationPathResultSchema.parse({ kind: "invalid" });
          }
        }
        const inspected = await resolveProjectPathWithoutSymlinks(base, request.value);
        if (!inspected.exists) {
          return request.mustExist
            ? ConfigurationPathResultSchema.parse({ kind: "missing" })
            : ConfigurationPathResultSchema.parse({ kind: "valid", canonicalPath: pathToFileURL(inspected.path).href });
        }
        const stats = await lstat(inspected.path);
        const rightKind = request.expected === "file" ? stats.isFile() : stats.isDirectory();
        if (!rightKind) return ConfigurationPathResultSchema.parse({ kind: "wrong-kind" });
        signal.throwIfAborted();
        return ConfigurationPathResultSchema.parse({ kind: "valid", canonicalPath: pathToFileURL(inspected.path).href });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        return ConfigurationPathResultSchema.parse({ kind: "invalid" });
      }
    },
  });
}
