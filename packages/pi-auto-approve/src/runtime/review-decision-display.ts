import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ResolvedReviewNotePreference } from "../config/loader.ts";
import type { ReviewDecisionNote } from "./review-visibility.ts";

export type ReviewDecisionDisplayCapability =
  | "tool-call-accent"
  | "stream-widget"
  | "status-notify"
  | "none";

export interface ReviewDecisionDisplay {
  /** Strongest surface discovered for the bound ctx. */
  readonly capability: ReviewDecisionDisplayCapability;
  readonly present: (note: ReviewDecisionNote, toolCallId: string) => void;
}

interface ReviewDecisionUiShape {
  readonly setToolCallAccent?: (
    toolCallId: string,
    accent: "clearance-gold" | undefined,
  ) => void;
  readonly setWidget?: (
    key: string,
    content: string | undefined,
    options?: { readonly tone?: "info"; readonly source?: string },
  ) => void;
  readonly notify?: (message: string, level?: "info" | "warning") => void;
}

const REVIEW_DECISION_WIDGET_KEY = "auto-reviewer:review-note";
const CAPABILITY_CACHE = new WeakMap<object, ReviewDecisionDisplayCapability>();

export function detectReviewDecisionDisplayCapability(
  ctx: ExtensionContext,
): ReviewDecisionDisplayCapability {
  const cached = CAPABILITY_CACHE.get(ctx);
  if (cached !== undefined) return cached;

  const capability = detectUncachedReviewDecisionDisplayCapability(ctx);
  CAPABILITY_CACHE.set(ctx, capability);
  return capability;
}

export function createReviewDecisionDisplay(
  ctx: ExtensionContext,
  preference: ResolvedReviewNotePreference,
): ReviewDecisionDisplay {
  // The formatter has already applied the preference to the note. Keeping the
  // resolved preference in this factory signature makes the runtime seam explicit
  // for handler wiring and future capability diagnostics without re-deriving mode
  // semantics in the UI adapter.
  void preference;

  const capability = detectReviewDecisionDisplayCapability(ctx);
  return {
    capability,
    present(note, toolCallId) {
      presentReviewDecisionNote(ctx, capability, note, toolCallId);
    },
  };
}

function detectUncachedReviewDecisionDisplayCapability(
  ctx: ExtensionContext,
): ReviewDecisionDisplayCapability {
  if (ctx.hasUI !== true) return "none";

  const ui = ctx.ui as ReviewDecisionUiShape | undefined;
  if (typeof ui?.setToolCallAccent === "function") {
    return "tool-call-accent";
  }
  if (typeof ui?.setWidget === "function") return "stream-widget";
  if (typeof ui?.notify === "function") return "status-notify";
  return "none";
}

function presentReviewDecisionNote(
  ctx: ExtensionContext,
  capability: ReviewDecisionDisplayCapability,
  note: ReviewDecisionNote,
  toolCallId: string,
): void {
  if (ctx.hasUI !== true || capability === "none") return;

  const ui = ctx.ui as ReviewDecisionUiShape | undefined;
  if (
    capability === "tool-call-accent" &&
    note.accent === "clearance-gold" &&
    typeof ui?.setToolCallAccent === "function"
  ) {
    try {
      ui.setToolCallAccent(toolCallId, "clearance-gold");
    } catch {
      // Visibility is advisory and must never alter allow/deny behavior.
    }
  }

  const content = noteContent(note);
  if (content === undefined) {
    // accent-only mode on a host without the accent API would render nothing
    // at all; fall back to a minimal marker so an allow still surfaces once.
    if (note.accent === "clearance-gold" && capability !== "tool-call-accent") {
      emitText(ui, "Clearance: allowed");
    }
    return;
  }

  emitText(ui, content);
}

function emitText(ui: ReviewDecisionUiShape | undefined, content: string): void {
  if (typeof ui?.setWidget === "function") {
    try {
      ui.setWidget(REVIEW_DECISION_WIDGET_KEY, content, {
        tone: "info",
        source: "pi-clearance",
      });
    } catch {
      // Visibility is advisory and must never alter allow/deny behavior.
    }
    return;
  }

  if (typeof ui?.notify === "function") {
    try {
      ui.notify(content, "info");
    } catch {
      // Visibility is advisory and must never alter allow/deny behavior.
    }
  }
}

function noteContent(note: ReviewDecisionNote): string | undefined {
  const parts = [note.text, note.detail]
    .filter((part): part is string => part !== undefined)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? undefined : parts.join("\n");
}
