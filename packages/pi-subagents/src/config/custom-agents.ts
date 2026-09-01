/**
 * custom-agents.ts — Load user-defined agents from global, shared project, and Pi project locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "#src/config/agent-types";
import { debugLog } from "#src/debug";
import type { AgentConfig, ThinkingLevel, SubagentMode } from "#src/types";

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Pi project:     <cwd>/.pi/agents/*.md
 *   2. Shared project: <cwd>/.agents/agents/*.md
 *   3. Global:         $PI_CODING_AGENT_DIR/agents/*.md
 *
 * Project-level agents override global ones with the same name.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  const globalDir = join(getAgentDir(), "agents");
  const sharedProjectDir = join(cwd, ".agents", "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  loadFromDir(globalDir, agents, "global");
  loadFromDir(sharedProjectDir, agents, "shared-project");
  loadFromDir(projectDir, agents, "project");
  return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  source: "project" | "shared-project" | "global",
): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch (err) {
    debugLog("readdirSync agents dir", err);
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");

    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch (err) {
      debugLog("readFileSync agent file", err);
      continue;
    }

    try {
      const { frontmatter: fm, body } = parseFrontmatter(content);
      if (fm.run_in_background !== undefined || fm.foreground !== undefined) {
        const path = join(dir, file);
        const removedFields = [
          fm.run_in_background !== undefined ? "run_in_background" : undefined,
          fm.foreground !== undefined ? "foreground" : undefined,
        ].filter((field): field is string => field !== undefined).join(", ");
        // Reserve the name as disabled so a removed field cannot silently fall
        // through to a lower-priority file or an embedded default with a
        // different delivery mode. The warning gives the owner an actionable
        // migration path instead of making the refusal look like a missing file.
        console.warn(`[pi-subagents] Ignoring ${path}: removed delivery field(s) ${removedFields}; use mode: joined|detached.`);
        agents.set(name, {
          name,
          description: `Invalid agent definition: ${removedFields}`,
          systemPrompt: "",
          promptMode: "append",
          enabled: false,
          source,
        });
        continue;
      }
      agents.set(name, {
        name,
        displayName: str(fm.display_name),
        description: str(fm.description) ?? name,
        builtinToolNames: csvList(fm.tools, BUILTIN_TOOL_NAMES),
        model: str(fm.model),
        thinking: str(fm.thinking) as ThinkingLevel | undefined,
        maxTurns: nonNegativeInt(fm.max_turns),
        timeoutSeconds: positiveInt(fm.timeout_seconds),
        systemPrompt: body.trim(),
        promptMode: fm.prompt_mode === "replace" ? "replace" : "append",
        inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
        mode: fm.mode === "joined" || fm.mode === "detached" ? fm.mode as SubagentMode : undefined,
        enabled: fm.enabled !== false,  // default true; explicitly false disables
        source,
      });
    } catch (err) {
      // One malformed user file must not hide valid agents from the same tier
      // or lower-priority discovery locations.
      debugLog("parse custom agent frontmatter", err);
    }
  }
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/** Extract a non-negative integer; 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && Number.isInteger(val) && val >= 0 ? val : undefined;
}

/** Extract a positive integer for an active runtime deadline. */
function positiveInt(val: unknown): number | undefined {
  return typeof val === "number" && Number.isInteger(val) && val > 0 ? val : undefined;
}

/**
 * Parse a raw CSV field value into items, or undefined if absent/empty/"none".
 */
function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- val is already narrowed past null/undefined; String() is the intended coercion here
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map(t => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Parse a comma-separated list field with defaults.
 * omitted → defaults; "none"/empty → []; csv → listed items.
 */
function csvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}
