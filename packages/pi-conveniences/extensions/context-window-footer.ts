import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const STATE_FILE_NAME = "context-window-footer-state.json";
const CATPPUCCIN_STATE_FILE_NAME = "catppuccin-tui-state.json";
const BAR_SEGMENTS = 8;
const FOOTER_REAPPLY_DELAYS_MS = [0, 50, 250, 1000] as const;
const CATPPUCCIN_STATUS_ID = "catppuccin-tui";
const MODE_STATUS_IDS = new Set(["mode", "pi-model-modes"]);
const CODEX_STATUS_ID = "codex-pool";
const SHOULD_DISABLE_CATPPUCCIN_PACKAGE_FOOTER =
  process.env.PI_CONVENIENCES_DISABLE_CATPPUCCIN_FOOTER !== "0";

type PersistedState = {
  enabled?: boolean;
};

type CatppuccinState = {
  indicator?: boolean;
  status?: boolean;
  footer?: boolean;
  [key: string]: unknown;
};

type ContextSnapshot = {
  percent: number | null;
  contextWindow: number | null;
};

type FooterTheme = ExtensionContext["ui"]["theme"];

let enabled = true;
let footerInstalled = false;
let sessionGeneration = 0;
let pendingTimers: ReturnType<typeof setTimeout>[] = [];

function getStatePath(): string {
  return join(getAgentDir(), STATE_FILE_NAME);
}

function getCatppuccinStatePath(): string {
  return join(getAgentDir(), CATPPUCCIN_STATE_FILE_NAME);
}

function readPersistedState(): PersistedState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(getStatePath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as PersistedState;
    return { enabled: value.enabled === undefined ? undefined : value.enabled === true };
  } catch {
    return undefined;
  }
}

function writePersistedState(): void {
  try {
    const statePath = getStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
  } catch {
    // The footer is cosmetic. If persistence fails, keep the in-memory toggle.
  }
}

