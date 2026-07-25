import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseScalarDefaultArgs } from "./command-parse-utils.js";
import {
  DEFAULT_OFF,
  effectiveStyleDefaultSource,
  readStyleDefaultSources,
  writeStyleDefaultToConfig,
  type DefaultScope,
} from "./config.js";
import {
  clearActiveStyle,
  getActiveStyle,
  listAvailableStyles,
  resolveActiveStylePlan,
  setActiveStyle,
  type AvailableStyle,
  type StyleDefaultSource,
  type StylePlan,
} from "./style.js";

export const STYLE_COMMAND = "style";
export const STYLE_LISTING_MESSAGE_TYPE = "style";
export const STYLE_DEFAULT_MESSAGE_TYPE = "style-default";
export const STYLE_DEFAULT_ARG = "default";
export const STYLE_OFF_ARG = "off";
export const STYLE_NONE_ARG = "none";
export const STYLE_GLOBAL_FLAG = "--global";

export type StyleDefaultSubcommand =
  | { kind: "display" }
  | { kind: "set"; value: string; scope: DefaultScope }
  | { kind: "clear"; scope: DefaultScope }
  | { kind: "error"; message: string };

export function parseStyleDefaultArgs(args: string): StyleDefaultSubcommand {
  return parseScalarDefaultArgs(args, {
    command: "/style default",
    actionLabel: "<name|none|off>",
    globalFlag: STYLE_GLOBAL_FLAG,
    clearToken: STYLE_OFF_ARG,
  });
}

function fragmentLabel(source: AvailableStyle["fragmentSource"]): string {
  if (source === "bundled") return "bundled";
  return source === "custom-global" ? "custom, global" : "custom, project";
}

export function formatStyleListing(
  effective: StylePlan | { error: string },
  styles: readonly AvailableStyle[],
): string {
  let status: string[];
  if ("error" in effective) {
    status = [`Effective style: (unresolvable — ${effective.error})`];
  } else if (effective.fragmentSource === "unset") {
    status = ["Effective style: unset"];
  } else if (effective.fragmentSource === "none") {
    status = [`Effective style: none (${effective.selectionSource})`];
  } else {
    status = [
      `Effective style: ${effective.name} (${effective.selectionSource})`,
      `  fragment: ${fragmentLabel(effective.fragmentSource)}`,
    ];
  }
  const catalog = styles.length === 0
    ? ["  (none)"]
    : styles.map((style) => `  - ${style.name} (${fragmentLabel(style.fragmentSource)})`);
  return [...status, "Available styles:", ...catalog].join("\n");
}

export function formatStyleDefaultListing(
  global: string | undefined | "(unreadable)",
  project: string | undefined | "(unreadable)",
  effective: { value: string | undefined; source: StyleDefaultSource },
): string {
  const show = (value: string | undefined | "(unreadable)"): string =>
    value === undefined ? "(unset)" : value;
  const effectiveText = effective.source === "unset"
    ? "(unset)"
    : `${show(effective.value)} (${effective.source})`;
  return [
    "Default style (durable config):",
    `  global:  ${show(global)}`,
    `  project: ${show(project)}`,
    `Effective default: ${effectiveText}`,
  ].join("\n");
}

function overrideSuffix(activeOverride: string | undefined): string {
  return activeOverride === undefined ? "" : ` — override "${activeOverride}" still active`;
}

function effectiveDefaultText(effective: {
  value: string | undefined;
  source: StyleDefaultSource;
}): string {
  return effective.source === "unset"
    ? "(unset)"
    : `"${effective.value}" (${effective.source})`;
}

export function formatStyleDefaultNoopNotify(args: {
  scope: DefaultScope;
  effective: { value: string | undefined; source: StyleDefaultSource };
  activeOverride: string | undefined;
}): string {
  const surviving = args.effective.source === "unset"
    ? ""
    : `; effective default remains ${effectiveDefaultText(args.effective)}`;
  return `no style default set in ${args.scope}${surviving}${overrideSuffix(args.activeOverride)}`;
}

