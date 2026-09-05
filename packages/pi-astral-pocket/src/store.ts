import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveProjectIdentity } from "./scope.js";

const PINNED_START = "<!-- pocket:pinned:start -->";
const PINNED_END = "<!-- pocket:pinned:end -->";
const DIGEST_START = "<!-- pocket:digest:start -->";
const DIGEST_END = "<!-- pocket:digest:end -->";
const RECENT_NOTES_CAP = 20;
const NOTE_EXCERPT = 320;
const FULL_NOTE_EXCERPT = 4_000;
const DIGEST_NOTE_CAP = 200;
const DIGEST_NOTE_BYTES = 2_000;

export function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function pocketRoot(agentDir: string = defaultAgentDir()): string {
  return join(agentDir, "astral-pocket");
}

export function notesDir(root: string): string {
  return join(root, "notes");
}

function atomicWrite(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, contents, "utf8");
  renameSync(temporary, path);
}

export function ensureLayout(root: string): void {
  mkdirSync(notesDir(root), { recursive: true });
  const registry = join(root, "POCKET.md");
  if (!existsSync(registry)) atomicWrite(registry, renderRegistry([]));
  if (!existsSync(join(root, "SUMMARY.md"))) atomicWrite(join(root, "SUMMARY.md"), renderSummary(root, []));
}

export type NoteScope = "project" | "global";

export interface NoteInput {
  title: string;
  body: string;
  keywords?: string[];
  project?: string;
  projectId?: string;
  scope?: NoteScope;
  source?: "agent" | "distilled";
}

export interface GeneratedNoteInput extends NoteInput {
  sessionId: string;
  sourcePath: string;
  sourceUpdatedAt: string;
  sourceSize: number;
  sourceRevision: string;
}

interface StoredNote {
  fileName: string;
  title: string;
  text: string;
  body: string;
  project: string;
  projectId: string;
  scope: NoteScope | "unknown";
  source: string;
  created: string;
  updated: string;
}

function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "note";
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function extractSection(markdown: string, start: string, end: string): string | null {
  const i = markdown.indexOf(start);
  const j = markdown.indexOf(end);
  if (i === -1 || j === -1 || j < i) return null;
  return markdown.slice(i + start.length, j).trim();
}

function field(text: string, name: string): string {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  return frontmatter.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim() ?? "";
}

