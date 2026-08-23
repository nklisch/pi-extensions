import { canonicalJson } from "../domain/canonical-json.js";
import { hashContent, type ContentDigest } from "../domain/content-manifest.js";
import type { ActivationIntent } from "../domain/state/installed-state.js";
import type { ScopeReference } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";

export const AGENT_ORIENTATION_CUSTOM_TYPE = "plugin-host:agent-orientation-v1";
export const AGENT_ORIENTATION_GENERATOR_VERSION = "agent-orientation-v1";
export const MAX_ORIENTATION_DESCRIPTION_LENGTH = 240;

export class AgentOrientationUnavailableError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AgentOrientationUnavailableError";
    this.code = code;
  }
}

export function createAgentOrientationUnavailableError(code: string): AgentOrientationUnavailableError {
  return new AgentOrientationUnavailableError(code);
}

export type OrientationSkill = Readonly<{
  name: string;
  description?: string;
}>;

export type OrientationPlugin = Readonly<{
  scope: ScopeReference;
  plugin: string;
  marketplace: string;
  version: string;
  revision: string;
  activation: ActivationIntent;
  active: boolean;
  runningRevision?: string;
  degraded?: Readonly<{ code: string; explanation: string }>;
  skills: readonly OrientationSkill[];
  hooks: readonly string[];
  mcpServers: readonly string[];
  /** Authoritative counts remain complete when immutable detail is unreadable. */
  skillCount?: number;
  hookCount?: number;
  mcpServerCount?: number;
  foreignCount?: number;
}>;

export type OrientationDegraded = Readonly<{
  scope?: ScopeReference;
  plugin: string;
  code: string;
  explanation: string;
}>;

export type AgentOrientationInput = Readonly<{
  packageVersion: string;
  briefPath: string;
  scopeLabel: string;
  plugins: readonly OrientationPlugin[];
  degraded: readonly OrientationDegraded[];
  sha256: Sha256;
}>;

export type AgentOrientationContent = Readonly<{
  injectionLines: readonly string[];
  briefMarkdown: string;
  factsDigest: ContentDigest;
}>;

function scopeOrder(scope: ScopeReference): number {
  return scope.kind === "user" ? 0 : 1;
}

