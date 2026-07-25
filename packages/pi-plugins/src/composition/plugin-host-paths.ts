import { isAbsolute, join, resolve } from "node:path";
import { ProjectKeySchema, ScopeReferenceSchema, type ScopeReference } from "../domain/state/scope.js";
import { PackagedPluginHostError, PackagedPluginHostErrorCode } from "./packaged-plugin-host-contract.js";

const PROJECT_KEY_PREFIX = "project-v1:sha256:";

export type PluginHostPathPlan = Readonly<{
  hostRoot: string;
  stateRoot: string;
  lockRoot: string;
  configurationRoot: string;
  stateDatabase(scope: ScopeReference): string;
}>;

function invalid(message: string): never {
  throw new PackagedPluginHostError(PackagedPluginHostErrorCode.invalidOptions, message);
}

/** Decode only the verified digest portion of a ProjectKey into a new path. */
export function projectKeyDigest(projectKey: unknown): string {
  const key = ProjectKeySchema.parse(projectKey);
  const digest = key.slice(PROJECT_KEY_PREFIX.length);
  if (!/^[0-9a-f]{64}$/u.test(digest)) invalid("project key digest is invalid");
  return digest;
}

/**
 * Pure path planning. No path is opened, canonicalized through the filesystem,
 * or created until explicit startup constructs the owning adapter.
 */
export function createPluginHostPathPlan(agentDir: string): PluginHostPathPlan {
  if (typeof agentDir !== "string" || agentDir.length === 0 || !isAbsolute(agentDir)) {
    invalid("agent directory must be an absolute path");
  }
  const base = resolve(agentDir);
  const hostRoot = join(base, "plugin-host");
  const stateRoot = join(hostRoot, "state", "v1");
  const lockRoot = join(hostRoot, "locks", "v1");
  const configurationRoot = join(hostRoot, "configuration", "v1");
  const plan: PluginHostPathPlan = {
    hostRoot,
    stateRoot,
    lockRoot,
    configurationRoot,
    stateDatabase(scopeInput): string {
      const scope = ScopeReferenceSchema.parse(scopeInput);
      return join(
        stateRoot,
        scope.kind === "user" ? "user.sqlite" : `project-${projectKeyDigest(scope.projectKey)}.sqlite`,
      );
    },
  };
  if (plan.stateDatabase({ kind: "user" }) === join(stateRoot, "project-user.sqlite")) {
    invalid("scope paths alias");
  }
  return Object.freeze(plan);
}
