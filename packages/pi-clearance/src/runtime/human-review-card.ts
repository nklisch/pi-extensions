/**
 * Human review card — plain-language rendering of a tool call under review.
 *
 * The approval surface answers three questions in prose: what the command
 * does, where it acts, and (via the policy reason) why the operator is being
 * asked. Raw tool input and the parsed shape JSON are debug material and
 * live behind `/clearance why`, never in an approval dialog.
 *
 * Copy philosophy: lead with the safety-relevant verb and effect class
 * ("Searches file contents — read-only"), not with parser vocabulary. A
 * program-specific verb map covers the common cases; everything else falls
 * back to the effect class so unrecognized programs are described by what
 * they can do, not by an empty label.
 */

import type { PathScope } from "../contracts/PathScope.ts";
import { classifyStageEffect } from "../parse/native-effects.ts";
import type { BashStage, ToolShape } from "../parse/shape.ts";
import { markdownCodeSpan } from "./markdown.ts";

export interface HumanReviewCard {
  /** Prose bullets describing behavior; always at least one entry. */
  readonly whatItDoes: readonly string[];
  /** Prose bullets for touched paths; empty when no path facts exist. */
  readonly whereItActs: readonly string[];
}

const MAX_BEHAVIOR_BULLETS = 3;
const MAX_PATH_BULLETS = 4;

export function buildHumanReviewCard(shape: ToolShape): HumanReviewCard {
  switch (shape.kind) {
    case "bash":
      return {
        whatItDoes: bashBehavior(shape.stages),
        whereItActs: pathBullets(shape.pathFacts?.facts ?? []),
      };
    case "pi-tool":
      return {
        whatItDoes: [describePiTool(shape)],
        whereItActs: pathBulletsFromToolFacts(shape),
      };
    case "unknown":
      return {
        whatItDoes: [
          `Runs the ${shape.toolName} tool, which Clearance could not analyze`,
        ],
        whereItActs: [],
      };
  }
}

/**
 * Operation-specific Pi tool descriptions. Non-mutation is NOT synonymous
 * with read-only: agent-dispatch and embedded-shell can do anything, and
 * interactive tools wait on the user. Unknown operations stay conservative.
 */
function describePiTool(
  shape: Extract<ToolShape, { readonly kind: "pi-tool" }>,
): string {
  switch (shape.operation) {
    case "read-file":
    case "list-directory":
    case "find-files":
    case "search-file-contents":
    case "status-read":
    case "state-read":
    case "workspace-search":
      return `Uses the Pi ${shape.toolName} tool (read-only)`;
    case "mutation":
      return `Uses the Pi ${shape.toolName} tool (modifies files)`;
    case "embedded-shell":
      return `Uses the Pi ${shape.toolName} tool, which runs shell commands (effects classified by the inner command)`;
    case "agent-dispatch":
      return `Uses the Pi ${shape.toolName} tool, which dispatches an agent that can run its own tool calls`;
    case "interactive":
      return `Uses the Pi ${shape.toolName} tool (asks you interactively)`;
    case "network-read":
      return `Uses the Pi ${shape.toolName} tool (network read)`;
    default:
      return `Uses the Pi ${shape.toolName} tool (effects could not be classified)`;
  }
}

/** Human scope labels; the vocabulary is location + trust, not config keys. */
const SCOPE_LABELS: Readonly<Record<PathScope, string>> = {
  "writable-project": "project (writable)",
  project: "project",
  temp: "temporary directory",
  home: "home, outside project",
  "safe-home": "home (approved directory)",
  "sensitive-home": "home (sensitive)",
  "agent-support": "agent support directory",
  system: "system path",
  outside: "outside the project",
  denied: "denied by your configuration",
  unknown: "location could not be determined",
};

function bashBehavior(stages: readonly BashStage[]): readonly string[] {
  if (stages.length === 0) return ["Runs a shell command"];
  const bullets: string[] = [];
  let remaining = 0;

  for (const [index, stage] of stages.entries()) {
    if (bullets.length >= MAX_BEHAVIOR_BULLETS) {
      remaining = stages.length - index;
      break;
    }
    bullets.push(describeStage(stage));
  }

  if (remaining > 0) bullets.push(`…and ${remaining} more`);
  return bullets;
}

