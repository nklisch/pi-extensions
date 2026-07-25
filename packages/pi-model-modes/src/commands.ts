import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { deriveIdentityLine } from "./identity.js";
import { getChangeSignal } from "./cache.js";
import { refreshModeFooter } from "./footer.js";
import type { ChangeSignalSnapshot, ChangeSignalEntry, ChangeReason } from "./cache.js";
import {
  resolveActiveModePlan,
  setActiveMode,
  clearActiveMode,
  getActiveMode,
  getDefaultMode,
  getEffectiveModeSource,
} from "./resolver.js";
import { listPresetNames, getPreset, loadPresets, NONE_PRESET } from "./presets.js";
import type { ResolvedMode } from "./presets.js";
import {
  resolveActiveStylePlan,
  type StyleSelectionSource,
  type StyleSource,
} from "./style.js";
import {
  MODE_DEFAULT_ARG,
  MODE_DEFAULT_GLOBAL_FLAG,
  MODE_OFF_ARG,
} from "./autocomplete.js";
import { assembleForInspect, getLastBaseSystemPrompt } from "./handler.js";
import { parseScalarDefaultArgs } from "./command-parse-utils.js";
import {
  writeDefaultToConfig,
  readDefaultSources,
  effectiveDefaultSource,
  DEFAULT_OFF,
  type DefaultScope,
} from "./config.js";

/**
 * `/mode:inspect` — the epic's one user-facing command surface.
 *
 * Renders a plain-text status panel (mode summary, current identity, the
 * change signal's last-change reason/detail/turn-offset, and the current cache
 * key) to the message stream by reading `getChangeSignal()` + `ctx.model`.
 *
 * Architecture mirrors the handler's split: a PURE, fully-testable render core
 * (`renderModeInspect`) with no pi coupling, plus a thin command-registration
 * wrapper (`registerModeInspectCommand`) that is the only pi seam.
 *
 * Design: `.work/active/features/epic-identity-injection-mode-inspect.md`.
 */

/** Slash command name. Colon namespacing is supported by pi (cf. `skill:name`). */
export const MODE_INSPECT_COMMAND = "mode:inspect";
/** `customType` tag for the emitted status message. */
export const MODE_INSPECT_MESSAGE_TYPE = "mode-inspect";

/** Mode summary for the `Mode:` line. `undefined` (no active mode) → "unset";
 *  a resolved mode renders `base:X • agency:Y • quality:Z • scope:W` plus a
 *  ` • +mod` suffix per modifier. Preset names are shown by the caller on a
 *  sibling line or autocomplete item; the summary stays axes-only. */
export function formatModeSummary(mode: ResolvedMode | undefined): string {
  if (mode === undefined) {
    return "unset";
  }
  const axes = `base:${mode.base} • agency:${mode.agency} • quality:${mode.quality} • scope:${mode.scope}`;
  return axes + mode.modifiers.map((m) => ` • +${m}`).join("");
}

const REASON_LABEL: Record<ChangeReason, string> = {
  initial: "initial",
  "model-switched": "model switched",
  "mode-switched": "mode switched",
  "style-switched": "style switched",
  "base-changed": "base changed",
};

/** Compact first4…last4 of a hex string; short strings shown whole (defensive). */
function shortHex(h: string): string {
  return h.length <= 11 ? h : `${h.slice(0, 4)}...${h.slice(-4)}`;
}

/** Parenthetical detail line for a change entry, or "" when there is nothing
 *  meaningful to show. NEVER renders `undefined → …`. */
