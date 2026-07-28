import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Rewrite rules — the "LEGIBLE.md" idea: a project-level file (AGENTS.md
 * style, separate name) holding custom instructions for the rewriter.
 *
 * Discovery order, first hit wins:
 *   1. `<cwd>/LEGIBLE.md`         (project rules)
 *   2. `~/.pi/agent/LEGIBLE.md`   (global personal rules)
 *   3. built-in defaults
 *
 * The file content replaces the rules section of the rewriter system
 * prompt; the fixed task preamble (what to rewrite, output-only contract)
 * always applies and is not user-editable.
 */

export const RULES_FILE_NAME = "LEGIBLE.md";

// Baseline adapted from ASD-STE100 Simplified Technical English principles
// ("STE-flavored" mode: sentence/voice discipline without the controlled
// dictionary), tuned for chat messages rather than documentation.
export const DEFAULT_RULES = `\
- Lead with the outcome: what was done or what the answer is, in one or two sentences.
- Active voice. "The parser reads the file", not "the file is read by the parser".
- Use a verb for an action. "Analyze the log", not "perform an analysis of the log".
- Use the short common word: start (not commence), use (not utilize), make sure (not ensure), before (not prior to).
- One idea per sentence, at most 25 words. Split anything longer.
- One name for one thing. Do not call the same item by two different names.
- No filler or marketing adjectives: seamless, robust, powerful, effortlessly, "it is important to note".
- No semicolons. Write two sentences.
- Prefer bulleted lists over dense paragraphs when listing more than two things.
- When a technical term is unavoidable, add a brief inline explanation.
- These rules govern prose only. Keep ALL concrete technical content exactly as-is: code blocks, commands, file paths, line numbers, error messages, identifiers, flag names.
- Do not add information, opinions, or next steps that were not in the original.
- Do not drop caveats, warnings, or open questions.
- Roughly match the original's level of detail: compress rambling, never so much that substance is lost.`;

export interface LoadedRules {
  text: string;
  /** Absolute path of the rules file, or undefined when built-in defaults are in effect. */
  source: string | undefined;
}

let globalRulesPathOverride: string | undefined;

export function globalRulesPath(): string {
  return globalRulesPathOverride ?? join(homedir(), ".pi", "agent", RULES_FILE_NAME);
}

/** Test seam: redirect the global rules path away from the real home dir. */
export function setGlobalRulesPathForTest(path: string): void {
  globalRulesPathOverride = path;
}

export function clearGlobalRulesPathForTest(): void {
  globalRulesPathOverride = undefined;
}

/**
 * When the project is not trusted, the project LEGIBLE.md is skipped: its
 * content is sent verbatim to an authenticated LLM, which would let an
 * untrusted repo inject rewriter instructions.
 */
export function loadRules(cwd: string, options: { trusted?: boolean } = {}): LoadedRules {
  if (options.trusted !== false) {
    const projectPath = join(cwd, RULES_FILE_NAME);
    const fromProject = readRulesFile(projectPath);
    if (fromProject !== undefined) return { text: fromProject, source: projectPath };
  }

  const globalPath = globalRulesPath();
  const fromGlobal = readRulesFile(globalPath);
  if (fromGlobal !== undefined) return { text: fromGlobal, source: globalPath };

  return { text: DEFAULT_RULES, source: undefined };
}

function readRulesFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, "utf8").trim();
    return text.length === 0 ? undefined : text;
  } catch {
    return undefined;
  }
}
