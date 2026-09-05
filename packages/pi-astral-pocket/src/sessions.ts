import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { ASTRA_MODEL_ID, ASTRA_PROVIDER } from "./activation.js";
import { resolveProjectIdentity } from "./scope.js";

export interface SessionRevision {
  mtimeMs: number;
  size: number;
  key: string;
}

export interface SessionFileInfo extends SessionRevision {
  path: string;
  id: string;
  cwd: string;
  astra: boolean;
}

export interface SessionSearchHit {
  sessionId: string;
  project: string;
  timestamp: string;
  kind: "user" | "assistant" | "toolCall" | "toolResult";
  excerpt: string;
}

const HITS_PER_FILE_CAP = 50;
const SUMMARIZED_EXCERPT = 200;
const FULL_EXCERPT = 2_000;

async function* iterLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

export function revisionFor(path: string): SessionRevision | undefined {
  try {
    const stat = statSync(path);
    const mtimeMs = stat.mtimeMs;
    const size = stat.size;
    return { mtimeMs, size, key: `${mtimeMs}:${size}` };
  } catch {
    return undefined;
  }
}

/** Enumerate top-level session files across all project dirs, newest first. */
export function listSessionFiles(sessionsDir: string, maxAgeDays?: number, nowMs = Date.now()): Array<{ path: string } & SessionRevision> {
  if (!existsSync(sessionsDir)) return [];
  const cutoff = maxAgeDays === undefined ? null : nowMs - maxAgeDays * 86_400_000;
  const files: Array<{ path: string } & SessionRevision> = [];
  for (const dir of readdirSync(sessionsDir)) {
    const dirPath = join(sessionsDir, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
      for (const file of readdirSync(dirPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const path = join(dirPath, file);
        const revision = revisionFor(path);
        if (!revision || (cutoff !== null && revision.mtimeMs < cutoff)) continue;
        files.push({ path, ...revision });
      }
    } catch {
      // Recall remains available when one session directory is unreadable.
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function isAstraMarker(entry: Record<string, unknown>): boolean {
  if (entry.type === "model_change" && entry.provider === ASTRA_PROVIDER && entry.modelId === ASTRA_MODEL_ID) return true;
  if (entry.type === "message") {
    const msg = entry.message as Record<string, unknown> | undefined;
    if (msg?.role === "assistant" && msg.provider === ASTRA_PROVIDER && msg.model === ASTRA_MODEL_ID) return true;
  }
  return false;
}

export async function identifySession(path: string, revisionOrMtime: SessionRevision | number): Promise<SessionFileInfo> {
  const revision = typeof revisionOrMtime === "number"
    ? (revisionFor(path) ?? { mtimeMs: revisionOrMtime, size: 0, key: `${revisionOrMtime}:0` })
    : revisionOrMtime;
  let id = "";
  let cwd = "";
  let astra = false;
  for await (const line of iterLines(path)) {
    if (id && cwd && astra) break;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (entry.type === "session") {
      id = String(entry.id ?? "");
      cwd = String(entry.cwd ?? "");
    } else if (isAstraMarker(entry)) astra = true;
  }
  return { path, id, cwd, astra, ...revision };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null)
    .map((block) => typeof block.text === "string" ? block.text : "").filter(Boolean).join(" ");
}

function truncate(text: string, cap: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= cap ? clean : `${clean.slice(0, cap)}…`;
}

export async function searchAstraSessions(
  sessionsDir: string,
  query: string,
  options: { full?: boolean; limit?: number; maxAgeDays?: number; projectId?: string; recallScope?: "current" | "all" } = {},
): Promise<SessionSearchHit[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const limit = Math.max(1, options.limit ?? 10);
  const cap = options.full ? FULL_EXCERPT : SUMMARIZED_EXCERPT;
  const hits: SessionSearchHit[] = [];
  const sessions: SessionFileInfo[] = [];
  for (const file of listSessionFiles(sessionsDir, options.maxAgeDays)) {
    const info = await identifySession(file.path, file);
    if (!info.astra) continue;
    if ((options.recallScope ?? "current") !== "all" &&
      (!info.cwd || options.projectId === undefined || resolveProjectIdentity(info.cwd) !== options.projectId)) continue;
    sessions.push(info);
  }
  sessions.sort((a, b) => {
    const projectRank = Number(Boolean(options.projectId && b.cwd) && resolveProjectIdentity(b.cwd) === options.projectId) -
      Number(Boolean(options.projectId && a.cwd) && resolveProjectIdentity(a.cwd) === options.projectId);
    return projectRank || b.mtimeMs - a.mtimeMs;
  });

  for (const info of sessions) {
    if (hits.length >= limit) break;
    const fileHits: SessionSearchHit[] = [];
    for await (const line of iterLines(info.path)) {
      if (fileHits.length >= HITS_PER_FILE_CAP) break;
      if (!terms.every((term) => line.toLowerCase().includes(term))) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (entry.type !== "message") continue;
      const msg = entry.message as Record<string, unknown>;
      const role = msg.role as string;
      const timestamp = String(entry.timestamp ?? "");
      const base = { sessionId: info.id, project: info.cwd, timestamp };
      if (role === "user" || role === "assistant") {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content as Record<string, unknown>[]) {
            if (block.type === "toolCall") {
              const args = truncate(JSON.stringify(block.arguments ?? {}), cap);
              if (terms.every((term) => `${String(block.name)} ${args}`.toLowerCase().includes(term))) {
                fileHits.push({ ...base, kind: "toolCall", excerpt: `${String(block.name)}(${args})` });
              }
            } else if (block.type === "text" && typeof block.text === "string") {
              const text = block.text;
              if (terms.every((term) => text.toLowerCase().includes(term))) {
                fileHits.push({ ...base, kind: role as "user" | "assistant", excerpt: truncate(text, cap) });
              }
            }
          }
        } else {
          const text = textOf(msg.content);
          if (terms.every((term) => text.toLowerCase().includes(term))) {
            fileHits.push({ ...base, kind: role as "user" | "assistant", excerpt: truncate(text, cap) });
          }
        }
      } else if (role === "toolResult") {
        const text = textOf(msg.content);
        if (terms.every((term) => `${String(msg.toolName ?? "")} ${text}`.toLowerCase().includes(term))) {
          fileHits.push({ ...base, kind: "toolResult", excerpt: `${String(msg.toolName ?? "tool")} → ${truncate(text, cap)}` });
        }
      }
    }
    hits.push(...fileHits);
  }
  return hits.slice(0, limit);
}

function compactEntry(entry: Record<string, unknown>): string {
  if (entry.type !== "message") return "";
  const msg = entry.message as Record<string, unknown>;
  if (msg.role === "user") return `USER: ${truncate(textOf(msg.content), 1_500)}`;
  if (msg.role === "assistant") {
    const blocks = Array.isArray(msg.content) ? msg.content as Record<string, unknown>[] : [];
    const content = blocks.map((block) => {
      if (block.type === "text") return truncate(String(block.text ?? ""), 1_500);
      if (block.type === "toolCall") return `[tool: ${String(block.name)} ${truncate(JSON.stringify(block.arguments ?? {}), 200)}]`;
      return "";
    }).filter(Boolean).join(" ");
    return content ? `ASSISTANT: ${content}` : "";
  }
  if (msg.role === "toolResult") {
    return `[result: ${String(msg.toolName ?? "tool")}${msg.isError ? " (error)" : ""}] ${truncate(textOf(msg.content), 200)}`;
  }
  return "";
}

/**
 * Keep a small opening for problem context and devote the rest of the budget
 * to the latest conversation, where final decisions and corrections live.
 */
export async function readSessionDigest(path: string, capBytes = 60_000): Promise<string> {
  const openingCap = Math.max(1_000, Math.floor(capBytes * 0.2));
  const tailCap = Math.max(1_000, capBytes - openingCap - 80);
  const opening: string[] = [];
  const tail: string[] = [];
  let openingSize = 0;
  let tailSize = 0;
  let openingClosed = false;
  let omitted = false;

  for await (const line of iterLines(path)) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const chunk = compactEntry(entry);
    if (!chunk) continue;
    if (!openingClosed && openingSize + chunk.length + 1 <= openingCap) {
      opening.push(chunk);
      openingSize += chunk.length + 1;
      continue;
    }
    // Once a chunk overflows the opening budget, all later entries belong to
    // the tail so their chronology cannot jump ahead of an older tail entry.
    openingClosed = true;
    tail.push(chunk);
    tailSize += chunk.length + 1;
    while (tailSize > tailCap && tail.length > 1) {
      tailSize -= (tail.shift()?.length ?? 0) + 1;
      omitted = true;
    }
  }
  if (tail.length === 0) return opening.join("\n");
  return [...opening, ...(omitted ? ["… [earlier transcript omitted; latest decisions retained] …"] : []), ...tail].join("\n");
}
