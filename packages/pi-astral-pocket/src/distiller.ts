import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import type { DistillerConfig } from "./config.js";
import { identifySession, listSessionFiles, readSessionDigest, type SessionFileInfo } from "./sessions.js";
import { ensureLayout, updateDigest, writeNote } from "./store.js";

/** Bounded startup-pass distiller, modeled on Codex's memories pipeline: when
 * astra activates, find astra sessions that have been idle long enough, run
 * one cheap-model extraction per session into distilled pocket notes, then one
 * consolidation call that refreshes the durable digest. There is no daemon —
 * the pass runs at activation time only, and every failure degrades to the
 * mechanical floor (registry + recent-notes index stay correct without it). */

export interface DistillerDeps {
  /** One cheap-model completion. Injected so tests never touch the network;
   * null when no distiller model resolves (distiller skips with a notice). */
  callModel: ((prompt: string) => Promise<string>) | null;
  log: (message: string) => void;
  now?: () => number;
}

export interface DistillerResult {
  processed: number;
  skippedReason?: string;
  errors: string[];
}

interface DistilledState {
  sessions: Record<string, string>; // sessionId -> ISO date distilled
}

function statePath(root: string): string {
  return join(root, "distilled.json");
}

function loadState(root: string): DistilledState {
  try {
    return JSON.parse(readFileSync(statePath(root), "utf8")) as DistilledState;
  } catch {
    return { sessions: {} };
  }
}

function saveState(root: string, state: DistilledState): void {
  writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Sessions eligible for distillation: astra sessions idle past the threshold,
 * within the age cap, not already distilled, oldest first, bounded. */
export async function selectDistillationCandidates(
  sessionsDir: string,
  config: DistillerConfig,
  state: DistilledState,
  nowMs: number,
): Promise<SessionFileInfo[]> {
  const idleCutoff = nowMs - config.minIdleHours * 3_600_000;
  const candidates: SessionFileInfo[] = [];
  for (const { path, mtimeMs } of listSessionFiles(sessionsDir, config.maxSessionAgeDays)) {
    if (mtimeMs > idleCutoff) continue;
    const info = await identifySession(path, mtimeMs);
    if (!info.astra || !info.id || state.sessions[info.id]) continue;
    candidates.push(info);
  }
  return candidates.sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, config.maxSessionsPerPass);
}

const EXTRACTION_PROMPT = `You are distilling a past coding-agent session into durable pocket notes for future sessions.

From the transcript below, extract ONLY durable knowledge worth carrying forward:
- decisions and their rationale
- project conventions and constraints
- recurring pitfalls and their fixes
- user preferences and working style
- non-obvious facts that cost effort to discover

Do NOT include: ephemeral task status, things already recorded in the repo, anything re-derivable in seconds, or secrets/credentials/personal data (redact anything that looks like one).

If nothing in the session is durable, reply with exactly: NONE
Otherwise reply with at most 5 short markdown bullets, each starting with a bolded title.

TRANSCRIPT:
`;

const CONSOLIDATION_PROMPT = `You maintain the "durable digest" of an agent's cross-session pocket notes. Merge the new distilled notes below into the existing digest: dedupe, drop contradicted or stale entries, keep it under 40 short bullets. Reply with the refreshed digest markdown only, no commentary.

EXISTING DIGEST:
`;

export async function runDistillerPass(
  root: string,
  sessionsDir: string,
  config: DistillerConfig,
  deps: DistillerDeps,
): Promise<DistillerResult> {
  const nowMs = (deps.now ?? Date.now)();
  if (!config.enabled) return { processed: 0, skippedReason: "distiller disabled", errors: [] };
  if (!deps.callModel) {
    deps.log("astral-pocket: no distiller model resolved; mechanical floor only");
    return { processed: 0, skippedReason: "no distiller model", errors: [] };
  }

  ensureLayout(root);
  const state = loadState(root);
  const candidates = await selectDistillationCandidates(sessionsDir, config, state, nowMs);
  const errors: string[] = [];
  const extracted: string[] = [];

  for (const session of candidates) {
    try {
      const transcript = await readSessionDigest(session.path);
      if (transcript.length < 200) {
        state.sessions[session.id] = new Date(nowMs).toISOString(); // too short to hold durable signal
        continue;
      }
      const output = await deps.callModel(`${EXTRACTION_PROMPT}\n${transcript}`);
      if (output.trim() && output.trim() !== "NONE") {
        const project = session.cwd.split("/").filter(Boolean).pop() ?? "unknown";
        // Queue on POCKET.md like pocket_note does: the distiller runs
        // concurrently with live note writes, and registry+summary updates
        // are read-modify-write cycles that would otherwise race.
        await withFileMutationQueue(join(root, "POCKET.md"), async () =>
          writeNote(root, {
            title: `Distilled session — ${project} — ${new Date(session.mtimeMs).toISOString().slice(0, 10)}`,
            body: output.trim(),
            keywords: ["distilled", project],
            project: session.cwd,
            source: "distilled",
          }),
        );
        extracted.push(output.trim());
      }
      state.sessions[session.id] = new Date(nowMs).toISOString();
    } catch (error) {
      errors.push(`${session.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (extracted.length > 0) {
    try {
      const summaryPath = join(root, "SUMMARY.md");
      const existing = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
      const digestMatch = existing.match(/<!-- pocket:digest:start -->([\s\S]*?)<!-- pocket:digest:end -->/);
      const existingDigest = digestMatch?.[1]?.trim() ?? "";
      const refreshed = await deps.callModel(
        `${CONSOLIDATION_PROMPT}\n${existingDigest}\n\nNEW NOTES:\n${extracted.join("\n")}`,
      );
      if (refreshed.trim()) updateDigest(root, refreshed.trim());
    } catch (error) {
      errors.push(`consolidation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    saveState(root, state);
  } catch (error) {
    errors.push(`state: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { processed: extracted.length, errors };
}
