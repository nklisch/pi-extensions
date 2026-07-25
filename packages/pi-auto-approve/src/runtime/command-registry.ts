import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { CLEARANCE_MODES, type ClearanceMode } from "../config/schema.ts";
import { handleAllowCommand } from "./config-commands/allow.ts";
import {
  getPackArgumentCompletions,
  handlePacksCommand,
} from "./config-commands/packs.ts";
import {
  getScopeArgumentCompletions,
  handleScopeCommand,
} from "./config-commands/scope.ts";
import { dispatchSettingsAction } from "./config-commands/settings/dispatcher.ts";
import {
  handleScopeSettingsPanelCommand,
  handleSettingsCommand,
} from "./config-commands/settings.ts";
import { handleSetupCommand } from "./config-commands/setup.ts";
import { handleStatusCommand } from "./config-commands/status.ts";
import { handleTuneCommand } from "./config-commands/tune.ts";
import {
  type AutoReviewerAutocompleteItem,
  type AutoReviewerCommandDependencies,
  type CommandPi,
  type CommandReport,
  completion,
  filterCompletions,
  usageReport,
} from "./config-commands/types.ts";
import { handleWhyCommand } from "./config-commands/why.ts";

export type {
  AutoReviewerAutocompleteItem,
  AutoReviewerCommandDependencies,
  CommandReport,
} from "./config-commands/types.ts";
export { resolvePolicyForCommand } from "./config-commands/types.ts";

export type ClearanceCommandNamespace = "clearance";
type RegisteredCommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

const COMMAND_DESCRIPTION =
  "Configure Pi Clearance (setup, settings, status, mode, packs, scope, tune, why, allow).";

const PRIMARY_FIRST_LEVEL_COMPLETIONS = [
  completion("setup", "Open the guided setup entry point"),
  completion("settings", "Open the settings control center"),
  completion("status", "Show current status"),
  completion("mode", "Set Clearance mode: off, ask, or auto"),
  completion("packs", "Open Policy dossiers"),
  completion("scope", "Open Safe Zones settings"),
  completion("tune", "Toggle Tune mode"),
  completion("why", "Explain the last clearance decision"),
  completion("allow", "Allow a command family in plain language"),
] as const;

const DEPRECATION_NOTES = {
  packs:
    "Deprecated deep command: use `/clearance packs`; advanced pack edits moved to settings where applicable.",
  scope:
    "Deprecated deep command: use `/clearance scope`; advanced scope edits moved to settings where applicable.",
} as const;

export function registerClearanceCommands(
  pi: ExtensionAPI,
  deps: AutoReviewerCommandDependencies,
): void {
  pi.registerCommand(
    "clearance",
    buildClearanceCommandOptions(pi, deps, { namespace: "clearance" }),
  );
}

export function buildClearanceCommandOptions(
  pi: ExtensionAPI,
  deps: AutoReviewerCommandDependencies,
  options: { readonly namespace: ClearanceCommandNamespace },
): RegisteredCommandOptions {
  // Keep the namespace option in the builder so the command-registration seam
  // remains explicit even though only the canonical namespace is registered.
  void options;
  return {
    description: COMMAND_DESCRIPTION,
    getArgumentCompletions(argumentPrefix) {
      return getClearanceArgumentCompletions(argumentPrefix, deps);
    },
    async handler(args, ctx) {
      const report = await handleClearanceCommand(args, ctx, pi, deps);
      notify(ctx, report.markdown, report.level ?? "info");
    },
  };
}

export async function handleClearanceCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: CommandPi,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport> {
  const tokens = parseCommandArgs(args);
  if (tokens.length === 0) {
    return await handleSettingsCommand([], ctx, deps);
  }

  const command = tokens[0] as string;
  const rest = tokens.slice(1);
  const rawRest = rawCommandRest(args);
  switch (command) {
    case "setup":
      return await handleSetupCommand(rest, ctx, pi, deps);
    case "settings":
      return await handleSettingsCommand(rest, ctx, deps);
    case "status":
      return await handleStatusCommand(rest, ctx, deps);
    case "mode":
      return await handleModeCommand(rest, ctx, deps);
    case "packs":
      return await handlePacksEntryCommand(rest, ctx, deps);
    case "scope":
      return await handleScopeEntryCommand(rest, ctx, deps);
    case "tune":
      return handleTuneCommand(rest, ctx, pi, deps);
    case "why":
      return handleWhyCommand(rest, ctx, deps);
    case "allow":
      return await handleAllowCommand(rest, ctx, pi, deps, rawRest);

    default:
      return unknownSubcommandReport(command);
  }
}

