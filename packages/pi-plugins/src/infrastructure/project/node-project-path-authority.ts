import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectRootAuthorityPort, TrustedProjectRoot } from "../../application/ports/project-root-authority.js";
import type { ScopeContext } from "../../domain/state/scope.js";

export function isContainedProjectPath(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function projectPathHasSymlink(base: string, candidate: string): Promise<boolean> {
  const rel = relative(base, candidate);
  let current = base;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

export function trustedRootScope(root: TrustedProjectRoot): Extract<ScopeContext, { kind: "project" }> {
  return { kind: "project", identity: root.identity, projectKey: root.projectKey };
}

/** Revalidate the opaque project capability and the canonical root path itself. */
export async function revalidateTrustedProjectRoot(
  root: TrustedProjectRoot,
  authority: ProjectRootAuthorityPort,
  signal: AbortSignal,
): Promise<Readonly<{ scope: Extract<ScopeContext, { kind: "project" }>; path: string; device: string; inode: string }>> {
  signal.throwIfAborted();
  const scope = trustedRootScope(root);
  if (authority.revalidate !== undefined) await authority.revalidate(root, scope, signal);
  else authority.verify(root, scope);
  const path = fileURLToPath(root.canonicalRoot);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error("trusted project root is not a stable regular directory");
  signal.throwIfAborted();
  return Object.freeze({ scope, path, device: String(stats.dev), inode: String(stats.ino) });
}

export async function resolveProjectPathWithoutSymlinks(
  base: string,
  value: string,
): Promise<Readonly<{ path: string; exists: boolean }>> {
  const canonicalBase = await realpath(base);
  if (canonicalBase !== resolve(base)) throw new Error("project root is not canonical");
  const candidate = resolve(canonicalBase, value);
  if (!isContainedProjectPath(canonicalBase, candidate) || await projectPathHasSymlink(canonicalBase, candidate)) throw new Error("project path is unsafe");
  try {
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink()) throw new Error("project path is a symlink");
    const canonicalCandidate = await realpath(candidate);
    if (!isContainedProjectPath(canonicalBase, canonicalCandidate) || canonicalCandidate !== candidate) throw new Error("project path changed identity");
    return Object.freeze({ path: canonicalCandidate, exists: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // The existing ancestor must still remain under the trusted root.
    let ancestor = dirname(candidate);
    while (ancestor !== canonicalBase) {
      try {
        const stats = await lstat(ancestor);
        if (stats.isSymbolicLink() || !stats.isDirectory() || await realpath(ancestor) !== ancestor) throw new Error("project path ancestor is unsafe");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        ancestor = dirname(ancestor);
      }
    }
    if (!isContainedProjectPath(canonicalBase, ancestor)) throw new Error("project path escaped root");
    return Object.freeze({ path: candidate, exists: false });
  }
}
