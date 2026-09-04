import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Store layout under the pocket root:
 *   config.json          — toggles + distiller settings (config.ts)
 *   SUMMARY.md           — injected into astra's system prompt; mechanical render
 *   POCKET.md            — searchable registry, one line per note
 *   notes/<ts>-<slug>.md — append-only note files
 *   distilled.json       — distiller bookkeeping (which sessions are processed)
 */

const PINNED_START = "<!-- pocket:pinned:start -->";
const PINNED_END = "<!-- pocket:pinned:end -->";
const DIGEST_START = "<!-- pocket:digest:start -->";
const DIGEST_END = "<!-- pocket:digest:end -->";

const RECENT_NOTES_CAP = 20;
const REGISTRY_LINE_CAP = 500;
const BODY_SCAN_CAP = 200;

export function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function pocketRoot(agentDir: string = defaultAgentDir()): string {
  return join(agentDir, "astral-pocket");
}

export function notesDir(root: string): string {
  return join(root, "notes");
}

export function ensureLayout(root: string): void {
  mkdirSync(notesDir(root), { recursive: true });
  const registry = join(root, "POCKET.md");
  if (!existsSync(registry)) {
    writeFileSync(registry, "# Astral Pocket Registry\n\nOne line per note. Search this first.\n\n", "utf8");
  }
  if (!existsSync(join(root, "SUMMARY.md"))) {
    writeFileSync(join(root, "SUMMARY.md"), renderSummary(root, []), "utf8");
  }
}