function formatChangeDetail(entry: ChangeSignalEntry): string {
  switch (entry.reason) {
    case "initial":
      return ""; // first population — no from-state to show
    case "model-switched": {
      const fromName = entry.detail.modelName.from ?? "?";
      const toName = entry.detail.modelName.to;
      const from = `${entry.detail.modelProvider.from ?? "?"}/${entry.detail.modelId.from ?? "?"} (${fromName})`;
      const to = `${entry.detail.modelProvider.to}/${entry.detail.modelId.to} (${toName})`;
      return `(${from} → ${to})`;
    }
    case "mode-switched": {
      // Real composed signatures are 64-char hashes — shorten them (empty "" →
      // "unset") so the detail line stays readable.
      const from = entry.detail.modeSignature.from ? shortHex(entry.detail.modeSignature.from) : "unset";
      const to = entry.detail.modeSignature.to ? shortHex(entry.detail.modeSignature.to) : "unset";
      return `(${from} → ${to})`;
    }
    case "style-switched": {
      const from = entry.detail.styleSignature.from
        ? shortHex(entry.detail.styleSignature.from)
        : "unset";
      const to = entry.detail.styleSignature.to
        ? shortHex(entry.detail.styleSignature.to)
        : "unset";
      return `(style ${from} → ${to})`;
    }
    case "base-changed": {
      const from = entry.detail.baseHash.from ? shortHex(entry.detail.baseHash.from) : "?";
      return `(base ${from} → ${shortHex(entry.detail.baseHash.to)})`;
    }
  }
}

/** The "Effective prompt last changed: …" block (1 or 2 lines). */
function formatLastChanged(snapshot: ChangeSignalSnapshot): string {
  const last = snapshot.lastEntry;
  if (last === undefined) {
    return "Effective prompt last changed: never (no turn has run yet)";
  }
  const ago = snapshot.currentTurn - last.turn;
  const when = ago <= 0 ? "this turn" : ago === 1 ? "1 turn ago" : `${ago} turns ago`;
  const head = `Effective prompt last changed: ${when} — reason: ${REASON_LABEL[last.reason]}`;
  const detail = formatChangeDetail(last);
  return detail ? `${head}\n  ${detail}` : head;
}

/**
 * PURE: choose a markdown fence longer than any backtick run in `content`, then
 * return a fenced block. Real system prompts can contain markdown fences; using
 * a fixed ``` fence would terminate early in pi's rendered message.
 */
