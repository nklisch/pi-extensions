import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { RatchetModeResult } from "../ratchet-mode.ts";
import { type TuneCueUpdateResult, updateTuneActiveCue } from "./tune-cue.ts";
import {
  type AutoReviewerCommandDependencies,
  type CommandPi,
  type CommandReport,
  usageReport,
} from "./types.ts";

export interface TuneCommandDetails {
  readonly command: "tune";
  readonly action: "toggle" | "on" | "off";
  readonly result: RatchetModeResult;
  readonly status: RatchetModeResult["status"];
  readonly toolNames: readonly string[];
  readonly cue: TuneCueUpdateResult;
}

export function handleTuneCommand(
  rest: readonly string[],
  ctx: ExtensionCommandContext,
  pi: CommandPi,
  deps: AutoReviewerCommandDependencies,
): CommandReport<
  TuneCommandDetails | { readonly usage: true; readonly reason?: string }
> {
  const parsed = parseTuneArgs(rest);
  if (!parsed.ok) {
    return usageReport(parsed.reason);
  }

  const wasActive = deps.manager.isRatchetActive();
  const desiredActive =
    parsed.action === "toggle" ? !wasActive : parsed.action === "on";
  const result = desiredActive
    ? deps.manager.enterRatchetMode(pi)
    : deps.manager.exitRatchetMode(pi);
  const cue = updateTuneActiveCue(ctx, deps);
  const toolNames = result.status.ratchetToolNames;

  return {
    title: tuneTitle({ action: parsed.action, wasActive, desiredActive }),
    summary: tuneSummary({ wasActive, desiredActive, toolNames }),
    markdown: formatTuneMarkdown({ result, desiredActive, toolNames }),
    details: {
      command: "tune",
      action: parsed.action,
      result,
      status: result.status,
      toolNames,
      cue,
    },
    level: result.fallback === undefined ? "info" : "warning",
  };
}

function parseTuneArgs(
  tokens: readonly string[],
):
  | { readonly ok: true; readonly action: "toggle" | "on" | "off" }
  | { readonly ok: false; readonly reason: string } {
  if (tokens.length === 0) {
    return { ok: true, action: "toggle" };
  }

  if (tokens.length === 1 && (tokens[0] === "on" || tokens[0] === "off")) {
    return { ok: true, action: tokens[0] };
  }

  return {
    ok: false,
    reason: "Expected `tune` (or hidden explicit form `tune on|off`).",
  };
}

function tuneTitle(input: {
  readonly action: "toggle" | "on" | "off";
  readonly wasActive: boolean;
  readonly desiredActive: boolean;
}): string {
  if (input.action !== "toggle" && input.wasActive === input.desiredActive) {
    return `Tune mode already ${input.desiredActive ? "on" : "off"}`;
  }

  return `Tune mode ${input.desiredActive ? "enabled" : "disabled"}`;
}

function tuneSummary(input: {
  readonly wasActive: boolean;
  readonly desiredActive: boolean;
  readonly toolNames: readonly string[];
}): string {
  const tools = formatToolList(input.toolNames);
  if (input.desiredActive) {
    return input.wasActive
      ? `Tune mode is already on; active Tune tools: ${tools}.`
      : `Tune mode is on; active Tune tools: ${tools}.`;
  }

  return input.wasActive
    ? `Tune mode is off; removed Tune tools: ${tools}.`
    : `Tune mode is already off; Tune tools remain inactive: ${tools}.`;
}

function formatTuneMarkdown(input: {
  readonly result: RatchetModeResult;
  readonly desiredActive: boolean;
  readonly toolNames: readonly string[];
}): string {
  const lines = [
    `# ${input.desiredActive ? "Tune mode on" : "Tune mode off"}`,
    "",
    `- State: ${input.desiredActive ? "on" : "off"}`,
    `- Tune tools: ${formatToolList(input.toolNames)}`,
    `- Manager: ${input.result.message}`,
  ];

  if (input.result.fallback !== undefined) {
    const { fallback } = input.result;
    lines.push(
      `- Warning: ${fallback.message}`,
      `- Expected active tools: ${formatToolList(fallback.expected)}`,
      `- Actual active tools: ${formatToolList(fallback.actual)}`,
      `- Restored tools: ${formatToolList(fallback.restored)}`,
    );
  }

  return lines.join("\n");
}

function formatToolList(toolNames: readonly string[]): string {
  return toolNames.length === 0 ? "(none)" : toolNames.join(", ");
}