function scopeSortKey(scope: ScopeReference): string {
  return scope.kind === "user" ? "user" : `project:${scope.projectKey}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePlugins(left: OrientationPlugin, right: OrientationPlugin): number {
  return scopeOrder(left.scope) - scopeOrder(right.scope) ||
    compareText(scopeSortKey(left.scope), scopeSortKey(right.scope)) ||
    compareText(left.plugin, right.plugin);
}

function compareDegraded(left: OrientationDegraded, right: OrientationDegraded): number {
  return scopeOrder(left.scope ?? { kind: "user" }) - scopeOrder(right.scope ?? { kind: "user" }) ||
    compareText(left.plugin, right.plugin) || compareText(left.code, right.code);
}

function text(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\r\n\t ]+/gu, " ").trim().replaceAll("/plugins", "plugin manager");
}

function displayDescription(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = text(value);
  if (normalized.length === 0 || normalized.length > MAX_ORIENTATION_DESCRIPTION_LENGTH) return undefined;
  return normalized;
}

function displayVersion(plugin: OrientationPlugin): string {
  return text(plugin.version) || "unknown";
}

function pluginStatus(plugin: OrientationPlugin): string {
  const activation = plugin.activation === "enabled" ? "enabled" : "disabled";
  if (plugin.degraded !== undefined) return `${activation} · ${plugin.active ? "active" : "inactive"} · DEGRADED`;
  return `${activation} · ${plugin.active ? "active" : "inactive"}`;
}

function componentCount(plugin: OrientationPlugin, kind: "skills" | "hooks" | "mcpServers"): number {
  if (kind === "skills") return plugin.skillCount ?? plugin.skills.length;
  if (kind === "hooks") return plugin.hookCount ?? plugin.hooks.length;
  return plugin.mcpServerCount ?? plugin.mcpServers.length;
}

function componentCounts(plugin: OrientationPlugin): string {
  const foreign = plugin.foreignCount === undefined || plugin.foreignCount === 0
    ? ""
    : `, ${plugin.foreignCount} foreign`;
  return `${componentCount(plugin, "skills")} skills, ${componentCount(plugin, "hooks")} hooks, ${componentCount(plugin, "mcpServers")} MCP servers${foreign}`;
}

function oneLineSkill(skill: OrientationSkill): string {
  const description = displayDescription(skill.description);
  return description === undefined ? `- ${text(skill.name)}` : `- ${text(skill.name)} — ${description}`;
}

function componentDetails(plugin: OrientationPlugin): string[] {
  const lines: string[] = [];
  const skills = componentCount(plugin, "skills");
  const hooks = componentCount(plugin, "hooks");
  const mcpServers = componentCount(plugin, "mcpServers");
  lines.push(`skills (${skills}):`);
  if (plugin.skills.length === 0) lines.push(skills === 0 ? "- none" : "- detail unavailable");
  else lines.push(...plugin.skills.map(oneLineSkill));
  lines.push(`hooks (${hooks}): ${plugin.hooks.length === 0 ? (hooks === 0 ? "none" : "detail unavailable") : plugin.hooks.map(text).join(", ")}`);
  lines.push(`mcp servers (${mcpServers}): ${plugin.mcpServers.length === 0 ? (mcpServers === 0 ? "none" : "detail unavailable") : plugin.mcpServers.map(text).join(", ")}`);
  return lines;
}

function pluginBlock(plugin: OrientationPlugin, includeDetails: boolean): string {
  const lines = [
    `## ${text(plugin.plugin)} — ${displayVersion(plugin)} · ${pluginStatus(plugin)}`,
    `scope: ${plugin.scope.kind}${plugin.scope.kind === "project" ? ` (${plugin.scope.projectKey})` : ""} · marketplace: ${text(plugin.marketplace)} · revision: ${text(plugin.revision)}`,
    `components: ${componentCounts(plugin)}`,
  ];
  if (plugin.runningRevision !== undefined && plugin.runningRevision !== plugin.revision) {
    lines.push(`running revision: ${text(plugin.runningRevision)}`);
  }
  if (plugin.degraded !== undefined) {
    lines.push(`status: ${text(plugin.degraded.code)} — ${text(plugin.degraded.explanation)}`);
  }
  if (includeDetails) lines.push(...componentDetails(plugin));
  return lines.join("\n");
}

function briefFooter(): string {
  return [
    "## For the human user — not agent tools",
    "The command families below are typed by the human in the Pi TUI. When the user asks how to manage plugins, relay these; they are not callable by you.",
    "- Plugin manager family: open the `/plugins` manager.",
    "- Inspection family: list, doctor, and status.",
    "- Lifecycle family: add/install, enable/disable, update, remove/uninstall, repair, and rollback.",
  ].join("\n");
}

function inventoryHeader(input: AgentOrientationInput, plugins: readonly OrientationPlugin[]): string {
  return [
    `<!-- Generated by pi-plugin-host ${text(input.packageVersion) || "unknown"} at session start. Do not edit. -->`,
    `# Installed plugins (${text(input.scopeLabel)})`,
    `Inventory: ${plugins.length} installed record${plugins.length === 1 ? "" : "s"}.`,
  ].join("\n");
}

function buildBrief(input: AgentOrientationInput, plugins: readonly OrientationPlugin[]): string {
  const blocks = plugins.map((plugin) => pluginBlock(plugin, true));
  return [
    inventoryHeader(input, plugins),
    "",
    ...blocks.flatMap((block) => [block, ""]),
    briefFooter(),
    "",
  ].join("\n");
}
function injectionSummary(plugin: OrientationPlugin): string {
  const status = plugin.degraded === undefined
    ? plugin.activation
    : `${plugin.activation}, degraded`;
  return `${plugin.plugin} ${displayVersion(plugin)} (${componentCounts(plugin)}; ${status})`;
}

