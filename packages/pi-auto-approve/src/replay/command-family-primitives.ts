/**
 * Shared semantic-argument extraction for user-facing allow briefs.
 *
 * Replay family construction is native; this small authoring helper remains
 * TypeScript because it only formats a recent command for the Pi UI.
 */
/** Empty set shared by unknown programs (no known global options). */
const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Known global options for common dev CLIs. `valueTaking` options consume the next
 * positional token as their value (e.g. `git -C <path>`); `boolean` options are flags
 * only. This is grouping metadata, not a rule matcher — it exists so `git -C /repo
 * status` groups with `git status`. Short flag names are case-sensitive (`git -C` path
 * vs `git -c` config).
 */
interface ProgramGlobals {
  readonly valueTaking: ReadonlySet<string>;
  readonly boolean: ReadonlySet<string>;
}

const GLOBAL_OPTIONS: ReadonlyMap<string, ProgramGlobals> = new Map([
  [
    "git",
    {
      valueTaking: new Set(["C", "c", "git-dir", "work-tree", "namespace"]),
      boolean: new Set([
        "P",
        "p",
        "paginate",
        "no-pager",
        "bare",
        "no-replace-objects",
        "literal-pathspecs",
        "glob-pathspecs",
        "noglob-pathspecs",
        "icase-pathspecs",
        "no-optional-locks",
      ]),
    },
  ],
  [
    "gh",
    {
      valueTaking: new Set(["hostname", "R", "repo", "config"]),
      boolean: new Set(["h", "help", "V", "version"]),
    },
  ],
  [
    "npm",
    {
      valueTaking: new Set([
        "prefix",
        "registry",
        "cache",
        "userconfig",
        "globalconfig",
        "loglevel",
        "location",
        "omit",
        "workspace",
        "w",
      ]),
      boolean: new Set([
        "g",
        "global",
        "no-update-notifier",
        "no-fund",
        "no-audit",
        "foreground-scripts",
        "s",
        "silent",
        "q",
        "quiet",
        "d",
        "dd",
        "ddd",
        "v",
        "verbose",
        "no-color",
      ]),
    },
  ],
  [
    "pnpm",
    {
      valueTaking: new Set([
        "C",
        "dir",
        "config",
        "filter",
        "loglevel",
        "namespace",
        "registry",
        "store-dir",
        "package-import-method",
      ]),
      boolean: new Set([
        "g",
        "global",
        "no-color",
        "stream",
        "s",
        "silent",
        "no-progress",
        "h",
        "help",
        "v",
        "version",
        "reporter",
      ]),
    },
  ],
  [
    "yarn",
    {
      valueTaking: new Set([
        "cwd",
        "mutex",
        "network-concurrency",
        "network-timeout",
        "preferred-cache",
        "prefer-offline",
      ]),
      boolean: new Set([
        "g",
        "global",
        "silent",
        "verbose",
        "v",
        "version",
        "h",
        "help",
        "no-color",
      ]),
    },
  ],
  [
    "cargo",
    {
      valueTaking: new Set([
        "C",
        "config",
        "manifest-path",
        "target",
        "target-dir",
        "Z",
      ]),
      boolean: new Set([
        "frozen",
        "locked",
        "offline",
        "q",
        "quiet",
        "v",
        "verbose",
        "release",
        "color",
        "h",
        "help",
      ]),
    },
  ],
  [
    "go",
    {
      valueTaking: new Set(["C"]),
      boolean: new Set(["h", "help", "v", "version", "V"]),
    },
  ],
]);

export function firstSemanticArgument(
  program: string,
  args: readonly string[],
): string | undefined {
  const globals = GLOBAL_OPTIONS.get(normalizeProgramName(program));
  const valueTaking = globals?.valueTaking ?? EMPTY_SET;

  const flags: string[] = [];
  const positionals: string[] = [];
  let noMoreFlags = false;
  for (const token of args) {
    if (!noMoreFlags && token === "--") {
      noMoreFlags = true;
      continue;
    }
    if (!noMoreFlags && isFlagToken(token)) {
      flags.push(token);
    } else {
      positionals.push(token);
    }
  }

  let positionalIndex = 0;
  for (const flag of flags) {
    if (isInlineValueFlag(flag)) {
      continue; // self-contained: --name=value or -Xvalue
    }
    const name = flagName(flag);
    if (valueTaking.has(name) && positionalIndex < positionals.length) {
      positionalIndex++; // consume the next positional as this flag's value
    }
  }

  return positionals[positionalIndex];
}

function normalizeProgramName(program: string): string {
  const base = program.split("/").pop() ?? program;
  return base.toLowerCase();
}

function isFlagToken(token: string): boolean {
  return token.startsWith("-") && token.length > 1 && token !== "--";
}

/** Self-contained flag that carries its own value: `--name=value` or `-Xvalue` (len>2). */
function isInlineValueFlag(token: string): boolean {
  if (token.startsWith("--")) {
    return token.includes("=");
  }
  // Single-dash short flag longer than 2 chars embeds its value (-Cdir) or bundles
  // boolean shorts (-xyz); either way it does not consume the next positional.
  return token.length > 2;
}

function flagName(token: string): string {
  if (token.startsWith("--")) {
    const body = token.slice(2);
    const equals = body.indexOf("=");
    return equals === -1 ? body : body.slice(0, equals);
  }
  return token.slice(1, 2);
}
