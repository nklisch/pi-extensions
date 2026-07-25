import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AutoReviewerCommandDependencies } from "./types.ts";

const TUNE_STATUS_KEY = "clearance-tune";

export type TuneCueUpdateResult =
  | {
      readonly kind: "status";
      readonly active: boolean;
      readonly key: typeof TUNE_STATUS_KEY;
      readonly label: string | undefined;
    }
  | {
      readonly kind: "none";
      readonly active: boolean;
      readonly reason: "ui-unavailable" | "chrome-unavailable";
    };

interface TuneStatusCapableUi {
  readonly setStatus?: (key: string, value: string | undefined) => void;
}

export function formatTuneCueStatus(active: boolean): string {
  return active ? "Tune active" : "Tune inactive";
}

export function updateTuneActiveCue(
  ctx: ExtensionCommandContext,
  deps: Pick<AutoReviewerCommandDependencies, "manager">,
): TuneCueUpdateResult {
  const active = deps.manager.isRatchetActive();
  if (ctx.hasUI !== true) {
    return { kind: "none", active, reason: "ui-unavailable" };
  }

  const ui = ctx.ui as TuneStatusCapableUi | undefined;
  if (typeof ui?.setStatus === "function") {
    const label = active ? formatTuneCueStatus(active) : undefined;
    try {
      ui.setStatus(TUNE_STATUS_KEY, label);
      return { kind: "status", active, key: TUNE_STATUS_KEY, label };
    } catch {
      // The command report carries the state. A failed chrome update must not
      // affect Tune activation or claim a visual cue that was not rendered.
    }
  }

  return { kind: "none", active, reason: "chrome-unavailable" };
}
