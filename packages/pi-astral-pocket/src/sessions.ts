import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { ASTRA_MODEL_ID, ASTRA_PROVIDER } from "./activation.js";

/** Past-session access. Pi stores sessions as JSONL trees at
 * `<agentDir>/sessions/<cwd-slug>/<timestamp>_<uuid>.jsonl`, with sub-agent
 * task sessions nested under a `tasks/` subdir (excluded here — they are
 * worker noise, and their parent session carries the durable signal). */

export interface SessionFileInfo {
  path: string;
  id: string;
  cwd: string;
  mtimeMs: number;
  /** True when any assistant message in the file was produced by astra, or a
   * model_change switched to it. Assistant messages carry provider/model
   * directly, so sessions that were astra from the start are still caught. */
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
const FULL_EXCERPT = 2000;

async function* iterLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

/** Enumerate top-level session files across all project dirs, newest first. */
export function listSessionFiles(sessionsDir: string, maxAgeDays?: number): { path: string; mtimeMs: number }[] {
  if (!existsSync(sessionsDir)) return [];
  const cutoff = maxAgeDays === undefined ? null : Date.now() - maxAgeDays * 86_400_000;
  const files: { path: string; mtimeMs: number }[] = [];
  for (const dir of readdirSync(sessionsDir)) {
    const dirPath = join(sessionsDir, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
      for (const file of readdirSync(dirPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const path = join(dirPath, file);
        const mtimeMs = statSync(path).mtimeMs;
        if (cutoff !== null && mtimeMs < cutoff) continue;
        files.push({ path, mtimeMs });
      }
    } catch {
      continue; // unreadable dir: skip, never fail recall over it
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

/** Identify a session file: header id/cwd plus astra usage, streaming so large
 * files stop early once both identity and astra-ness are known. */
export async function identifySession(path: string, mtimeMs: number): Promise<SessionFileInfo> {
  let id = "";
  let cwd = "";
  let astra = false;
  for await (const line of iterLines(path)) {
    if (id && cwd && astra) break;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      id = String(entry.id ?? "");
      cwd = String(entry.cwd ?? "");
    } else if (isAstraMarker(entry)) {
      astra = true;
    }
  }
  return { path, id, cwd, mtimeMs, astra };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join(" ");
}

function truncate(text: string, cap: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= cap ? clean : `${clean.slice(0, cap)}…`;
}

/** Search astra sessions for a query. Summarized by default: tool hits return
 * name + truncated args/results, message hits return short excerpts. `full`
 * raises the excerpt cap. Only astra sessions are searched — other models'
 * sessions are noise for this tool and may carry unrelated secrets. */
export async function searchAstraSessions(
  sessionsDir: string,
  query: string,
  options: { full?: boolean; limit?: number; maxAgeDays?: number } = {},
): Promise<SessionSearchHit[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const limit = options.limit ?? 10;
  const cap = options.full ? FULL_EXCERPT : SUMMARIZED_EXCERPT;
  const hits: SessionSearchHit[] = [];

  for (const { path, mtimeMs } of listSessionFiles(sessionsDir, options.maxAgeDays)) {
    if (hits.length >= limit) break;
    const info = await identifySession(path, mtimeMs);
    if (!info.astra) continue;

    const fileHits: SessionSearchHit[] = [];
    for await (const line of iterLines(path)) {
      if (fileHits.length >= HITS_PER_FILE_CAP) break;
      if (!terms.every((t) => line.toLowerCase().includes(t))) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type !== "message") continue;
      const msg = entry.message as Record<string, unknown>;
      const role = msg.role as string;
      const timestamp = String(entry.timestamp ?? "");
      const base = { sessionId: info.id, project: info.cwd, timestamp };
      if (role === "user" || role === "assistant") {
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const block of content as Record<string, unknown>[]) {
            if (block.type === "toolCall") {
              const args = truncate(JSON.stringify(block.arguments ?? {}), cap);
              if (terms.every((t) => `${String(block.name)} ${args}`.toLowerCase().includes(t))) {
                fileHits.push({ ...base, kind: "toolCall", excerpt: `${String(block.name)}(${args})` });
              }
            } else if (block.type === "text" && typeof block.text === "string") {
              const text = block.text as string;
              if (terms.every((t) => text.toLowerCase().includes(t))) {
                fileHits.push({ ...base, kind: role as "user" | "assistant", excerpt: truncate(text, cap) });
              }
            }
          }
        } else {
          const text = textOf(content);
          if (terms.every((t) => text.toLowerCase().includes(t))) {
            fileHits.push({ ...base, kind: role as "user" | "assistant", excerpt: truncate(text, cap) });
          }
        }
      } else if (role === "toolResult") {
        const text = textOf(msg.content);
        if (terms.every((t) => `${String(msg.toolName ?? "")} ${text}`.toLowerCase().includes(t))) {
          fileHits.push({
            ...base,
            kind: "toolResult",
            excerpt: `${String(msg.toolName ?? "tool")} → ${truncate(text, cap)}`,
          });
        }
      }
    }
    hits.push(...fileHits);
  }
  return hits.slice(0, limit);
}

/** Compact transcript of one session for the distiller: user/assistant text
 * plus tool-call names with truncated args, tool results reduced to a short
 * marker. Full results are deliberately excluded — they are the largest and
 * least durable content, and the biggest secret-resurfacing vector. */
export async function readSessionDigest(path: string, capBytes = 60_000): Promise<string> {
  const parts: string[] = [];
  let size = 0;
  for await (const line of iterLines(path)) {
    if (size >= capBytes) {
      parts.push("… [transcript truncated]");
      break;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message as Record<string, unknown>;
    let chunk = "";
    if (msg.role === "user") chunk = `USER: ${truncate(textOf(msg.content), 1500)}`;
    else if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
      const texts = content
        .map((b) => {
          if (b.type === "text") return truncate(String(b.text ?? ""), 1500);
          if (b.type === "toolCall") return `[tool: ${String(b.name)} ${truncate(JSON.stringify(b.arguments ?? {}), 200)}]`;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      chunk = texts ? `ASSISTANT: ${texts}` : "";
    } else if (msg.role === "toolResult") {
      chunk = `[result: ${String(msg.toolName ?? "tool")}${msg.isError ? " (error)" : ""}] ${truncate(textOf(msg.content), 200)}`;
    }
    if (!chunk) continue;
    size += chunk.length;
    parts.push(chunk);
  }
  return parts.join("\n");
}