export function getClearanceArgumentCompletions(
  argumentPrefix: string,
  deps: AutoReviewerCommandDependencies,
): AutoReviewerAutocompleteItem[] | null {
  const { completed, current } = splitCompletionPrefix(argumentPrefix);

  if (completed.length === 0) {
    return filterCompletions(PRIMARY_FIRST_LEVEL_COMPLETIONS, current);
  }

  const [command, ...rest] = completed;
  const completions = (() => {
    switch (command) {
      case "setup":
      case "settings":
        return rest.length === 0 && current.length === 0 ? [] : null;
      case "status":
        return rest.length === 0
          ? filterCompletions(
              [
                completion(
                  "--warnings",
                  "Include registry and package warnings",
                ),
              ],
              current,
            )
          : null;
      case "mode":
        return getModeArgumentCompletions(rest, current);
      case "packs":
        return getCompatPackArgumentCompletions(rest, current, deps);
      case "scope":
        return getCompatScopeArgumentCompletions(rest, current);
      case "tune":
      case "why":
        return rest.length === 0 && current.length === 0 ? [] : null;
      case "allow":
        return rest.length === 0 && current.length === 0 ? [] : null;

      default:
        return null;
    }
  })();

  return completions === null
    ? null
    : withCompletedArgumentPrefix(completions, completed);
}

function getModeArgumentCompletions(
  completed: readonly string[],
  current: string,
): AutoReviewerAutocompleteItem[] | null {
  if (completed.length > 1) return null;
  if (
    completed.length === 1 &&
    !CLEARANCE_MODES.includes(completed[0] as ClearanceMode)
  )
    return null;
  return filterCompletions(
    CLEARANCE_MODES.map((mode) => completion(mode, "Clearance mode")),
    current,
  );
}

function getCompatPackArgumentCompletions(
  rest: readonly string[],
  current: string,
  deps: AutoReviewerCommandDependencies,
): AutoReviewerAutocompleteItem[] | null {
  if (rest.length === 0) {
    return current.length === 0 ? [] : null;
  }

  return getPackArgumentCompletions(rest, current, deps);
}

function getCompatScopeArgumentCompletions(
  rest: readonly string[],
  current: string,
): AutoReviewerAutocompleteItem[] | null {
  if (rest.length === 0) {
    return current.length === 0 ? [] : null;
  }

  return getScopeArgumentCompletions(rest, current);
}

function withCompletedArgumentPrefix(
  items: readonly AutoReviewerAutocompleteItem[],
  completed: readonly string[],
): AutoReviewerAutocompleteItem[] {
  const prefix = completed.join(" ");
  if (prefix.length === 0) {
    return [...items];
  }

  return items.map((item) => ({
    ...item,
    value: `${prefix} ${item.value}`,
  }));
}

async function handleModeCommand(
  tokens: readonly string[],
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport> {
  if (tokens.length === 0) {
    return await handleSettingsCommand([], ctx, deps);
  }
  if (
    tokens.length !== 1 ||
    !CLEARANCE_MODES.includes(tokens[0] as ClearanceMode)
  ) {
    return usageReport("Expected `mode [off|ask|auto]`.");
  }
  return await dispatchSettingsAction(
    { id: "mode.set", args: { mode: tokens[0] as ClearanceMode } },
    ctx,
    deps,
  );
}

async function handlePacksEntryCommand(
  tokens: readonly string[],
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport> {
  if (tokens.length === 0) {
    return await dispatchSettingsAction(
      { id: "packs.open", args: {} },
      ctx,
      deps,
    );
  }

  return withDeprecationNote(
    await handlePacksCommand(tokens, ctx, deps),
    DEPRECATION_NOTES.packs,
  );
}

async function handleScopeEntryCommand(
  tokens: readonly string[],
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport> {
  if (tokens.length === 0) {
    return await handleScopeSettingsPanelCommand(ctx, deps);
  }

  return withDeprecationNote(
    await handleScopeCommand(tokens, ctx, deps),
    DEPRECATION_NOTES.scope,
  );
}

function withDeprecationNote<TDetails>(
  report: CommandReport<TDetails>,
  note: string,
): CommandReport<TDetails> {
  return {
    ...report,
    summary: `${note} ${report.summary}`,
    markdown: [
      "# Deprecated command",
      "",
      `- ${note}`,
      "",
      report.markdown,
    ].join("\n"),
  };
}

function unknownSubcommandReport(command: string): CommandReport<{
  readonly unknownSubcommand: string;
  readonly movedToSettings: true;
}> {
  const summary = `Unknown \`/clearance\` subcommand \`${command}\`. Open \`/clearance settings\` for advanced controls, or see \`/clearance status\`.`;
  return {
    title: "Unknown Pi Clearance subcommand",
    summary,
    markdown: ["# Unknown Pi Clearance subcommand", "", `- ${summary}`].join(
      "\n",
    ),
    details: { unknownSubcommand: command, movedToSettings: true },
    level: "error",
  };
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (!ctx.hasUI || message.trim().length === 0) return;

  try {
    ctx.ui.notify(message, level);
  } catch {
    // The command has already produced its report and may have safely applied a
    // confirmed write. Notification failure should not turn that completed
    // command into a failed slash-command execution.
  }
}

function parseCommandArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

function rawCommandRest(args: string): string {
  const match = /^\s*\S+(?:\s+([\s\S]*))?$/.exec(args);
  return match?.[1] ?? "";
}

function splitCompletionPrefix(argumentPrefix: string): {
  readonly completed: readonly string[];
  readonly current: string;
} {
  const hasTrailingSpace = /\s$/.test(argumentPrefix);
  const tokens = parseCommandArgs(argumentPrefix);
  if (hasTrailingSpace) {
    return { completed: tokens, current: "" };
  }

  return {
    completed: tokens.slice(0, -1),
    current: tokens.at(-1) ?? "",
  };
}
