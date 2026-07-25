import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFragment } from "./fragments.js";

/** No-style sentinel for the cache-key contribution. */
export const NO_STYLE_SIGNATURE = "";

/** Names owned by the command grammar rather than by style fragments. */
export const RESERVED_STYLE_NAMES = new Set(["none", "off", "default"]);

export interface CustomStyleEntry {
  rawRel: string;
  configDir: string;
  scope: "global" | "project";
}

export type StyleSelectionSource = "override" | "project" | "global" | "unset";
export type StyleDefaultSource = "project" | "global" | "unset";

export interface StyleConfigState {
  selection: string | undefined;
  source: StyleDefaultSource;
  registry: ReadonlyMap<string, CustomStyleEntry>;
}

export type StyleSource =
  | "bundled"
  | "custom-global"
  | "custom-project"
  | "none"
  | "unset";

export interface AvailableStyle {
  name: string;
  fragmentSource: Exclude<StyleSource, "none" | "unset">;
}

export interface StylePlan {
  name: string | undefined;
  fragmentSource: StyleSource;
  selectionSource: StyleSelectionSource;
  content: string;
  signature: string;
}

const STYLE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const BUNDLED_STYLE_ROOT = fileURLToPath(new URL("../prompts/styles/", import.meta.url));

// Two independent tiers: a session override over a durable config default.
let activeSelection: string | undefined;
let defaultSelection: string | undefined;
let defaultSource: StyleDefaultSource = "unset";
let registry = new Map<string, CustomStyleEntry>();

export function isValidStyleName(name: string): boolean {
  return STYLE_NAME_RE.test(name);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Resolve a user-authored style without allowing it to cross the directory
 * boundary of the config file that registered it. Realpath containment also
 * rejects escaping symlinks and is intentionally rechecked every turn.
 */
export function resolveCustomStylePath(rawRel: string, configDir: string): string {
  if (typeof rawRel !== "string" || rawRel.length === 0) {
    throw new Error("custom style path is empty");
  }
  if (isAbsolute(rawRel)) {
    throw new Error(`custom style path must be relative (got absolute): "${rawRel}"`);
  }
  if (!rawRel.endsWith(".md")) {
    throw new Error(`custom style path must end in ".md": "${rawRel}"`);
  }

  const rootReal = realpathSync(configDir);
  const candidate = resolve(rootReal, rawRel);
  let targetReal: string;
  try {
    targetReal = realpathSync(candidate);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`custom style file not found: "${rawRel}" (resolved ${candidate})`);
    }
    throw cause;
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    throw new Error(
      `custom style path escapes its config directory: "${rawRel}" (resolved ${targetReal})`,
    );
  }
  if (!statSync(targetReal).isFile()) {
    throw new Error(`custom style path is not a regular file: "${rawRel}"`);
  }
  return targetReal;
}

/** Bundled style fragments, filename-sorted. Missing package data fails fast. */
export function discoverBundledStyles(): string[] {
  return readdirSync(BUNDLED_STYLE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(BUNDLED_STYLE_ROOT, entry.name))
    .sort();
}

function bundledStyleNames(): string[] {
  return discoverBundledStyles().map((path) => basename(path, ".md"));
}

function cloneRegistry(source: ReadonlyMap<string, CustomStyleEntry>): Map<string, CustomStyleEntry> {
  return new Map(
    [...source.entries()].map(([name, entry]) => [name, { ...entry }]),
  );
}

function resolveSelection(
  selection: string,
  styles: ReadonlyMap<string, CustomStyleEntry>,
): void {
  if (selection === "none") return;
  if (RESERVED_STYLE_NAMES.has(selection)) {
    throw new Error(`style "${selection}" is a command control token, not a selectable style`);
  }
  const custom = styles.get(selection);
  if (custom) {
    // Validate the path and load the fragment before changing a tier. This is
    // the same validate-before-assign rule used by the mode resolver.
    loadFragment(resolveCustomStylePath(custom.rawRel, custom.configDir));
    return;
  }
  if (bundledStyleNames().includes(selection)) {
    return;
  }
  throw new Error(`style "${selection}" has no bundled or custom fragment`);
}

/** Replace only the durable default and custom registry; preserve override. */
export function configureStyleDefaults(state: StyleConfigState): void {
  const nextRegistry = cloneRegistry(state.registry);
  if (state.selection !== undefined) {
    resolveSelection(state.selection, nextRegistry);
  }
  defaultSelection = state.selection;
  defaultSource = state.selection === undefined ? "unset" : state.source;
  registry = nextRegistry;
}

/** Set the ephemeral session override after fully validating the selection. */
export function setActiveStyle(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("style name must be a non-empty string");
  }
  resolveSelection(name, registry);
  activeSelection = name;
}

/** Clear only the ephemeral override; the configured default remains intact. */
export function clearActiveStyle(): void {
  activeSelection = undefined;
}

export function getActiveStyle(): string | undefined {
  return activeSelection;
}

export function getDefaultStyle(): string | undefined {
  return defaultSelection;
}

export function getEffectiveStyleSelectionSource(): StyleSelectionSource {
  if (activeSelection !== undefined) return "override";
  if (defaultSelection !== undefined) return defaultSource;
  return "unset";
}

/**
 * List actual selectable fragments in stable name order. Custom registrations
 * are inserted after bundled discovery and therefore replace bundled entries
 * with the same name without changing the catalog's deterministic ordering.
 */
export function listAvailableStyles(): readonly AvailableStyle[] {
  const byName = new Map<string, AvailableStyle>();
  for (const name of bundledStyleNames()) {
    if (!RESERVED_STYLE_NAMES.has(name)) {
      byName.set(name, { name, fragmentSource: "bundled" });
    }
  }
  for (const [name, entry] of registry) {
    if (isValidStyleName(name) && !RESERVED_STYLE_NAMES.has(name)) {
      byName.set(name, {
        name,
        fragmentSource: entry.scope === "global" ? "custom-global" : "custom-project",
      });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function plan(
  name: string | undefined,
  fragmentSource: StyleSource,
  selectionSource: StyleSelectionSource,
  content: string,
): StylePlan {
  return {
    name,
    fragmentSource,
    selectionSource,
    content,
    signature: content === "" ? NO_STYLE_SIGNATURE : sha256(content),
  };
}

export function noStylePlan(
  source: "none" | "unset",
  selectionSource: StyleSelectionSource,
): StylePlan {
  return plan(undefined, source, selectionSource, "");
}

export function resolveActiveStylePlan(): StylePlan {
  const selection = activeSelection ?? defaultSelection;
  const selectionSource = getEffectiveStyleSelectionSource();
  if (selection === undefined) return noStylePlan("unset", selectionSource);
  if (selection === "none") return noStylePlan("none", selectionSource);

  const custom = registry.get(selection);
  if (custom) {
    const content = loadFragment(resolveCustomStylePath(custom.rawRel, custom.configDir));
    const source: StyleSource = custom.scope === "global" ? "custom-global" : "custom-project";
    return plan(selection, source, selectionSource, content);
  }

  const bundled = discoverBundledStyles().find(
    (path) => basename(path, ".md") === selection,
  );
  if (bundled) return plan(selection, "bundled", selectionSource, loadFragment(bundled));
  throw new Error(`style "${selection}" has no bundled or custom fragment`);
}

/** TEST-ONLY: return style state to its load-time default. */
export function resetStyleForTesting(): void {
  activeSelection = undefined;
  defaultSelection = undefined;
  defaultSource = "unset";
  registry = new Map();
}
