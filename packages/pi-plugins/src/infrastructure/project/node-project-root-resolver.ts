import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProjectRootResolutionPort } from "../../application/ports/project-root-authority.js";
import type { CommandRunner } from "../../application/ports/process-runner.js";
import { SourceHashSchema, type Sha256 } from "../../domain/source.js";
import {
  CanonicalProjectRootSchema,
  ProjectIdentitySchema,
  deriveProjectKey,
  type ProjectIdentity,
} from "../../domain/state/scope.js";

function digest(bytes: Uint8Array, sha256: Sha256): string {
  const result = sha256(bytes);
  if (!(result instanceof Uint8Array) || result.byteLength !== 32) throw new Error("SHA-256 must return 32 bytes");
  return [...result].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function gitCommonDirectory(cwd: string, git: Pick<CommandRunner, "run">, signal: AbortSignal): Promise<string | undefined> {
  try {
    const result = await git.run({
      executable: "git",
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd,
      environment: { inherit: "host", values: {} },
      capture: {
        stdout: { mode: "capture", maxBytes: 16 * 1024, overflow: "error" },
        stderr: { maxBytes: 16 * 1024, overflow: "truncate" },
      },
      timeoutMs: 5_000,
    }, signal);
    if (result.exitCode !== 0 || !(result.stdout instanceof Uint8Array)) return undefined;
    const value = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
    if (!isAbsolute(value)) return undefined;
    return await realpath(value);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return undefined;
  }
}

export async function resolveNodeProjectIdentity(input: Readonly<{
  cwd: string;
  sha256: Sha256;
  git?: Pick<CommandRunner, "run">;
  signal: AbortSignal;
}>): Promise<ProjectIdentity> {
  input.signal.throwIfAborted();
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) throw new TypeError("project cwd must be absolute");
  const canonicalPath = await realpath(resolve(input.cwd));
  const canonicalRoot = CanonicalProjectRootSchema.parse(pathToFileURL(canonicalPath).href);
  const common = input.git === undefined ? undefined : await gitCommonDirectory(canonicalPath, input.git, input.signal);
  if (common === undefined) {
    return ProjectIdentitySchema.parse({
      kind: "path-only",
      canonicalRoot,
      limitation: "identity-changes-with-canonical-root",
    });
  }
  const stats = await lstat(common);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Git common directory identity is invalid");
  const preimage = new TextEncoder().encode(
    `git-common-directory-v1\0device:${String(stats.dev)}\0inode:${String(stats.ino)}`,
  );
  return ProjectIdentitySchema.parse({
    kind: "repository",
    canonicalRoot,
    repositoryFingerprint: SourceHashSchema.parse(`sha256:${digest(preimage, input.sha256)}`),
  });
}

export function createNodeProjectRootResolver(input: Readonly<{
  cwd: string;
  sha256: Sha256;
  git?: Pick<CommandRunner, "run">;
}>): ProjectRootResolutionPort {
  return Object.freeze({
    resolve(signal: AbortSignal) {
      return resolveNodeProjectIdentity({ ...input, signal }).then((identity) => ({
        kind: "project" as const,
        identity,
        projectKey: deriveProjectKey(identity, input.sha256),
      }));
    },
  });
}
