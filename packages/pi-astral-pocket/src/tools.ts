import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import type { ActivationState } from "./activation.js";
import { searchAstraSessions } from "./sessions.js";
import { readSummaryCapped, searchPocket, writeNote } from "./store.js";

const INACTIVE_MESSAGE =
  "Pocket tools are only active in gpt-6-astra sessions with the pocket enabled (/pocket on).";

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
      "Write a durable note to your persistent pocket. Notes survive across sessions. Use for decisions, conventions, pitfalls, and preferences worth remembering — never for secrets or ephemeral task state.",
    promptSnippet: "Save a durable cross-session note to the astral pocket",
    promptGuidelines: [
      "Use pocket_note when you learn something durable (a decision and why, a project convention, a pitfall, a user preference) — not for ephemeral task state.",
      "Never put secrets, credentials, tokens, or personal data in pocket notes.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short note title" }),
      body: Type.String({ description: "Note content — a few sentences is enough" }),
      keywords: Type.Optional(Type.Array(Type.String(), { description: "2-5 recall keywords" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!deps.state.active) throw new Error(INACTIVE_MESSAGE);
      const fileName = await withFileMutationQueue(join(deps.root, "POCKET.md"), async () =>
        writeNote(deps.root, {
          title: params.title,
          body: params.body,
          keywords: params.keywords,
          project: ctx.cwd,
          source: "agent",
        }),
      );
      return textResult(`Note saved to the pocket: notes/${fileName}`);
    },
  });

  pi.registerTool({
    name: "pocket_recall",
    label: "Pocket Recall",
    description:
      "Search your persistent pocket notes and your past gpt-6-astra sessions. Summarized by default (tool names + truncated args/results); pass full: true for larger excerpts. Past-session output can contain sensitive data from earlier work — prefer summarized results.",
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
      limit: Type.Optional(Type.Number({ description: "Max hits (default: 10)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!deps.state.active) throw new Error(INACTIVE_MESSAGE);
      const source = params.source ?? "both";
      const limit = params.limit ?? 10;
      const sections: string[] = [];

      if (source === "pocket" || source === "both") {
        const hits = searchPocket(deps.root, params.query, ctx.cwd, limit);
        sections.push(
          hits.length === 0
            ? "Pocket notes: no matches."
            : `Pocket notes (${hits.length}):\n${hits
                .map((h) => `- ${h.title} [notes/${h.noteFile}]${h.project ? ` (${h.project})` : ""}\n  ${h.excerpt}`)
                .join("\n")}`,
        );
      }

      if (source === "sessions" || source === "both") {
        const hits = await searchAstraSessions(deps.sessionsDir, params.query, {
          full: params.full,
          limit,
          maxAgeDays: deps.maxSessionAgeDays(),
        });
        sections.push(
          hits.length === 0
            ? "Past astra sessions: no matches."
            : `Past astra sessions (${hits.length}):\n${hits
                .map((h) => `- [${h.kind}] ${h.timestamp} (${h.project})\n  ${h.excerpt}`)
                .join("\n")}`,
        );
      }

      return textResult(sections.join("\n\n"));
    },
  });
}
