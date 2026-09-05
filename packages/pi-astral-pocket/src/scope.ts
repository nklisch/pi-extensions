import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const cache = new Map<string, string>();

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * Identify a local repository by Git's common directory, which is shared by
 * subdirectories and linked worktrees. Non-Git directories use their resolved
 * cwd. Remote URLs and basenames are deliberately not identity inputs.
 */
export function resolveProjectIdentity(cwd: string): string {
  const canonicalCwd = canonicalPath(cwd);
  const cached = cache.get(canonicalCwd);
  if (cached) return cached;
  let identity = canonicalCwd;
  try {
    const commonDir = execFileSync(
      "git",
      ["-C", canonicalCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 },
    ).trim();
    if (commonDir) identity = canonicalPath(commonDir);
  } catch {
    // Not being a Git repository is a supported mode, not an activation error.
  }
  cache.set(canonicalCwd, identity);
  return identity;
}
