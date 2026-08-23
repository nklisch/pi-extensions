import type { NativeAutomaticUpdateRunResult } from "./native-update-contract.js";

type AutomaticRunOutcome = NativeAutomaticUpdateRunResult["outcomes"][number];

/**
 * Plain-language presentation for update runs: every line says what happened
 * to a named plugin and what (if anything) the user must do.
 */
export function automaticRunHumanLines(outcomes: readonly AutomaticRunOutcome[]): readonly string[] {
  if (outcomes.length === 0) return Object.freeze(["No plugin updates needed."]);
  const deferred = outcomes.filter((outcome) => outcome.kind === "live-next-start").length;
  const applied = outcomes.filter((outcome) => outcome.kind === "applied").length;
  const settled = deferred + applied + outcomes.filter((outcome) => outcome.kind === "current").length;
  const attention = outcomes.length - settled;
  const summary: string[] = [];
  const done = deferred + applied;
  if (done > 0) {
    summary.push(`${done} update${done === 1 ? "" : "s"} installed${deferred > 0 ? " — live next start" : ""}`);
  }
  if (attention > 0) summary.push(`${attention} need${attention === 1 ? "s" : ""} your attention`);
  if (summary.length === 0) summary.push("Everything already up to date.");
  return Object.freeze([summary.join(" · "), ...outcomes.map(outcomeLine)]);
}

function outcomeLine(outcome: AutomaticRunOutcome): string {
  const versions = `${outcome.plugin} ${outcome.display.installed} → ${outcome.display.available}`;
  switch (outcome.kind) {
    case "live-next-start": return `${versions} — updated; live next start`;
    case "applied": return `${versions} — updated`;
    case "current": return `${outcome.plugin} — already up to date`;
    case "pending": return `${outcome.plugin} — still waiting; it continues automatically`;
    case "retryable": return `${versions} — couldn't finish this time; it retries automatically`;
    case "stale": return `${outcome.plugin} — skipped; things changed — try again`;
    case "blocked": return `${versions} — ${blockedReason(outcome.reason)}`;
  }
}

function blockedReason(reason: string | undefined): string {
  switch (reason) {
    case "approval-required": return "needs your approval — its source or permissions changed (open /plugins → Updates)";
    case "manual": return "automatic updates are off for it (open /plugins → Updates)";
    case "configuration-required": return "needs configuration before it can update (open /plugins → Updates)";
    case "secret-unavailable": return "a required secret is unavailable (open /plugins → Updates)";
    case "capability-unavailable": return "needs something this host can't provide (open /plugins → Updates)";
    case "degraded": return "is degraded — repair or rollback it from /plugins → Health";
    case "project-untrusted": return "blocked — this project isn't trusted";
    default: return `blocked${reason === undefined ? "" : ` (${reason})`}`;
  }
}

/** Envelope status from outcomes: applied/live-next-start/current all count as success. */
export function automaticRunStatus(outcomes: readonly AutomaticRunOutcome[]): "ok" | "no-change" | "partial" {
  if (outcomes.some((outcome) => ["pending", "blocked", "retryable", "stale"].includes(outcome.kind))) return "partial";
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome.kind === "current")) return "no-change";
  return "ok";
}
