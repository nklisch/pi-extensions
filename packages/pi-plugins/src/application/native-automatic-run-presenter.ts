import type { NativeAutomaticUpdateRunResult } from "./native-update-contract.js";

type AutomaticRunOutcome = NativeAutomaticUpdateRunResult["outcomes"][number];

/**
 * Plain-language presentation for update runs: every line says what happened
 * to a named plugin and what (if anything) the user must do. Machine kinds
 * and reasons stay in the structured outcome for protocol consumers.
 */
export function automaticRunHumanLines(outcomes: readonly AutomaticRunOutcome[]): readonly string[] {
  if (outcomes.length === 0) return Object.freeze(["No plugin updates needed."]);
  const staged = outcomes.filter((outcome) => outcome.kind === "staged").length;
  const applied = outcomes.filter((outcome) => outcome.kind === "applied").length;
  const settled = staged + applied + outcomes.filter((outcome) => outcome.kind === "current").length;
  const attention = outcomes.length - settled;
  const summary: string[] = [];
  const done = staged + applied;
  if (done > 0) {
    summary.push(`${done} update${done === 1 ? "" : "s"} installed${staged > 0 ? " — live on next start (restart or reload pi to use now)" : ""}`);
  }
  if (attention > 0) summary.push(`${attention} need${attention === 1 ? "s" : ""} your attention`);
  if (summary.length === 0) summary.push("Everything already up to date.");
  return Object.freeze([summary.join(" · "), ...outcomes.map(outcomeLine)]);
}

function outcomeLine(outcome: AutomaticRunOutcome): string {
  const versions = `${outcome.plugin} ${outcome.display.installed} → ${outcome.display.available}`;
  switch (outcome.kind) {
    case "staged": return `${versions} — updated; live on next start`;
    case "applied": return `${versions} — updated`;
    case "current": return `${outcome.plugin} — already up to date`;
    case "pending": return `${outcome.plugin} — still waiting; it continues automatically`;
    case "retryable": return `${versions} — couldn't finish this time; it retries automatically`;
    case "recovery-required": return `${versions} — needs recovery; restart pi to finish it`;
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
    case "project-untrusted": return "blocked — this project isn't trusted";
    default: return `blocked${reason === undefined ? "" : ` (${reason})`}`;
  }
}

/** Envelope status from outcomes: staged/applied/current all count as success. */
export function automaticRunStatus(outcomes: readonly AutomaticRunOutcome[]): "ok" | "no-change" | "partial" | "recovery-required" {
  if (outcomes.some((outcome) => outcome.kind === "recovery-required")) return "recovery-required";
  if (outcomes.some((outcome) => ["pending", "blocked", "retryable", "stale"].includes(outcome.kind))) return "partial";
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome.kind === "current")) return "no-change";
  return "ok";
}