function describeStage(stage: BashStage): string {
  switch (stage.kind) {
    case "command":
      return describeCommandStage(stage);
    case "subshell":
      return "Runs a subshell";
    case "control-flow":
      return `Uses ${CONTROL_FLOW_NOUNS[stage.construct] ?? `the ${stage.construct} shell construct`}, which Clearance does not model`;
    case "for-loop":
      return `Runs a for loop (${describeBodyPrograms(stage.body.pipeline.stages)})`;
    case "brace-group":
      return `Runs a command group (${describeBodyPrograms(stage.body.pipeline.stages)})`;
    case "conditional": {
      const bodyPrograms = stage.arms
        .flatMap((arm) =>
          arm.body.pipeline.stages.map((body) =>
            body.kind === "command" ? body.program.program : null,
          ),
        )
        .filter((program): program is string => program !== null);
      const suffix =
        bodyPrograms.length === 0
          ? ""
          : ` (${bodyPrograms.slice(0, 3).join(", ")}${bodyPrograms.length > 3 ? `, +${bodyPrograms.length - 3} more` : ""})`;
      return `Runs a conditional (if/then)${suffix}`;
    }
    case "unsupported":
      return `Could not be fully parsed (${stage.reason})`;
  }
}

function describeBodyPrograms(stages: readonly BashStage[]): string {
  const programs = stages
    .map((stage) => (stage.kind === "command" ? stage.program.program : null))
    .filter((program): program is string => program !== null);
  if (programs.length === 0) return "no direct commands";
  const shown = programs.slice(0, 3).join(", ");
  return programs.length > 3
    ? `body: ${shown}, +${programs.length - 3} more`
    : `body: ${shown}`;
}

/** Program-specific verbs for the commands that dominate review traffic. */
const PROGRAM_VERBS: Readonly<Record<string, string>> = {
  grep: "Searches file contents",
  rg: "Searches file contents",
  find: "Finds files",
  ls: "Lists directory contents",
  cat: "Prints file contents",
  head: "Prints the start of files",
  tail: "Prints the end of files",
  sed: "Transforms text",
  awk: "Processes text",
  jq: "Queries JSON",
  sort: "Sorts lines",
  wc: "Counts lines/words",
  diff: "Compares files",
  rm: "Deletes files",
  rmdir: "Deletes directories",
  mv: "Moves or renames files",
  cp: "Copies files",
  mkdir: "Creates directories",
  touch: "Creates or updates file timestamps",
  curl: "Makes a network request",
  wget: "Downloads from the network",
  ssh: "Opens a remote shell",
  git: "Runs git",
  node: "Runs Node.js",
  python: "Runs Python",
  python3: "Runs Python",
  sqlite3: "Runs SQLite",
};

const CONTROL_FLOW_NOUNS: Readonly<Record<string, string>> = {
  while: "a while loop",
  until: "an until loop",
  case: "a case statement",
  select: "a select menu",
  function: "a function definition",
  if: "an if conditional",
  for: "a for loop",
  "brace-group": "a brace group",
};

const EFFECT_FALLBACKS = {
  "read-only": "read-only",
  write: "modifies files",
  destructive: "destructive",
  network: "network access",
  "shell-wrap": "wraps another command",
  // "unknown" means the program is parsed but absent from the effect
  // registry — say that, not "unrecognized", which implies we don't know
  // what the program is (git push, pnpm install land here).
  unknown: "no effect classification",
} as const;

function describeCommandStage(
  stage: Extract<BashStage, { readonly kind: "command" }>,
): string {
  const program = stage.program.program;
  const effect = classifyStageEffect(stage);
  const effectLabel = EFFECT_FALLBACKS[effect.class];
  const verb = PROGRAM_VERBS[program];

  const traits: string[] = [];
  if (stage.substitutions.length > 0) traits.push("uses command substitution");
  const traitSuffix = traits.length === 0 ? "" : `; ${traits.join("; ")}`;

  if (verb === undefined) {
    return `Runs ${markdownCodeSpan(program)} (${effectLabel})${traitSuffix}`;
  }
  const object = program === "git" ? (firstGitSubcommand(stage) ?? "") : "";
  return `${verb} ${object}(${effectLabel})${traitSuffix}`;
}

/** Leading git options that consume a value; skip them to find the subcommand. */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

function firstGitSubcommand(
  stage: Extract<BashStage, { readonly kind: "command" }>,
): string | undefined {
  const args = stage.program.arguments;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) return undefined;
    if (GIT_VALUE_OPTIONS.has(argument)) {
      index += 1; // skip the option's value
      continue;
    }
    if (argument.startsWith("-")) continue;
    return `${argument} `;
  }
  return undefined;
}

function pathBullets(
  facts: readonly { readonly raw: string; readonly scope: PathScope }[],
): readonly string[] {
  if (facts.length === 0) return [];
  const bullets = facts
    .slice(0, MAX_PATH_BULLETS)
    .map(
      (fact) => `${markdownCodeSpan(fact.raw)} — ${SCOPE_LABELS[fact.scope]}`,
    );
  if (facts.length > MAX_PATH_BULLETS) {
    bullets.push(`…and ${facts.length - MAX_PATH_BULLETS} more paths`);
  }
  return bullets;
}

function pathBulletsFromToolFacts(
  shape: Extract<ToolShape, { readonly kind: "pi-tool" }>,
): readonly string[] {
  return pathBullets(shape.pathFacts?.facts ?? []);
}
