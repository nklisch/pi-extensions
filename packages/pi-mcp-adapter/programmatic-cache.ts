// programmatic-cache.ts - Persistent tool inventory for programmatic sources
//
// The programmatic runtime has no config file to hash (launch values arrive
// late, per attempt), so unlike the classic metadata cache there is nothing
// to validate entries against at load time. Entries are keyed by the
// qualified server key, which embeds the exact source identity (plugin
// revision + projection digest): a plugin update produces new keys and old
// entries simply become unreachable. Correctness therefore comes from the
// key, not from a comparison at read time.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.ts";

const CACHE_VERSION = 1;

export interface ProgrammaticCachedTool {
  name: string;
  description?: string;
}

export interface ProgrammaticServerCacheEntry {
  tools: ProgrammaticCachedTool[];
  cachedAt: number;
}

export interface ProgrammaticToolCache {
  version: number;
  /** Keyed by qualifiedServerKey (`programmatic:<sha256>`). */
  servers: Record<string, ProgrammaticServerCacheEntry>;
}

export function getProgrammaticCachePath(): string {
  return getAgentPath("mcp-programmatic-cache.json");
}

function entryIsValid(value: unknown): value is ProgrammaticServerCacheEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (!Array.isArray(entry.tools) || typeof entry.cachedAt !== "number") return false;
  return entry.tools.every((tool: unknown) =>
    tool !== null && typeof tool === "object" && !Array.isArray(tool) &&
    typeof (tool as Record<string, unknown>).name === "string" &&
    ((tool as Record<string, unknown>).description === undefined ||
      typeof (tool as Record<string, unknown>).description === "string"));
}

export function loadProgrammaticCache(): ProgrammaticToolCache | null {
  const cachePath = getProgrammaticCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!raw || typeof raw !== "object" || raw.version !== CACHE_VERSION) return null;
    if (!raw.servers || typeof raw.servers !== "object" || Array.isArray(raw.servers)) return null;
    const servers: Record<string, ProgrammaticServerCacheEntry> = {};
    for (const [key, entry] of Object.entries(raw.servers as Record<string, unknown>)) {
      if (entryIsValid(entry)) servers[key] = entry;
    }
    return { version: CACHE_VERSION, servers };
  } catch {
    return null;
  }
}

/**
 * Full replace, not the classic cache's additive merge: the caller passes the
 * complete live inventory, so entries for sources that no longer exist are
 * pruned. Two racing sessions can clobber each other's fresh entries; the
 * cost is a re-warm on next use, which discovery tolerates.
 */
export function saveProgrammaticCache(cache: ProgrammaticToolCache): void {
  const cachePath = getProgrammaticCachePath();
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf-8");
  renameSync(tmpPath, cachePath);
}