function noteTimestamp(note: StoredNote): number {
  const parsed = Date.parse(note.updated || note.created);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function compareNotesByTime(a: StoredNote, b: StoredNote): number {
  const aTime = noteTimestamp(a);
  const bTime = noteTimestamp(b);
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  // Prefer deliberate and legacy notes at a time tie so a batch of generated
  // notes cannot crowd them out solely because session hashes sort later.
  const manualRank = Number(a.source !== "distilled") - Number(b.source !== "distilled");
  return manualRank || a.fileName.localeCompare(b.fileName);
}

function readStoredNotes(root: string): StoredNote[] {
  if (!existsSync(notesDir(root))) return [];
  const notes: StoredNote[] = [];
  for (const fileName of readdirSync(notesDir(root)).filter((name) => name.endsWith(".md"))) {
    try {
      const text = readFileSync(join(notesDir(root), fileName), "utf8");
      const heading = text.match(/^# (.+)$/m)?.[1] ?? fileName;
      const headingAt = text.search(/^# .+$/m);
      const project = field(text, "project");
      const declaredScope = field(text, "scope");
      const scope: NoteScope | "unknown" = declaredScope === "global"
        ? "global"
        : declaredScope === "project" || (declaredScope === "" && project !== "" && project !== "unknown")
          ? "project"
          : "unknown";
      notes.push({
        fileName,
        title: heading,
        text,
        body: headingAt >= 0 ? text.slice(headingAt).replace(/^# .+\n+/, "").trim() : text.trim(),
        project,
        projectId: field(text, "project_id") || (scope === "project" && project !== "" && project !== "unknown" ? resolveProjectIdentity(project) : ""),
        scope,
        source: field(text, "source") || "legacy",
        created: field(text, "created"),
        updated: field(text, "updated") || field(text, "source_updated_at") || field(text, "created"),
      });
    } catch {
      // One unreadable note must not hide the remaining canonical note files.
    }
  }
  return notes.sort(compareNotesByTime);
}

function noteMarkdown(input: NoteInput, metadata: string[], created: Date, updated: Date = created): string {
  return [
    "---",
    `created: ${created.toISOString()}`,
    `updated: ${updated.toISOString()}`,
    `project: ${input.project ?? "unknown"}`,
    `project_id: ${input.projectId ?? ""}`,
    `scope: ${input.scope ?? "project"}`,
    `keywords: [${(input.keywords ?? []).join(", ")}]`,
    `source: ${input.source ?? "agent"}`,
    ...metadata,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

function uniqueManualFile(root: string, input: NoteInput, now: Date): string {
  const base = `${stamp(now)}-${slugify(input.title)}`;
  let fileName = `${base}.md`;
  let suffix = 2;
  while (existsSync(join(notesDir(root), fileName))) fileName = `${base}-${suffix++}.md`;
  return fileName;
}

/** Write one deliberate note. Call inside the POCKET.md mutation queue. */
export function writeNote(root: string, input: NoteInput, now: Date = new Date()): string {
  ensureLayout(root);
  const fileName = uniqueManualFile(root, input, now);
  atomicWrite(join(notesDir(root), fileName), noteMarkdown(input, [], now));
  rebuildDerivedStore(root);
  return fileName;
}

export function generatedNoteFile(sessionId: string): string {
  const identity = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return `session-${identity}.md`;
}

/** Replace the one generated note owned by a session revision. */
export function writeGeneratedNote(root: string, input: GeneratedNoteInput, now: Date = new Date()): string {
  ensureLayout(root);
  const fileName = generatedNoteFile(input.sessionId);
  const existingPath = join(notesDir(root), fileName);
  let created = now;
  if (existsSync(existingPath)) {
    const previousCreated = field(readFileSync(existingPath, "utf8"), "created");
    if (previousCreated && !Number.isNaN(Date.parse(previousCreated))) created = new Date(previousCreated);
  }
  atomicWrite(existingPath, noteMarkdown(input, [
    `session_id: ${input.sessionId}`,
    `source_path: ${input.sourcePath}`,
    `source_updated_at: ${input.sourceUpdatedAt}`,
    `source_size: ${input.sourceSize}`,
    `source_revision: ${input.sourceRevision}`,
  ], created, now));
  rebuildDerivedStore(root);
  return fileName;
}

export function removeGeneratedNote(root: string, sessionId: string): boolean {
  const path = join(notesDir(root), generatedNoteFile(sessionId));
  if (!existsSync(path)) return false;
  rmSync(path);
  rebuildDerivedStore(root);
  return true;
}

function registryLine(note: StoredNote): string {
  const project = note.scope === "global"
    ? "global"
    : (note.project.split("/").filter(Boolean).pop() ?? note.project) || "unknown";
  const date = (note.updated || note.created).slice(0, 10) || "unknown-date";
  return `- [${note.title}](notes/${note.fileName}) — ${note.scope} — ${project} — ${date}`;
}

function renderRegistry(notes: StoredNote[]): string {
  return [
    "# Astral Pocket Registry",
    "",
    "Derived from the canonical Markdown files in `notes/`. Search this first.",
    "",
    ...notes.map(registryLine),
    "",
  ].join("\n");
}

export function countNotes(root: string): number {
  return readStoredNotes(root).length;
}

export function readRegistryLines(root: string): string[] {
  const registry = join(root, "POCKET.md");
  if (!existsSync(registry)) return [];
  return readFileSync(registry, "utf8").split("\n").filter((line) => line.startsWith("- ["));
}

/** Rebuildable indexes are rendered from note files, never treated as note authority. */
export function rebuildDerivedStore(root: string): void {
  const notes = readStoredNotes(root);
  atomicWrite(join(root, "POCKET.md"), renderRegistry(notes));
  atomicWrite(join(root, "SUMMARY.md"), renderSummary(root, notes.map(registryLine)));
}

export const rerenderSummary = rebuildDerivedStore;

function renderSummary(root: string, registryLines: string[]): string {
  const summaryPath = join(root, "SUMMARY.md");
  const existing = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
  const pinned = extractSection(existing, PINNED_START, PINNED_END) ?? "";
  const digest = extractSection(existing, DIGEST_START, DIGEST_END) ??
    "_No digest yet. It is filled in by the distiller pass; until then, rely on Recent notes and search POCKET.md._";
  const recent = registryLines.slice(-RECENT_NOTES_CAP);
  return [
    "# Astral Pocket Summary", "", PINNED_START, pinned, PINNED_END, "",
    "## Durable digest", "", DIGEST_START, digest, DIGEST_END, "",
    "## Recent notes", "", ...(recent.length > 0 ? recent : ["_No notes yet._"]), "",
  ].join("\n");
}

export function updateDigest(root: string, digest: string): boolean {
  const summaryPath = join(root, "SUMMARY.md");
  if (!existsSync(summaryPath)) return false;
  const existing = readFileSync(summaryPath, "utf8");
  const i = existing.indexOf(DIGEST_START);
  const j = existing.indexOf(DIGEST_END);
  if (i === -1 || j === -1 || j < i) return false;
  atomicWrite(summaryPath, `${existing.slice(0, i + DIGEST_START.length)}\n${digest.trim()}\n${existing.slice(j)}`);
  return true;
}

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
  projectId: string;
  source: string;
  scope: NoteScope | "unknown";
  date: string;
}

/** Search complete canonical note content, then truncate only the returned excerpt. */
export function searchPocket(
  root: string,
  query: string,
  currentProject: string | undefined,
  limit: number,
  full = false,
  recallScope: "current" | "all" = "current",
): PocketSearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const cap = full ? FULL_NOTE_EXCERPT : NOTE_EXCERPT;
  const hits = readStoredNotes(root)
    .filter((note) => recallScope === "all" || note.scope === "global" || (note.scope === "project" && note.projectId === currentProject))
    .filter((note) => terms.every((term) => note.text.toLowerCase().includes(term))).map((note) => {
    const lowerBody = note.body.toLowerCase();
    const bodyMatches = terms.map((term) => lowerBody.indexOf(term)).filter((at) => at >= 0);
    const at = bodyMatches.length > 0 ? Math.min(...bodyMatches) : 0;
    const start = Math.max(0, at - Math.floor(cap / 4));
    const excerpt = note.body.slice(start, start + cap).trim();
    return {
      noteFile: note.fileName,
      title: note.title,
      excerpt: excerpt.length < note.body.slice(start).trim().length ? `${excerpt}…` : excerpt,
      project: note.project,
      projectId: note.projectId,
      source: note.source,
      scope: note.scope,
      date: note.updated || note.created,
    };
  });
  hits.sort((a, b) => {
    const projectRank = Number(b.projectId === currentProject) - Number(a.projectId === currentProject);
    const globalRank = Number(b.scope === "global") - Number(a.scope === "global");
    return projectRank || globalRank || b.date.localeCompare(a.date) || b.noteFile.localeCompare(a.noteFile);
  });
  return hits.slice(0, Math.max(1, limit));
}

export interface DigestSnapshot {
  fingerprint: string;
  promptSource: string;
  noteCount: number;
}

export type DigestScope = { kind: "project"; projectId: string } | { kind: "global" };

export function digestScopeKey(scope: DigestScope): string {
  return scope.kind === "global"
    ? "global"
    : `project:${createHash("sha256").update(scope.projectId).digest("hex").slice(0, 24)}`;
}

function digestPath(root: string, scope: DigestScope): string {
  return join(root, "digests", `${digestScopeKey(scope).replace(":", "-")}.md`);
}

export function scopedDigestExists(root: string, scope: DigestScope): boolean {
  return existsSync(digestPath(root, scope));
}

function successfulDigestFingerprint(root: string, scope: DigestScope): string | undefined {
  try {
    const state = JSON.parse(readFileSync(join(root, "distilled.json"), "utf8")) as { digestFingerprints?: Record<string, unknown> };
    const value = state.digestFingerprints?.[digestScopeKey(scope)];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function updateScopedDigest(root: string, scope: DigestScope, digest: string): void {
  mkdirSync(join(root, "digests"), { recursive: true });
  atomicWrite(digestPath(root, scope), `${digest.trim()}\n`);
}

/** Build injected context only from the current project and explicit global notes. */
export function readScopedSummary(root: string, projectId: string, capBytes = 12_000): string {
  const renderLayer = (scope: DigestScope, heading: string, layerCap: number): string => {
    const notes = readStoredNotes(root).filter((note) =>
      scope.kind === "global" ? note.scope === "global" : note.scope === "project" && note.projectId === scope.projectId,
    );
    let digest = "";
    const currentFingerprint = createDigestSnapshot(root, scope).fingerprint;
    if (successfulDigestFingerprint(root, scope) === currentFingerprint) {
      try { digest = readFileSync(digestPath(root, scope), "utf8").trim(); } catch { /* derived cache may lag */ }
    }
    const recent = notes.slice(-RECENT_NOTES_CAP).map(registryLine);
    const layer = [
      `## ${heading}`,
      "",
      digest || "_No digest is available; use the source-linked recent notes below._",
      "",
      "### Recent source notes",
      ...(recent.length > 0 ? recent : ["_None._"]),
    ].join("\n");
    return layer.length <= layerCap
      ? layer
      : `${layer.slice(0, layerCap)}\n_(layer truncated; use pocket_recall for source notes)_`;
  };
  const globalCap = Math.max(1_500, Math.floor(capBytes / 4));
  const projectCap = Math.max(1_500, capBytes - globalCap - 40);
  return [
    "# Astral Pocket Summary",
    "",
    renderLayer({ kind: "project", projectId }, "Current repository memory", projectCap),
    "",
    renderLayer({ kind: "global" }, "Explicit global memory", globalCap),
  ].join("\n");
}

/** Bounded, source-linked digest input built from notes rather than SUMMARY.md. */
export function createDigestSnapshot(root: string, scope: DigestScope): DigestSnapshot {
  const notes = readStoredNotes(root)
    .filter((note) => scope.kind === "global" ? note.scope === "global" : note.scope === "project" && note.projectId === scope.projectId)
    .slice(-DIGEST_NOTE_CAP);
  const promptSource = notes.map((note) => [
    `NOTE: notes/${note.fileName}`,
    `TITLE: ${note.title}`,
    `PROJECT: ${note.project || "unknown"}`,
    `SOURCE: ${note.source || "legacy"}`,
    `DATE: ${note.updated || note.created || "unknown"}`,
    note.body.slice(0, DIGEST_NOTE_BYTES),
  ].join("\n")).join("\n\n");
  return {
    fingerprint: createHash("sha256").update(promptSource).digest("hex"),
    promptSource,
    noteCount: notes.length,
  };
}