function injectionLines(input: AgentOrientationInput, plugins: readonly OrientationPlugin[]): readonly string[] {
  const visible = plugins.slice(0, 6);
  const more = plugins.length - visible.length;
  const disabled = plugins.filter((plugin) => plugin.activation === "disabled").map((plugin) => plugin.plugin);
  const summaries = visible.map(injectionSummary);
  if (more > 0) summaries.push(`+${more} more (see brief)`);
  const installed = `Plugins: ${plugins.length} installed (${text(input.scopeLabel)}) — ${summaries.length === 0 ? "none" : summaries.join("; ")}${disabled.length === 0 ? "" : `; disabled: ${disabled.join(", ")}`}.`;
  const degraded = [...input.degraded].sort(compareDegraded);
  const degradedLine = degraded.length === 0
    ? undefined
    : `Degraded: ${degraded.map((entry) => `${entry.plugin} (${text(entry.code)} — ${text(entry.explanation)})`).join("; ")}.`;
  const pointer = `Per-plugin component detail: ${input.briefPath}`;
  const lines = degradedLine === undefined ? [installed, pointer] : [installed, degradedLine, pointer];
  // Plugin names and paths are local facts, but the injection contract must
  // never accidentally teach the model a user-facing slash command.
  return lines.map((line) => line.replaceAll("/plugins", "plugin manager"));
}

function digestEvidence(input: AgentOrientationInput, plugins: readonly OrientationPlugin[], degraded: readonly OrientationDegraded[]): unknown {
  return {
    generator: AGENT_ORIENTATION_GENERATOR_VERSION,
    packageVersion: text(input.packageVersion) || "unknown",
    briefPath: input.briefPath,
    scopeLabel: input.scopeLabel,
    plugins: plugins.map((plugin) => ({
      scope: plugin.scope,
      plugin: plugin.plugin,
      marketplace: plugin.marketplace,
      version: plugin.version,
      revision: plugin.revision,
      activation: plugin.activation,
      active: plugin.active,
      ...(plugin.runningRevision === undefined ? {} : { runningRevision: plugin.runningRevision }),
      ...(plugin.degraded === undefined ? {} : { degraded: plugin.degraded }),
      skills: plugin.skills,
      hooks: plugin.hooks,
      mcpServers: plugin.mcpServers,
      ...(plugin.skillCount === undefined ? {} : { skillCount: plugin.skillCount }),
      ...(plugin.hookCount === undefined ? {} : { hookCount: plugin.hookCount }),
      ...(plugin.mcpServerCount === undefined ? {} : { mcpServerCount: plugin.mcpServerCount }),
      ...(plugin.foreignCount === undefined ? {} : { foreignCount: plugin.foreignCount }),
    })),
    degraded: degraded.map((entry) => ({
      ...(entry.scope === undefined ? {} : { scope: entry.scope }),
      plugin: entry.plugin,
      code: entry.code,
      explanation: entry.explanation,
    })),
  };
}

/** Assemble the agent-only context and the human-readable derived brief. */
export function assembleAgentOrientation(input: AgentOrientationInput): AgentOrientationContent {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") {
    throw new TypeError("agent orientation input is required");
  }
  const plugins = [...input.plugins].sort(comparePlugins);
  const degraded = [...input.degraded].sort(compareDegraded);
  const briefMarkdown = buildBrief(input, plugins);
  const digest = hashContent(
    new TextEncoder().encode(`agent-orientation-facts-v1\0${canonicalJson(digestEvidence(input, plugins, degraded))}`),
    input.sha256,
  );
  return Object.freeze({
    injectionLines: Object.freeze(injectionLines({ ...input, degraded }, plugins)),
    briefMarkdown,
    factsDigest: digest,
  });
}

/** Build the one-line startup message used when authoritative state is unreadable. */
export function assembleUnavailableOrientation(input: Readonly<{
  packageVersion: string;
  briefPath: string;
  code: string;
  sha256: Sha256;
}>): AgentOrientationContent {
  const code = text(input.code) || "ORIENTATION_STATE_UNAVAILABLE";
  const injection = `Plugins: pi-plugin-host state is unavailable this session (${code}); plugin-provided skills/MCP tools may be missing.`;
  const digest = hashContent(
    new TextEncoder().encode(`agent-orientation-unavailable-v1\0${canonicalJson({
      generator: AGENT_ORIENTATION_GENERATOR_VERSION,
      packageVersion: text(input.packageVersion) || "unknown",
      briefPath: input.briefPath,
      code,
    })}`),
    input.sha256,
  );
  const briefMarkdown = [
    `<!-- Generated by pi-plugin-host ${text(input.packageVersion) || "unknown"}. Do not edit. -->`,
    "# Plugin orientation unavailable",
    "",
    "Orientation unavailable this session because authoritative plugin state could not be read.",
    "",
  ].join("\n");
  return Object.freeze({
    injectionLines: Object.freeze([injection]),
    briefMarkdown,
    factsDigest: digest,
  });
}
