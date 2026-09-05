import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import type { ActivationState } from "./activation.js";
import { resolveProjectIdentity } from "./scope.js";
import { searchAstraSessions } from "./sessions.js";
import { readSummaryCapped, searchPocket, writeNote } from "./store.js";

const INACTIVE_MESSAGE =
  "Pocket tools are only active in gpt-6-astra sessions with the pocket enabled (/pocket on).";
const DEFAULT_RECALL_LIMIT = 10;
export const MAX_RECALL_LIMIT_PER_SOURCE = 20;

function normalizeRecallLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RECALL_LIMIT;
  return Math.min(MAX_RECALL_LIMIT_PER_SOURCE, Math.max(1, Math.trunc(value)));
}

export interface ToolDeps {
  state: ActivationState;
  /** Pocket root directory (~/.pi/agent/astral-pocket). */
  root: string;
  /** Sessions directory (~/.pi/agent/sessions). */
  sessionsDir: string;
  maxSessionAgeDays: () => number;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function registerPocketTools(pi: ExtensionAPI, deps: ToolDeps): void {
  pi.registerTool({
    name: "pocket_note",
    label: "Pocket Note",
    description:
      "Write a durable note to your persistent pocket. Notes default to the current repository. Use global scope only for explicitly portable preferences or observations — never for secrets or ephemeral task state.",
    promptSnippet: "Save a durable cross-session note to the astral pocket",
    promptGuidelines: [
      "Use pocket_note when you learn something durable (a decision and why, a project convention, a pitfall, a user preference) — not for ephemeral task state.",
      "Never put secrets, credentials, tokens, or personal data in pocket notes.",
      "Keep pocket_note project-scoped by default; use global scope only for a clearly general preference or conditional portable observation.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short note title" }),
      body: Type.String({ description: "Note content — a few sentences is enough" }),
      keywords: Type.Optional(Type.Array(Type.String(), { description: "2-5 recall keywords" })),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], {
        description: "Project by default. Use global only for explicitly portable preferences or observations.",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!deps.state.active) throw new Error(INACTIVE_MESSAGE);
      if (signal?.aborted) throw new Error("Pocket note cancelled");
      const project = ctx.cwd;
      const scope = params.scope ?? "project";
      const projectId = resolveProjectIdentity(project);
      const fileName = await withFileMutationQueue(join(deps.root, "POCKET.md"), async () => {
        if (signal?.aborted || !deps.state.active) throw new Error("Pocket note cancelled");
        return writeNote(deps.root, {
          title: params.title,
          body: params.body,
          keywords: params.keywords,
          project,
          projectId: scope === "project" ? projectId : undefined,
          scope,
          source: "agent",
        });
      });
      return textResult(`Note saved to the pocket: notes/${fileName}`);
    },
  });

  pi.registerTool({
    name: "pocket_recall",
    label: "Pocket Recall",
    description:
      "Search current-repository and explicit global pocket notes plus current-repository Astra sessions. Summarized by default; pass full: true for larger excerpts or scope: all for intentional cross-repository precedent.",
    promptSnippet: "Search pocket notes and past astra sessions",
    promptGuidelines: [
      "Use pocket_recall for the quick pocket pass: search with keywords from the pocket summary before deep repo exploration.",
      "Keep recall cheap: at most 4-6 lookup steps, summarized results first, full: true only when you need exact commands or error text.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Keywords to search for (all must match)" }),
      source: Type.Optional(
        Type.Union([Type.Literal("pocket"), Type.Literal("sessions"), Type.Literal("both")], {
          description: "Where to search (default: both)",
        }),
      ),
      full: Type.Optional(Type.Boolean({ description: "Return larger excerpts (default: false)" })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_RECALL_LIMIT_PER_SOURCE,
        description: "Max hits from each source (default: 10, maximum: 20)",
      })),
      scope: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("all")], {
        description: "Current repository plus global notes by default; all includes foreign repositories as precedent.",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!deps.state.active) throw new Error(INACTIVE_MESSAGE);
      const source = params.source ?? "both";
      const limit = normalizeRecallLimit(params.limit);
      const recallScope = params.scope ?? "current";
      const projectId = resolveProjectIdentity(ctx.cwd);
      const sections: string[] = [];

      if (source === "pocket" || source === "both") {
        const hits = searchPocket(deps.root, params.query, projectId, limit, params.full, recallScope);
        sections.push(
          hits.length === 0
            ? "Pocket notes: no matches."
            : `Pocket notes (${hits.length}):\n${hits
                .map((h) => `- ${h.title} [notes/${h.noteFile}]${h.project ? ` (${h.project})` : ""} · scope: ${h.scope}${recallScope === "all" && h.scope === "project" && resolveProjectIdentity(h.project) !== projectId ? " · cross-repository precedent" : ""}${h.source ? ` · ${h.source}` : ""}${h.date ? ` · ${h.date}` : ""}\n  ${h.excerpt}`)
                .join("\n")}`,
        );
      }

      if (source === "sessions" || source === "both") {
        const hits = await searchAstraSessions(deps.sessionsDir, params.query, {
          full: params.full,
          limit,
          maxAgeDays: deps.maxSessionAgeDays(),
          projectId,
          recallScope,
        });
        sections.push(
          hits.length === 0
            ? "Past astra sessions: no matches."
            : `Past astra sessions (${hits.length}):\n${hits
                .map((h) => `- [${h.kind}] ${h.timestamp} (${h.project})${recallScope === "all" && resolveProjectIdentity(h.project) !== projectId ? " · cross-repository precedent" : ""}\n  ${h.excerpt}`)
                .join("\n")}`,
        );
      }

      return textResult(sections.join("\n\n"));
    },
  });
}