function disableConflictingCatppuccinPackageFooter(): void {
  if (!SHOULD_DISABLE_CATPPUCCIN_PACKAGE_FOOTER) return;

  try {
    const statePath = getCatppuccinStatePath();
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

    const state = parsed as CatppuccinState;
    if (state.footer !== true) return;

    // pi-catppuccin-tui's packaged footer is another ctx.ui.setFooter owner.
    // This extension keeps the Catppuccin visual language while adding context
    // and status preservation, so keeping the package footer disabled removes
    // a startup/reload race without losing the theme, indicator, or status dot.
    writeFileSync(statePath, `${JSON.stringify({ ...state, footer: false }, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort only. If the package state file is absent or unreadable, the
    // timed reapply burst below still reclaims the footer in the current session.
  }
}

function clearPendingTimers(): void {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers = [];
}

function formatModelName(modelId: string | undefined): string {
  const raw = modelId?.trim() || "no model";
  return raw.replace(/-\d{8}$/, "");
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "?";
  if (value < 1000) return `${Math.round(value)}`;
  if (value < 1_000_000) {
    const scaled = value / 1000;
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}k`;
  }
  const scaled = value / 1_000_000;
  return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}m`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "?%";
  const clamped = clampPercent(value);
  if (clamped < 10 || clamped >= 95) return `${clamped.toFixed(1)}%`;
  return `${clamped.toFixed(0)}%`;
}

function contextColor(theme: FooterTheme, percent: number | null, text: string): string {
  if (percent === null) return theme.fg("dim", text);
  const clamped = clampPercent(percent);
  if (clamped >= 90) return theme.fg("error", text);
  if (clamped >= 75) return theme.fg("warning", text);
  return theme.fg("success", text);
}

function contextBar(theme: FooterTheme, percent: number | null): string {
  if (percent === null) return theme.fg("dim", "▱".repeat(BAR_SEGMENTS));

  const clamped = clampPercent(percent);
  const filled = Math.max(0, Math.min(BAR_SEGMENTS, Math.round((clamped / 100) * BAR_SEGMENTS)));
  const active = contextColor(theme, clamped, "▰".repeat(filled));
  const inactive = theme.fg("dim", "▱".repeat(BAR_SEGMENTS - filled));
  return `${active}${inactive}`;
}

function getContextSnapshot(ctx: ExtensionContext): ContextSnapshot {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
  return {
    percent: usage?.percent ?? null,
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : null,
  };
}

function formatContextFull(theme: FooterTheme, snapshot: ContextSnapshot): string {
  const percent = formatPercent(snapshot.percent);
  const maxTokens = formatCount(snapshot.contextWindow);
  return [
    theme.fg("muted", "ctx"),
    contextBar(theme, snapshot.percent),
    contextColor(theme, snapshot.percent, percent),
    theme.fg("dim", "·"),
    theme.fg("muted", "max"),
    theme.fg("toolTitle", maxTokens),
  ].join(" ");
}

function formatContextMedium(theme: FooterTheme, snapshot: ContextSnapshot): string {
  return [
    theme.fg("muted", "ctx"),
    contextColor(theme, snapshot.percent, formatPercent(snapshot.percent)),
    theme.fg("dim", "·"),
    theme.fg("muted", "max"),
    theme.fg("toolTitle", formatCount(snapshot.contextWindow)),
  ].join(" ");
}

function formatContextCompact(theme: FooterTheme, snapshot: ContextSnapshot): string {
  return [
    theme.fg("muted", "ctx"),
    `${contextColor(theme, snapshot.percent, formatPercent(snapshot.percent))}${theme.fg("dim", "/")}${theme.fg(
      "toolTitle",
      formatCount(snapshot.contextWindow),
    )}`,
  ].join(" ");
}

function formatEffort(theme: FooterTheme, effort: ReturnType<ExtensionAPI["getThinkingLevel"]>): string {
  const label = `(${effort})`;
  switch (effort) {
    case "off":
      return theme.fg("thinkingOff", label);
    case "minimal":
      return theme.fg("thinkingMinimal", label);
    case "low":
      return theme.fg("thinkingLow", label);
    case "medium":
      return theme.fg("thinkingMedium", label);
    case "high":
      return theme.fg("thinkingHigh", label);
    case "xhigh":
      return theme.fg("thinkingXhigh", label);
  }
}

function formatModelLabel(theme: FooterTheme, model: string, effort: ReturnType<ExtensionAPI["getThinkingLevel"]>): string {
  return `${theme.fg("toolTitle", model)} ${formatEffort(theme, effort)}`;
}

/**
 * Builds the current-folder segment shown between the model and the git branch.
 * The ❯ chevron mirrors the mauve ◆ model marker; the folder name uses the
 * foreground color so it reads as primary context. Returns undefined when the
 * cwd is unavailable so callers can omit the segment instead of leaving a
 * dangling separator.
 */
function formatFolderLabel(theme: FooterTheme, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const name = cwd === homedir() ? "~" : basename(cwd) || "/";
  if (!name) return undefined;
  return `${theme.fg("accent", "❯")} ${theme.fg("text", name)}`;
}

function footerFits(width: number, left: string, right: string): boolean {
  return visibleWidth(left) + 1 + visibleWidth(right) <= width;
}

function formatFooterLine(width: number, left: string, right: string): string {
  const padWidth = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return truncateToWidth(`${left}${" ".repeat(padWidth)}${right}`, width, "");
}

function statusPriority(key: string): number {
  if (MODE_STATUS_IDS.has(key)) return 0;
  return 1;
}

function formatStatusValue(key: string, rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (!value || key === CATPPUCCIN_STATUS_ID) return undefined;
  return value;
}

function formatExtensionStatuses(
  theme: FooterTheme,
  statuses: ReadonlyMap<string, string>,
  maxItems = 2,
): string | undefined {
  const values = [...statuses.entries()]
    .filter(([key]) => key !== CODEX_STATUS_ID)
    .sort(([left], [right]) => statusPriority(left) - statusPriority(right) || left.localeCompare(right))
    .map(([key, value]) => formatStatusValue(key, value))
    .filter((value): value is string => value !== undefined)
    .slice(0, maxItems);

  if (values.length === 0) return undefined;
  return values.join(` ${theme.fg("dim", "•")} `);
}

function formatExtensionStatusByKey(statuses: ReadonlyMap<string, string>, key: string): string | undefined {
  const value = statuses.get(key);
  return value === undefined ? undefined : formatStatusValue(key, value);
}

function formatCompactCodexStatus(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^codex (.+) · 5h (\S+) · 7d (\S+)$/.exec(value);
  return match ? `codex ${match[1]} ${match[2]}/${match[3]}` : value;
}

function installFooter(ctx: ExtensionContext, pi: ExtensionAPI): void {
  if (!ctx.hasUI || !enabled) return;

  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        try {
          if (width <= 0) return [""];

        const model = formatModelName(ctx.model?.id);
          const modelLabel = formatModelLabel(theme, model, pi.getThinkingLevel());
          const branch = footerData.getGitBranch();
          const branchLabel = branch ? `git ${branch}` : "no git";
          const folderLabel = formatFolderLabel(theme, ctx.cwd);
          const snapshot = getContextSnapshot(ctx);
          const extensionStatuses = footerData.getExtensionStatuses();
          const otherStatuses = formatExtensionStatuses(theme, extensionStatuses);
          const primaryOtherStatus = formatExtensionStatuses(theme, extensionStatuses, 1);
          const codexStatus = formatExtensionStatusByKey(extensionStatuses, CODEX_STATUS_ID);
          const codexCompact = formatCompactCodexStatus(codexStatus);

        const leftFullSegments = [theme.fg("accent", "◆"), modelLabel];
        if (folderLabel) leftFullSegments.push(theme.fg("dim", "•"), folderLabel);
        leftFullSegments.push(
          theme.fg("dim", "•"),
          branch ? theme.fg("success", branchLabel) : theme.fg("dim", branchLabel),
        );
        const leftFull = leftFullSegments.join(" ");

        const rightFull = [otherStatuses, codexStatus, formatContextFull(theme, snapshot)]
          .filter(Boolean)
          .join(` ${theme.fg("dim", "•")} `);
        if (footerFits(width, leftFull, rightFull)) {
          return [formatFooterLine(width, leftFull, rightFull)];
        }

        const rightMediumWithStatus = [otherStatuses, codexStatus, formatContextMedium(theme, snapshot)]
          .filter(Boolean)
          .join(` ${theme.fg("dim", "•")} `);
        if (footerFits(width, leftFull, rightMediumWithStatus)) {
          return [formatFooterLine(width, leftFull, rightMediumWithStatus)];
        }

        const rightMedium = [codexStatus, formatContextMedium(theme, snapshot)]
          .filter(Boolean)
          .join(` ${theme.fg("dim", "•")} `);
        if (footerFits(width, leftFull, rightMedium)) {
          return [formatFooterLine(width, leftFull, rightMedium)];
        }

        const leftCompactSegments = [theme.fg("accent", "◆"), modelLabel];
        if (folderLabel) leftCompactSegments.push(theme.fg("dim", "•"), folderLabel);
        leftCompactSegments.push(
          theme.fg("dim", "•"),
          branch ? theme.fg("success", branch) : theme.fg("dim", "no git"),
        );
        const leftCompact = leftCompactSegments.join(" ");
        const rightCompact = formatContextCompact(theme, snapshot);
        const rightCompactWithStatuses = [primaryOtherStatus, codexCompact, rightCompact]
          .filter(Boolean)
          .join(` ${theme.fg("dim", "•")} `);
        if (footerFits(width, leftCompact, rightCompactWithStatuses)) {
          return [formatFooterLine(width, leftCompact, rightCompactWithStatuses)];
        }

        const rightCompactWithCodex = [codexCompact, rightCompact]
          .filter(Boolean)
          .join(` ${theme.fg("dim", "•")} `);
        if (footerFits(width, leftCompact, rightCompactWithCodex)) {
          return [formatFooterLine(width, leftCompact, rightCompactWithCodex)];
        }

        if (codexCompact && footerFits(width, leftCompact, codexCompact)) {
          return [formatFooterLine(width, leftCompact, codexCompact)];
        }

        if (footerFits(width, leftCompact, rightCompact)) {
          return [formatFooterLine(width, leftCompact, rightCompact)];
        }

          return [
            truncateToWidth(
              [theme.fg("accent", "◆"), modelLabel, rightCompact].join(" "),
              width,
              "",
            ),
          ];
        } catch (error) {
          // Pi may request one final render while a replaced session tears its
          // footer down. A rendering failure degrades this cosmetic surface.
          logOperationalError(
            `[context-window-footer] render failed: ${describeError(error)}`,
          );
          return [truncateToWidth("context footer unavailable", Math.max(0, width), "")];
        }
      },
    };
  });

  footerInstalled = true;
}

function clearFooter(ctx: ExtensionContext): void {
  clearPendingTimers();
  if (!footerInstalled) return;
  ctx.ui.setFooter(undefined);
  footerInstalled = false;
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unprintable error";
  }
}

function logOperationalError(message: string): void {
  try {
    console.error(message);
  } catch {
    // stderr can be unavailable during process teardown.
  }
}

function scheduleInstallFooter(ctx: ExtensionContext, pi: ExtensionAPI): void {
  if (!ctx.hasUI || !enabled) return;

  disableConflictingCatppuccinPackageFooter();
  clearPendingTimers();

  const generation = sessionGeneration;
  for (const delayMs of FOOTER_REAPPLY_DELAYS_MS) {
    const timer = setTimeout(() => {
      pendingTimers = pendingTimers.filter((candidate) => candidate !== timer);
      if (generation !== sessionGeneration || !enabled) return;
      try {
        installFooter(ctx, pi);
      } catch (error) {
        // Timer callbacks run outside Pi's awaited extension boundary. A stale
        // context is expected during replacement; every other operational
        // failure is diagnostic, but none may escape and terminate Pi.
        const message = describeError(error);
        if (!message.includes("stale after session replacement")) {
          clearPendingTimers();
          logOperationalError(`[context-window-footer] install failed: ${message}`);
          try {
            ctx.ui.notify(`Context footer could not be installed: ${message}`, "error");
          } catch (notifyError) {
            logOperationalError(
              `[context-window-footer] error notification failed: ${describeError(notifyError)}`,
            );
          }
        }
      }
    }, delayMs);
    timer.unref?.();
    pendingTimers.push(timer);
  }
}

function restoreState(): void {
  const persisted = readPersistedState();
  enabled = persisted?.enabled ?? true;
}

function setEnabled(ctx: ExtensionContext, pi: ExtensionAPI, nextEnabled: boolean): void {
  enabled = nextEnabled;
  writePersistedState();
  if (enabled) scheduleInstallFooter(ctx, pi);
  else clearFooter(ctx);
}

export default function contextWindowFooter(pi: ExtensionAPI) {
  pi.registerCommand("context-footer", {
    description: "Toggle the Catppuccin-style context-window footer: on, off, refresh, or status.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;

      const command = args.trim().toLowerCase();
      if (!command || command === "status") {
        ctx.ui.notify(
          `Context footer is ${enabled ? "on" : "off"}. It shows context-window percent, model max tokens, and extension statuses; when on it keeps pi-catppuccin-tui's competing package footer disabled.`,
          "info",
        );
        return;
      }

      if (command === "on") {
        setEnabled(ctx, pi, true);
        ctx.ui.notify("Context footer enabled", "info");
        return;
      }

      if (command === "off") {
        setEnabled(ctx, pi, false);
        ctx.ui.notify("Context footer disabled", "info");
        return;
      }

      if (command === "refresh") {
        scheduleInstallFooter(ctx, pi);
        ctx.ui.notify("Context footer refreshed", "info");
        return;
      }

      ctx.ui.notify("Usage: /context-footer [on|off|refresh|status]", "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionGeneration += 1;
    clearPendingTimers();
    restoreState();
    scheduleInstallFooter(ctx, pi);
  });

  pi.on("session_tree", async (_event, ctx) => {
    scheduleInstallFooter(ctx, pi);
  });

  pi.on("model_select", async (_event, ctx) => {
    scheduleInstallFooter(ctx, pi);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    scheduleInstallFooter(ctx, pi);
  });

  // If another footer extension is toggled mid-session, reclaim the footer on
  // the next agent turn while still letting /context-footer off opt out cleanly.
  pi.on("turn_start", async (_event, ctx) => {
    scheduleInstallFooter(ctx, pi);
  });

  pi.on("turn_end", async (_event, ctx) => {
    scheduleInstallFooter(ctx, pi);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    sessionGeneration += 1;
    clearPendingTimers();
    footerInstalled = false;
  });
}
