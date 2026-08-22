import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactGc, ArtifactGcKind, ArtifactGcCandidate, ArtifactGcReport } from "../../application/ports/artifact-gc.js";

export const DEFAULT_CONVERGENCE_GRACE_DAYS = 7;
export const CONVERGENCE_FOREGROUND_BUDGET_MS = 2_000;
export const CONVERGENCE_FOREGROUND_ITEM_BUDGET = 128;


function missing(error: unknown): boolean { return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"; }
function graceDays(): number {
  const configured = Number.parseInt(process.env.PI_PLUGINS_CONVERGENCE_GRACE_DAYS ?? String(DEFAULT_CONVERGENCE_GRACE_DAYS), 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_CONVERGENCE_GRACE_DAYS;
}

/**
 * Time-graced artifact cleanup deliberately retains the whole category when a
 * directory cannot be inspected: an incomplete filesystem listing cannot
 * prove that a live state reference is absent.
 */
export function createArtifactGc(input: Readonly<{ hostRoot: string; maxItems?: number; budgetMs?: number }>): ArtifactGc {
  if (input === null || typeof input !== "object" || typeof input.hostRoot !== "string" || input.hostRoot.length === 0) throw new TypeError("artifact GC host root is required");
  const maxItems = input.maxItems ?? CONVERGENCE_FOREGROUND_ITEM_BUDGET;
  const budgetMs = input.budgetMs ?? CONVERGENCE_FOREGROUND_BUDGET_MS;
  const roots: readonly Readonly<{ kind: ArtifactGcKind; path: string }> [] = [
    { kind: "staging", path: join(input.hostRoot, "staging", "v1") },
    // Projection preparation uses a separate staging root; it follows the
    // same grace policy as source staging and must not be hidden by the
    // published generated/v1 scan's `.staging` skip.
    { kind: "staging", path: join(input.hostRoot, "generated", "v1", ".staging") },
    { kind: "marketplace", path: join(input.hostRoot, "stores", "v1", "marketplaces") },
    { kind: "revision", path: join(input.hostRoot, "stores", "v1", "plugins") },
    { kind: "projection", path: join(input.hostRoot, "generated", "v1") },
  ];
  async function sweep(request: Readonly<{ referenced: ReadonlySet<string>; retainKinds?: readonly ArtifactGcKind[]; signal: AbortSignal; now?: number }>): Promise<ArtifactGcReport> {
    request.signal.throwIfAborted();
    const now = request.now ?? Date.now();
    const retainKinds = new Set(request.retainKinds ?? []);
    const grace = graceDays() * 86_400_000;
    const started = Date.now();
    let removed = 0;
    let retained = 0;
    let deferred = false;
    let incompleteEvidence = false;
    let processed = 0;
    for (const root of roots) {
      if (retainKinds.has(root.kind)) { retained += 1; continue; }
      if (processed >= maxItems || Date.now() - started >= budgetMs) { deferred = true; break; }
      let names: string[];
      try { names = await readdir(root.path); }
      catch (error) { if (missing(error)) continue; incompleteEvidence = true; retained += 1; continue; }
      const candidates: string[] = [];
      let categoryIncomplete = false;
      for (const name of names.sort()) {
        request.signal.throwIfAborted();
        if (processed >= maxItems || Date.now() - started >= budgetMs) { deferred = true; break; }
        processed += 1;
        if (name === ".staging" || name.endsWith(".owner")) continue;
        if (root.kind !== "staging" && !/^[0-9a-f]{64}$/.test(name) && !name.startsWith(".payload-")) continue;
        const path = join(root.path, name);
        let info;
        try { info = await lstat(path); }
        catch (error) {
          if (!missing(error)) { categoryIncomplete = true; retained += 1; }
          continue;
        }
        if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) { categoryIncomplete = true; retained += 1; continue; }
        const key = `${root.kind}:${name}`;
        if (request.referenced.has(key) || now - info.mtimeMs < grace) { retained += 1; continue; }
        candidates.push(path);
      }
      if (categoryIncomplete) {
        // A single unreadable entry makes the category's absence proof
        // incomplete. Do not collect the otherwise eligible siblings on this
        // pass; the next pass can reassess the whole category.
        incompleteEvidence = true;
        retained += candidates.length;
        continue;
      }
      for (const path of candidates) {
        try { await rm(path, { recursive: true, force: true }); removed += 1; }
        catch { incompleteEvidence = true; retained += 1; }
      }
    }
    if (incompleteEvidence) deferred = true;
    return Object.freeze({ removed, retained, deferred, incompleteEvidence });
  }
  return Object.freeze({ sweep });
}

export type { ArtifactGc, ArtifactGcKind, ArtifactGcCandidate, ArtifactGcReport } from "../../application/ports/artifact-gc.js";
