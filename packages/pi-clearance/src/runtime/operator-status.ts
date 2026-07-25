import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type NativeHealth, nativeHealthLabel } from "../native/loader.ts";
import { buildAutoReviewerStatusView } from "./auto-reviewer-read-models.ts";
import type { ResolvedPolicy } from "./policy-cache.ts";
import type { RatchetModeManager } from "./ratchet-mode.ts";
import type { CompactReviewSummary } from "./review-visibility.ts";
import {
  formatStatusLine,
  type StatusLineFg,
  styleStatusLineMode,
} from "./review-visibility.ts";

export interface OperatorStatusController {
  readonly refresh: (ctx: ExtensionContext, policy: ResolvedPolicy) => void;
  readonly beginReview: (
    ctx: ExtensionContext,
    summary: CompactReviewSummary,
  ) => void;
  readonly endReview: (ctx: ExtensionContext) => void;
  readonly clear: (ctx: ExtensionContext) => void;
}

interface StatusCapableUi {
  readonly setStatus?: (key: string, value: string | undefined) => void;
  readonly theme?: { readonly fg?: StatusLineFg };
}

const STATUS_KEY = "auto-reviewer";
const NATIVE_STATUS_KEY = "clearance-native";
const REVIEWING_LABEL_LIMIT = 120;

export function createOperatorStatusController(input: {
  readonly ratchetModeManager: RatchetModeManager;
  /** S0 activation diagnostic; native health is not part of decisions yet. */
  readonly nativeHealth?: NativeHealth;
}): OperatorStatusController {
  const baselines = new WeakMap<object, string>();

  return {
    refresh(ctx, policy) {
      const view = buildAutoReviewerStatusView({
        ctx,
        policy,
        ratchet: input.ratchetModeManager.getStatus(),
      });
      const label = styleStatusLineMode(
        formatStatusLine(view),
        view.mode,
        themeFg(ctx),
      );
      baselines.set(ctx, label);
      setStatus(ctx, label);
      if (input.nativeHealth !== undefined) {
        setStatus(
          ctx,
          nativeHealthLabel(input.nativeHealth),
          NATIVE_STATUS_KEY,
        );
      }
    },

    beginReview(ctx, summary) {
      setStatus(ctx, reviewingLabel(summary));
    },

    endReview(ctx) {
      const baseline = baselines.get(ctx);
      if (baseline !== undefined) {
        setStatus(ctx, baseline);
      }
    },

    clear(ctx) {
      baselines.delete(ctx);
      setStatus(ctx, undefined);
      setStatus(ctx, undefined, NATIVE_STATUS_KEY);
    },
  };
}

function reviewingLabel(summary: CompactReviewSummary): string {
  return truncateOneLine(
    `auto-reviewer: reviewing via ${summary.reviewerModeLabel} · ${summary.toolLabel}`,
    REVIEWING_LABEL_LIMIT,
  );
}

/**
 * Resolve the theme fg defensively. The identity fallback keeps the status
 * line functional when the host UI exposes no theme (or a partial one).
 */
function themeFg(ctx: ExtensionContext): StatusLineFg {
  const fg = (ctx.ui as StatusCapableUi | undefined)?.theme?.fg;
  if (typeof fg !== "function") return (_color, text) => text;
  return (color, text) => {
    try {
      return fg(color, text);
    } catch {
      return text;
    }
  };
}

function setStatus(
  ctx: ExtensionContext,
  label: string | undefined,
  key = STATUS_KEY,
): void {
  if (ctx.hasUI !== true) return;

  const setStatusFn = (ctx.ui as StatusCapableUi | undefined)?.setStatus;
  if (typeof setStatusFn !== "function") return;

  try {
    setStatusFn.call(ctx.ui, key, label);
  } catch {
    // Operator visibility is advisory. It must never alter approval behavior.
  }
}

function truncateOneLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