export function formatFencedBlock(content: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (m) => m[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${content}\n${fence}`;
}

/** PURE: build the plain-text inspect panel. No pi coupling → fully unit-tested.
 *
 *  `assembledPrompt` — when present (the `/mode:inspect --prompt` flag), the
 *  panel appends a blank line, a `System prompt:` header, and a fenced block
 *  containing the bytes. When `undefined`, the bare four-line panel is emitted
 *  unchanged. The `"(no turn has run yet — …)"` sentinel is passed by the
 *  command layer when the base-prompt memo is empty so the panel honestly
 *  reports the gap rather than emitting an empty fenced block. */
export interface StyleInspectInfo {
  name: string | undefined;
  fragmentSource: StyleSource;
  selectionSource: StyleSelectionSource;
  error: string | undefined;
}

function styleSelectionLabel(source: StyleSelectionSource): string {
  if (source === "project") return "project default";
  if (source === "global") return "global default";
  return source;
}

function styleFragmentLabel(source: StyleSource): string {
  if (source === "bundled") return "bundled";
  if (source === "custom-global") return "custom, global";
  if (source === "custom-project") return "custom, project";
  return source;
}

function formatStyleLine(info: StyleInspectInfo | undefined): string {
  if (info?.error) return `Style: (unresolvable — ${info.error})`;
  if (info === undefined || info.fragmentSource === "unset") return "Style: (unset)";
  const selection = styleSelectionLabel(info.selectionSource);
  if (info.fragmentSource === "none") return `Style: none (${selection})`;
  return `Style: ${info.name} (${selection}; ${styleFragmentLabel(info.fragmentSource)})`;
}

export function renderModeInspect(
  snapshot: ChangeSignalSnapshot,
  model: Model<any> | undefined,
  mode: ResolvedMode | undefined,
  modeError?: string,
  styleInfo?: StyleInspectInfo,
  assembledPrompt?: string,
): string {
  const identity = model ? deriveIdentityLine(model) : "(no model)";
  const cacheKey = snapshot.currentKey ? shortHex(snapshot.currentKey) : "(none)";
  const modeLine = modeError
    ? `(unresolvable — ${modeError})`
    : formatModeSummary(mode);
  const lines = [
    `Mode: ${modeLine}`,
    formatStyleLine(styleInfo),
    `Identity: ${identity}`,
    formatLastChanged(snapshot),
    `Cache key: ${cacheKey}`,
  ];
  if (assembledPrompt !== undefined) {
    lines.push("", "System prompt:", formatFencedBlock(assembledPrompt));
  }
  return lines.join("\n");
}

/** Slash command name for the `/mode` command family. */
export const MODE_COMMAND = "mode";
/** `customType` tag for the `/mode` no-arg listing message. */
export const MODE_LISTING_MESSAGE_TYPE = "mode";

/**
 * PURE: build the `/mode` (no-arg) listing panel. Shows the EFFECTIVE mode
 * (source tier + the effective spec name + composed axes summary) and the
 * available presets. No pi coupling → fully unit-tested.
 *
 *   `source`   — `getEffectiveModeSource()` ("override" | "default" | "unset").
 *   `specName` — the effective spec name (`getActiveMode() ?? getDefaultMode()`)
 *                when it is a string preset name; `undefined` for an explicit
 *                object spec or no mode (the summary line still conveys the axes).
 *   `mode`     — `resolveActiveModePlan().mode` (the resolved axes), or
 *                `undefined` for no mode.
 *   `modeError`— set when the resolve threw (a broken active mode); renders an
 *                error line instead of crashing the listing.
 *   `presets`  — sorted preset names, including virtual `none`.
 */
export function formatModeListing(
  source: "override" | "default" | "unset",
  specName: string | undefined,
  mode: ResolvedMode | undefined,
  modeError: string | undefined,
  presets: readonly string[],
): string {
  const label = specName ? `${specName} (${source})` : source;
  const summary = modeError
    ? `(unresolvable — ${modeError})`
    : formatModeSummary(mode);
  const presetList =
    presets.length > 0 ? presets.map((p) => `  - ${p}`).join("\n") : "  (none)";
  return [
    `Effective mode: ${label}`,
    `  ${summary}`,
    "Available presets:",
    presetList,
  ].join("\n");
}

/** `customType` tag for the `/mode default` display-only panel. */
const MODE_DEFAULT_MESSAGE_TYPE = "mode-default";

/** Discriminated parse result for the `/mode default` subcommand. */
export type DefaultSubcommand =
  | { kind: "display" }
  | { kind: "set"; value: string; scope: DefaultScope }
  | { kind: "clear"; scope: DefaultScope }
  | { kind: "error"; message: string };

/**
 * PURE parser for the `/mode default` subcommand. Grammar:
 * `/mode default [--global] (<preset>|none|off) [--global]`.
 *
 * - `default`, `off`, `none`, `--global` are lowercase, exact, case-sensitive.
 * - `--global` may appear before OR after the action token.
 * - Rejects (→ `error`): duplicate `--global`, `--global=...` value form,
 *   mixed-case flags, unknown flags, extra positionals, flag-only with no
 *   action, multiple action tokens.
 * - Bare `/mode default` (no action, no flag) → `display`.
 * - `<preset>` is the literal token text here; preset-name validation happens
 *   downstream in the command layer via `getPreset`.
 */
export function parseModeDefaultArgs(args: string): DefaultSubcommand {
  return parseScalarDefaultArgs(args, {
    command: "/mode default",
    actionLabel: "<preset>|none|off",
    globalFlag: MODE_DEFAULT_GLOBAL_FLAG,
    clearToken: DEFAULT_OFF,
  });
}

/**
 * PURE: build the bare `/mode default` display panel (3 lines). `global` /
 * `project` come from `readDefaultSources`; each may be `undefined` (unset) or
 * `"(unreadable)"` (malformed file surfaced rather than crashing).
 */
export function formatDefaultListing(
  global: string | undefined | "(unreadable)",
  project: string | undefined | "(unreadable)",
  effective: { value: string | undefined; source: "global" | "project" | "unset" },
): string {
  const fmt = (v: string | undefined | "(unreadable)"): string =>
    v === undefined ? "(unset)" : v;
  const eff =
    effective.source === "unset"
      ? "(unset)"
      : `${fmt(effective.value)} (${effective.source})`;
  return [
    "Default mode (durable config):",
    `  global:  ${fmt(global)}`,
    `  project: ${fmt(project)}`,
    `Effective default: ${eff}`,
  ].join("\n");
}

function formatOverrideLabel(
  activeOverride: string | { base: string } | undefined,
): string | undefined {
  if (activeOverride === undefined) {
    return undefined;
  }
  return typeof activeOverride === "string" ? activeOverride : activeOverride.base;
}

function formatOverrideSuffix(
  activeOverride: string | { base: string } | undefined,
): string {
  const ovLabel = formatOverrideLabel(activeOverride);
  return ovLabel === undefined ? "" : ` — override "${ovLabel}" still active`;
}

function formatEffectiveDefault(
  effective: { value: string | undefined; source: "global" | "project" | "unset" },
): string {
  return effective.source === "unset"
    ? "(unset)"
    : `"${effective.value}" (${effective.source})`;
}

export function formatDefaultNoopNotify(args: {
  scope: DefaultScope;
  effective: { value: string | undefined; source: "global" | "project" | "unset" };
  activeOverride: string | { base: string } | undefined;
}): string {
  const base = `no default set in ${args.scope}`;
  const effectiveSuffix =
    args.effective.source === "unset"
      ? ""
      : `; effective default remains ${formatEffectiveDefault(args.effective)}`;
  return `${base}${effectiveSuffix}${formatOverrideSuffix(args.activeOverride)}`;
}

/**
 * PURE: build the override-still-wins notify string from the post-write
 * effective default + the active override. Four shapes:
 *   - cleared, no surviving default → "default cleared (<scope>); effective default is (unset)"
 *   - cleared, surviving default    → "default cleared (<scope>); effective default is now \"<v>\" (<source>)"
 *   - set, override masks it        → "default set to \"<v>\" (<scope>) — override \"<ov>\" still active; /mode off to use it now"
 *   - set, unmasked                 → "default set to \"<v>\" (<scope>); effective mode is now \"<v>\" (default)"
 * `activeOverride` is `getActiveMode()` — a string preset name, an object spec,
 * or `undefined`.
 */
export function formatDefaultNotify(args: {
  writtenScope: DefaultScope;
  writtenValue: string | undefined; // `undefined` when cleared
  effective: { value: string | undefined; source: "global" | "project" | "unset" };
  activeOverride: string | { base: string } | undefined;
}): string {
  const { writtenScope, writtenValue, effective, activeOverride } = args;
  const scopeLabel = writtenScope;

  if (writtenValue === undefined) {
    // Cleared. This reports the durable default state, plus an override suffix
    // when the session override still masks the newly exposed default/unset
    // state (GLM grouped-review nit).
    const head =
      effective.source === "unset"
        ? `default cleared (${scopeLabel}); effective default is (unset)`
        : `default cleared (${scopeLabel}); effective default is now ${formatEffectiveDefault(effective)}`;
    return `${head}${formatOverrideSuffix(activeOverride)}`;
  }

  // No override, but a higher-precedence default scope still masks the write
  // (today this means: wrote global while project has a default). Surface the
  // scope win explicitly; otherwise the user sees no immediate mode change and
  // has no clue why.
  const higherPrecedenceDefaultWins =
    effective.source !== "unset" && effective.source !== writtenScope;

  // Set + override. If a project default would still mask a global write after
  // `/mode off`, avoid promising that `/mode off` alone will use the new global
  // default (Opus grouped-review nit).
  const ovLabel = formatOverrideLabel(activeOverride);
  if (ovLabel !== undefined) {
    if (higherPrecedenceDefaultWins) {
      return `default set to "${writtenValue}" (${scopeLabel}) — override "${ovLabel}" still active; ${effective.source} default "${effective.value}" would still win after /mode off`;
    }
    return `default set to "${writtenValue}" (${scopeLabel}) — override "${ovLabel}" still active; /mode off to use it now`;
  }

  if (higherPrecedenceDefaultWins) {
    return `default set to "${writtenValue}" (${scopeLabel}) — ${effective.source} default "${effective.value}" still wins; /mode default off to use it now`;
  }

  return `default set to "${writtenValue}" (${scopeLabel}); effective mode is now "${effective.value}" (default)`;
}

/**
 * The `/mode` command family — the interactive switching path.
 *   - no arg → emit a display-only listing panel (effective mode + presets).
 *   - `off`  → `clearActiveMode()` (override falls back to the config default
 *              per the precedence layer); notify the new effective state.
 *   - a name → `setActiveMode(arg)` (validated at set-time); success notifies,
 *              failure surfaces the resolver error and leaves prior override
 *              intact.
 *   - `default [...]` → manage the durable default tier via the writer
 *              pipeline. See `parseModeDefaultArgs` for the subcommand grammar.
 */
export function registerModeCommand(pi: ExtensionAPI): void {
  pi.registerCommand(MODE_COMMAND, {
    description:
      "Show or set the session mode (no arg lists; <preset> sets; off reverts to default)",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const arg = args?.trim() ?? "";
      const firstToken = arg.split(/\s+/)[0] ?? "";

      // No arg → emit the listing panel.
      if (arg === "") {
        const source = getEffectiveModeSource();
        const effectiveSpec = getActiveMode() ?? getDefaultMode();
        const specName = typeof effectiveSpec === "string" ? effectiveSpec : undefined;
        let mode: ResolvedMode | undefined;
        let modeError: string | undefined;
        try {
          mode = resolveActiveModePlan().mode;
        } catch (err) {
          modeError = (err as Error).message;
        }
        const presets = listPresetNames();
        pi.sendMessage({
          customType: MODE_LISTING_MESSAGE_TYPE,
          content: formatModeListing(source, specName, mode, modeError, presets),
          display: true,
        });
        return;
      }

      // `default [...]` → durable default tier. Parser-then-writer pipeline.
      if (firstToken === MODE_DEFAULT_ARG) {
        const rest = arg.slice(MODE_DEFAULT_ARG.length).trim();
        const parsed = parseModeDefaultArgs(rest);
        if (parsed.kind === "error") {
          ctx.ui.notify(parsed.message, "error");
          return;
        }
        if (parsed.kind === "display") {
          const sources = readDefaultSources(ctx.cwd);
          const effective = effectiveDefaultSource(ctx.cwd);
          pi.sendMessage({
            customType: MODE_DEFAULT_MESSAGE_TYPE,
            content: formatDefaultListing(sources.global, sources.project, effective),
            display: true,
          });
          return;
        }

        // `set` → validate the preset name BEFORE touching the filesystem
        // (preset-not-found is a user typo, not a write-path concern).
        if (parsed.kind === "set" && parsed.value !== NONE_PRESET) {
          try {
            getPreset(parsed.value, loadPresets());
          } catch (err) {
            ctx.ui.notify((err as Error).message, "error");
            return;
          }
        }

        // `set` (incl. `none`) or `clear` → writer pipeline. The writer
        // reseed path (applyDefaultFromConfig) reloads + merges both files,
        // so the resolver ends up truthfully reflecting the new state.
        const value = parsed.kind === "clear" ? DEFAULT_OFF : parsed.value;
        const result = writeDefaultToConfig(ctx.cwd, value, parsed.scope);
        if (!result.ok) {
          ctx.ui.notify(
            `could not write ${result.path}: ${result.error}`,
            "error",
          );
          return;
        }
        if (result.noop === true) {
          ctx.ui.notify(
            formatDefaultNoopNotify({
              scope: result.writtenScope,
              effective: result.effective,
              activeOverride: getActiveMode(),
            }),
            "info",
          );
          return;
        }
        refreshModeFooter(ctx);
        ctx.ui.notify(
          formatDefaultNotify({
            writtenScope: result.writtenScope,
            writtenValue: result.writtenValue,
            effective: result.effective,
            activeOverride: getActiveMode(),
          }),
          "info",
        );
        return;
      }

      // `off` → clear the override; effective falls back to the config default.
      if (arg === MODE_OFF_ARG) {
        clearActiveMode();
        refreshModeFooter(ctx);
        const source = getEffectiveModeSource();
        const effectiveSpec = getActiveMode() ?? getDefaultMode();
        const specName = typeof effectiveSpec === "string" ? effectiveSpec : undefined;
        const state =
          source === "unset"
            ? "override cleared — mode unset"
            : `override cleared — mode now ${specName ?? source} (${source})`;
        ctx.ui.notify(state, "info");
        return;
      }

      // A name → set the override (validated at set-time by the resolver).
      try {
        setActiveMode(arg);
        refreshModeFooter(ctx);
        ctx.ui.notify(`mode set to "${arg}"`, "info");
      } catch (err) {
        ctx.ui.notify((err as Error).message, "error");
      }
    },
  });
}

/** The only pi seam: register `/mode:inspect`. Reads the change signal + the
 *  live model, renders, and emits a display-only message (no `triggerTurn`).
 *
 *  Arg contract: an optional single `--prompt` flag (case-sensitive, no
 *  `=value` form). When present, the panel appends the FULL assembled system
 *  prompt (the same bytes `handleBeforeAgentStart` will splice for the next
 *  turn) via the shared `assembleForInspect` pure helper. Unknown / repeated /
 *  extra tokens → error toast, no panel emit, no resolver mutation. Bare
 *  `/mode:inspect` (no flag) is byte-for-byte unchanged. */
export function registerModeInspectCommand(pi: ExtensionAPI): void {
  pi.registerCommand(MODE_INSPECT_COMMAND, {
    description:
      "Show the effective prompt's identity, last-change reason, and cache key (--prompt appends the full assembled system prompt)",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      // Parse the arg contract: empty | `--prompt` | (error).
      const tokens = (args ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
      let includePrompt = false;
      for (const token of tokens) {
        if (token === "--prompt") {
          if (includePrompt) {
            ctx.ui.notify(`unexpected repeated flag "${token}"`, "error");
            return;
          }
          includePrompt = true;
          continue;
        }
        ctx.ui.notify(`unknown /mode:inspect flag "${token}" (only --prompt is supported)`, "error");
        return;
      }

      // Resolve the active mode (the resolved axes, NOT a raw preset string).
      // A fragment that vanished after `setActiveMode` would throw here — catch
      // it so the diagnostic command degrades to a graceful unresolvable line.
      let mode: ResolvedMode | undefined;
      let modeError: string | undefined;
      try {
        mode = resolveActiveModePlan().mode;
      } catch (err) {
        modeError = (err as Error).message;
      }

      let styleInfo: StyleInspectInfo;
      try {
        const style = resolveActiveStylePlan();
        styleInfo = {
          name: style.name,
          fragmentSource: style.fragmentSource,
          selectionSource: style.selectionSource,
          error: undefined,
        };
      } catch (err) {
        styleInfo = {
          name: undefined,
          fragmentSource: "unset",
          selectionSource: "unset",
          error: (err as Error).message,
        };
      }

      // The --prompt branch: re-run the SAME splice the handler uses, against
      // the most recent pi base prompt the handler observed. If no turn has run
      // yet the memo is empty — emit an honest sentinel rather than an empty
      // fenced block.
      let assembledPrompt: string | undefined;
      if (includePrompt) {
        const base = getLastBaseSystemPrompt();
        if (base === undefined) {
          assembledPrompt =
            "(no turn has run yet — run a turn to populate the base prompt)";
        } else if (modeError !== undefined) {
          // Match the bare inspect command's graceful degradation. The point of
          // `--prompt` is diagnostics; a missing fragment should not replace the
          // panel with an opaque command error.
          assembledPrompt = `(could not assemble — ${modeError})`;
        } else {
          try {
            assembledPrompt = assembleForInspect(ctx.model, base);
          } catch (err) {
            // Assembly can fail on either mode or style resolution. Each status
            // line already owns its provenance/error; do not mislabel a style
            // failure as an unresolvable mode.
            assembledPrompt = `(could not assemble — ${(err as Error).message})`;
          }
        }
      }

      const content = renderModeInspect(
        getChangeSignal(),
        ctx.model,
        mode,
        modeError,
        styleInfo,
        assembledPrompt,
      );
      pi.sendMessage({
        customType: MODE_INSPECT_MESSAGE_TYPE,
        content,
        display: true,
      });
    },
  });
}