export interface NoteInput {
  title: string;
  body: string;
  keywords?: string[];
  /** cwd of the session taking the note; recorded for project-aware ranking. */
  project?: string;
  source?: "agent" | "distilled";
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "note";
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

function extractSection(markdown: string, start: string, end: string): string | null {
  const i = markdown.indexOf(start);
  const j = markdown.indexOf(end);
  if (i === -1 || j === -1 || j < i) return null;
  return markdown.slice(i + start.length, j).trim();
}

/** Write one note file and update the registry + summary. Returns the note's
 * file name. Callers that need cross-file mutation safety should wrap this in
 * `withFileMutationQueue(join(root, "POCKET.md"), ...)`. */
export function writeNote(root: string, input: NoteInput, now: Date = new Date()): string {
  ensureLayout(root);
  const fileName = `${stamp(now)}-${slugify(input.title)}.md`;
  const frontmatter = [
    "---",
    `created: ${now.toISOString()}`,
    `project: ${input.project ?? "unknown"}`,
    `keywords: [${(input.keywords ?? []).join(", ")}]`,
    `source: ${input.source ?? "agent"}`,
    "---",
  ].join("\n");
  writeFileSync(join(notesDir(root), fileName), `${frontmatter}\n\n# ${input.title}\n\n${input.body.trim()}\n`, "utf8");

  const projectTag = input.project ? (input.project.split("/").filter(Boolean).pop() ?? input.project) : "unknown";
  const keywordTag = (input.keywords ?? []).join(", ");
  const line = `- [${input.title}](notes/${fileName})${keywordTag ? ` — ${keywordTag}` : ""} — ${projectTag} — ${now.toISOString().slice(0, 10)}`;
  appendRegistryLine(root, line);
  rerenderSummary(root);
  return fileName;
}

function appendRegistryLine(root: string, line: string): void {
  const registry = join(root, "POCKET.md");
  const existing = existsSync(registry) ? readFileSync(registry, "utf8") : "";
  writeFileSync(registry, `${existing.trimEnd()}\n${line}\n`, "utf8");
}

export function readRegistryLines(root: string): string[] {
  const registry = join(root, "POCKET.md");
  if (!existsSync(registry)) return [];
  return readFileSync(registry, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- ["));
}

/** Re-render SUMMARY.md mechanically: the pinned block and the
 * distiller-maintained digest block carry over verbatim from the existing
 * file; only the recent-notes index is regenerated. This is the mechanical
 * floor — it runs on every note write with zero LLM involvement. */
export function rerenderSummary(root: string): void {
  writeFileSync(join(root, "SUMMARY.md"), renderSummary(root, readRegistryLines(root)), "utf8");
}

function renderSummary(root: string, registryLines: string[]): string {
  const summaryPath = join(root, "SUMMARY.md");
  const existing = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
  const pinned = extractSection(existing, PINNED_START, PINNED_END) ?? "";
  const digest =
    extractSection(existing, DIGEST_START, DIGEST_END) ??
    "_No digest yet. It is filled in by the distiller pass; until then, rely on Recent notes and search POCKET.md._";
  const recent = registryLines.slice(-RECENT_NOTES_CAP);
  return [
    "# Astral Pocket Summary",
    "",
    PINNED_START,
    pinned,
    PINNED_END,
    "",
    "## Durable digest",
    "",
    DIGEST_START,
    digest,
    DIGEST_END,
    "",
    "## Recent notes",
    "",
    ...(recent.length > 0 ? recent : ["_No notes yet._"]),
    "",
  ].join("\n");
}

/** Replace the distiller-maintained digest block, preserving everything else.
 * Returns false when SUMMARY.md is missing the markers (never rendered). */
export function updateDigest(root: string, digest: string): boolean {
  const summaryPath = join(root, "SUMMARY.md");
  if (!existsSync(summaryPath)) return false;
  const existing = readFileSync(summaryPath, "utf8");
  const i = existing.indexOf(DIGEST_START);
  const j = existing.indexOf(DIGEST_END);
  if (i === -1 || j === -1 || j < i) return false;
  writeFileSync(summaryPath, `${existing.slice(0, i + DIGEST_START.length)}\n${digest.trim()}\n${existing.slice(j)}`, "utf8");
  return true;
}

/** The text injected into astra's system prompt, capped to keep the per-turn
 * cost bounded regardless of how large the summary grows. */
export function readSummaryCapped(root: string, capBytes = 12_000): string {
  const summaryPath = join(root, "SUMMARY.md");
  if (!existsSync(summaryPath)) return "";
  const text = readFileSync(summaryPath, "utf8");
  return text.length <= capBytes ? text : `${text.slice(0, capBytes)}\n\n_(summary truncated; search POCKET.md for older material)_`;
}

export interface PocketSearchHit {
  noteFile: string;
  title: string;
  excerpt: string;
  project: string;
}

/** Case-insensitive keyword search over the registry, then the note bodies.
 * Registry hits rank first; current-project notes rank above others. */
export function searchPocket(root: string, query: string, currentProject: string | undefined, limit: number): PocketSearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const matches = (haystack: string) => terms.every((t) => haystack.toLowerCase().includes(t));

  const hits: PocketSearchHit[] = [];
  for (const line of readRegistryLines(root).slice(-REGISTRY_LINE_CAP)) {
    if (!matches(line)) continue;
    const fileMatch = line.match(/\]\((notes\/[^)]+)\)/);
    const titleMatch = line.match(/- \[([^\]]+)\]/);
    if (!fileMatch) continue;
    hits.push({
      noteFile: fileMatch[1].replace(/^notes\//, ""),
      title: titleMatch?.[1] ?? fileMatch[1],
      excerpt: line,
      project: "",
    });
  }

  const bodyHits: PocketSearchHit[] = [];
  // Timestamp-prefixed names sort chronologically; cap the body scan at the
  // newest files so recall stays fast as the store grows.
  const files = readdirSync(notesDir(root))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .slice(-BODY_SCAN_CAP);
  for (const file of files) {
    if (hits.some((h) => h.noteFile === file)) continue;
    const text = readFileSync(join(notesDir(root), file), "utf8");
    if (!matches(text)) continue;
    const project = text.match(/^project: (.+)$/m)?.[1] ?? "";
    const title = text.match(/^# (.+)$/m)?.[1] ?? file;
    const idx = text.toLowerCase().indexOf(terms[0]);
    bodyHits.push({
      noteFile: file,
      title,
      excerpt: text.slice(Math.max(0, idx - 120), idx + 280).trim(),
      project,
    });
  }

  const currentTag = currentProject?.split("/").filter(Boolean).pop();
  const ranked = [...hits, ...bodyHits].sort((a, b) => {
    const aCur = currentTag && a.project.endsWith(currentTag) ? 1 : 0;
    const bCur = currentTag && b.project.endsWith(currentTag) ? 1 : 0;
    return bCur - aCur;
  });
  return ranked.slice(0, limit);
}
