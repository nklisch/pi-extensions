import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginHostPaths } from "./types.js";

/**
 * A catalog is untrusted input. Keep its relative paths boring so neither
 * lexical traversal nor a symlink can make a plugin source leave its checkout.
 */
export function assertSafeRelativePath(value: string, label = "path"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    throw new Error(`${label} is not a safe relative path: ${value}`);
  }
  let normalized = value;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  const segments = normalized.split("/");
  if (normalized.length === 0 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} is not a safe relative path: ${value}`);
  }
  return segments.join("/");
}

export function assertSafeName(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`${label} must be a simple filesystem name: ${value}`);
  }
  return value;
}

export function isPathContained(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const rest = relative(rootResolved, candidateResolved);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

export function resolveContainedPath(root: string, child: string, label = "path"): string {
  const safe = assertSafeRelativePath(child, label);
  const resolved = resolve(root, safe);
  if (!isPathContained(root, resolved)) throw new Error(`${label} escapes its root: ${child}`);
  return resolved;
}

export async function resolveContainedExistingPath(root: string, child: string, label = "path"): Promise<string> {
  const resolved = resolveContainedPath(root, child, label);
  const actual = await realpath(resolved);
  if (!isPathContained(root, actual)) throw new Error(`${label} escapes its root through a symlink: ${child}`);
  return actual;
}

export async function assertNoSymlinks(root: string): Promise<void> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`symlinks are not allowed in plugin bundles: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`plugin bundle is not a directory: ${root}`);
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = `${root}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`symlinks are not allowed in plugin bundles: ${child}`);
    if (entry.isDirectory()) await assertNoSymlinks(child);
    else if (!entry.isFile()) throw new Error(`special filesystem entries are not allowed in plugin bundles: ${child}`);
  }
}

export function createPluginHostPaths(agentDir: string): PluginHostPaths {
  const root = resolve(agentDir);
  return Object.freeze({
    agentDir: root,
    hostRoot: `${root}/plugin-host`,
    marketplaces: `${root}/plugin-host/marketplaces`,
    plugins: `${root}/plugin-host/plugins`,
    data: `${root}/plugin-host/data`,
  });
}