export function formatStyleDefaultNotify(args: {
  writtenScope: DefaultScope;
  writtenValue: string | undefined;
  effective: { value: string | undefined; source: StyleDefaultSource };
  activeOverride: string | undefined;
}): string {
  const { writtenScope, writtenValue, effective, activeOverride } = args;
  if (writtenValue === undefined) {
    const head = effective.source === "unset"
      ? `style default cleared (${writtenScope}); effective default is (unset)`
      : `style default cleared (${writtenScope}); effective default is now ${effectiveDefaultText(effective)}`;
    return `${head}${overrideSuffix(activeOverride)}`;
  }

  const higherDefaultWins = effective.source !== "unset" && effective.source !== writtenScope;
  if (activeOverride !== undefined) {
    if (higherDefaultWins) {
      return `style default set to "${writtenValue}" (${writtenScope}) — override "${activeOverride}" still active; ${effective.source} default "${effective.value}" would still win after /style off`;
    }
    return `style default set to "${writtenValue}" (${writtenScope}) — override "${activeOverride}" still active; /style off to use it now`;
  }
  if (higherDefaultWins) {
    return `style default set to "${writtenValue}" (${writtenScope}) — ${effective.source} default "${effective.value}" still wins; /style default off to use it now`;
  }
  return `style default set to "${writtenValue}" (${writtenScope}); effective style is now "${effective.value}" (${effective.source})`;
}

function effectiveStyleLabel(): string {
  const plan = resolveActiveStylePlan();
  if (plan.fragmentSource === "unset") return "unset";
  if (plan.fragmentSource === "none") return `none (${plan.selectionSource})`;
  return `${plan.name} (${plan.selectionSource})`;
}

/** Thin Pi seam for the style selection/default command family. */
export function registerStyleCommand(pi: ExtensionAPI): void {
  pi.registerCommand(STYLE_COMMAND, {
    description: "Show or set the conversational writing style for this session or config default",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const arg = args?.trim() ?? "";
      const firstToken = arg.split(/\s+/)[0] ?? "";

      if (arg === "") {
        let effective: StylePlan | { error: string };
        try {
          effective = resolveActiveStylePlan();
        } catch (cause) {
          effective = { error: (cause as Error).message };
        }
        let styles: readonly AvailableStyle[] = [];
        try {
          styles = listAvailableStyles();
        } catch (cause) {
          if (!("error" in effective)) effective = { error: (cause as Error).message };
        }
        pi.sendMessage({
          customType: STYLE_LISTING_MESSAGE_TYPE,
          content: formatStyleListing(effective, styles),
          display: true,
        });
        return;
      }

      if (firstToken === STYLE_DEFAULT_ARG) {
        const parsed = parseStyleDefaultArgs(arg.slice(STYLE_DEFAULT_ARG.length).trim());
        if (parsed.kind === "error") {
          ctx.ui.notify(parsed.message, "error");
          return;
        }
        if (parsed.kind === "display") {
          const sources = readStyleDefaultSources(ctx.cwd);
          pi.sendMessage({
            customType: STYLE_DEFAULT_MESSAGE_TYPE,
            content: formatStyleDefaultListing(
              sources.global,
              sources.project,
              effectiveStyleDefaultSource(ctx.cwd),
            ),
            display: true,
          });
          return;
        }

        const value = parsed.kind === "clear" ? DEFAULT_OFF : parsed.value;
        const result = writeStyleDefaultToConfig(ctx.cwd, value, parsed.scope);
        if (!result.ok) {
          ctx.ui.notify(`could not write ${result.path}: ${result.error}`, "error");
          return;
        }
        const notify = result.noop
          ? formatStyleDefaultNoopNotify({
              scope: result.writtenScope,
              effective: result.effective,
              activeOverride: getActiveStyle(),
            })
          : formatStyleDefaultNotify({
              writtenScope: result.writtenScope,
              writtenValue: result.writtenValue,
              effective: result.effective,
              activeOverride: getActiveStyle(),
            });
        ctx.ui.notify(notify, "info");
        return;
      }

      if (arg === STYLE_OFF_ARG) {
        clearActiveStyle();
        let state: string;
        try {
          state = effectiveStyleLabel();
        } catch (cause) {
          state = `unresolvable — ${(cause as Error).message}`;
        }
        ctx.ui.notify(`style override cleared — effective style ${state}`, "info");
        return;
      }

      try {
        setActiveStyle(arg);
        ctx.ui.notify(`style set to "${arg}"`, "info");
      } catch (cause) {
        ctx.ui.notify((cause as Error).message, "error");
      }
    },
  });
}
