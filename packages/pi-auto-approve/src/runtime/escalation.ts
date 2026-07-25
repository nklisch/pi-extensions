import type { ToolShape } from "../parse/shape.ts";
import { primaryExecutableFromShape } from "../parse/shape-utils.ts";
import { parseDurationToMs } from "./duration.ts";

/** The default escalation window in ms, used when escalation.window is unparseable. */
export const DEFAULT_ESCALATION_WINDOW_MS = 10 * 60 * 1000;

/**
 * Config slice the tracker reads per call.
 *
 * This intentionally mirrors ResolvedReviewerConfig["escalation"] without importing config
 * internals, keeping the runtime decision path behind a small port.
 */
export interface EscalationConfig {
  readonly enabled: boolean;
  readonly denialLimit: number;
  readonly window: string;
}

/** Port: dispatch depends on escalation behavior, not on a concrete storage strategy. */
export interface EscalationTracker {
  /** True iff the family has at least denialLimit in-window contention events. */
  isEscalated(family: string, config: EscalationConfig): boolean;
  /** Record one non-allow reviewer outcome for the family. */
  recordContention(family: string, config: EscalationConfig): void;
}

export interface EscalationTrackerOptions {
  readonly clock?: () => Date;
}

/** Derive the escalation family key for a dispatch. */
export function escalationFamily(shape: ToolShape, toolName: string): string {
  return primaryExecutableFromShape(shape) ?? toolName;
}

/**
 * Construct an in-process, window-decayed escalation tracker.
 *
 * State persists across calls, while the threshold and window are read live from the config
 * passed to each method so ratchet-applied config changes take effect without restart.
 */
export function createInProcessEscalationTracker(
  options: EscalationTrackerOptions = {},
): EscalationTracker {
  const clock = options.clock ?? (() => new Date());
  const contentionByFamily = new Map<string, number[]>();

  const active = (config: EscalationConfig): boolean =>
    config.enabled && config.denialLimit >= 1;

  const windowMsFor = (config: EscalationConfig): number =>
    parseDurationToMs(config.window) ?? DEFAULT_ESCALATION_WINDOW_MS;

  const prune = (
    family: string,
    now: number,
    windowMs: number,
  ): readonly number[] => {
    const entries = contentionByFamily.get(family);
    if (entries === undefined) return [];

    const cutoff = now - windowMs;
    let writeIndex = 0;

    for (const timestamp of entries) {
      if (timestamp >= cutoff) {
        entries[writeIndex] = timestamp;
        writeIndex += 1;
      }
    }

    entries.length = writeIndex;
    if (entries.length === 0) {
      contentionByFamily.delete(family);
    }

    return entries;
  };

  return {
    isEscalated(family, config) {
      if (!active(config)) return false;

      const now = clock().getTime();
      const entries = prune(family, now, windowMsFor(config));
      return entries.length >= config.denialLimit;
    },

    recordContention(family, config) {
      if (!active(config)) return;

      const now = clock().getTime();
      const entries = contentionByFamily.get(family);
      if (entries === undefined) {
        contentionByFamily.set(family, [now]);
      } else {
        entries.push(now);
      }

      prune(family, now, windowMsFor(config));
    },
  };
}
