import { PNPM_KNOWN_SUBCOMMANDS } from "./bash.packages.common.ts";
import type { RawMatcher } from "./condition-guards.ts";
import { defineShippedPack } from "./define.ts";

const VERIFY_SCRIPT_NAMES = ["test", "build", "lint", "typecheck"] as const;
const SCRIPT_NAME_PATTERN = "[A-Za-z][A-Za-z0-9:_-]*";
const NPM_KNOWN_SUBCOMMANDS = [
  "install",
  "i",
  "ci",
  "add",
  "update",
  "up",
  "remove",
  "rm",
  "uninstall",
  "un",
  "outdated",
  "audit",
  "view",
  "info",
  "list",
  "ls",
  "run",
  "run-script",
  "exec",
  "publish",
  "pack",
  "link",
  "unlink",
  "init",
  "version",
  "config",
  "prefix",
  "root",
  "bin",
  "cache",
  "fund",
  "doctor",
  "help",
] as const;
const YARN_KNOWN_SUBCOMMANDS = [
  "install",
  "add",
  "remove",
  "upgrade",
  "up",
  "global",
  "run",
  "exec",
  "dlx",
  "publish",
  "pack",
  "link",
  "unlink",
  "init",
  "config",
  "why",
  "list",
  "info",
  "version",
  "set",
  "cache",
  "node",
  "workspaces",
  "plugin",
  "import",
  "dedupe",
  "patch",
] as const;

const PROJECT_SCOPED_WRITE_SCOPES = [
  "project",
  "writable-project",
  "temp",
] as const;

/**
 * A formatter write is safe only when every extracted file operand is inside
 * the configured work scopes. Escape flags remain explicit review boundaries:
 * a formatter can load config, plugins, parsers, or output destinations from
 * outside the worktree even when its visible file operands are local.
 */
function projectScopedFormatterWriteRule(options: {
  readonly id: string;
  readonly program: string;
  readonly writeMatcher: RawMatcher;
  readonly escapeFlags: readonly string[];
  readonly escapeShortChars?: readonly string[];
  readonly escapeArgumentPattern?: string;
  readonly commandMatchers?: readonly RawMatcher[];
  readonly reason: string;
}) {
  const escapeFlagMatcher: RawMatcher = {
    not: {
      flagMatches: {
        names: [...options.escapeFlags],
        ...(options.escapeShortChars === undefined
          ? {}
          : { shortChars: [...options.escapeShortChars] }),
      },
    },
  };

  return {
    id: options.id,
    effect: "allow",
    match: {
      all: [
        { program: options.program },
        ...(options.commandMatchers ?? []),
        options.writeMatcher,
        escapeFlagMatcher,
        ...(options.escapeArgumentPattern === undefined
          ? []
          : [{ not: { anyArgMatches: options.escapeArgumentPattern } }]),
        { noSubstitution: true },
        { noStdoutRedirect: true },
        {
          pathScopesAllIn: {
            scopes: [...PROJECT_SCOPED_WRITE_SCOPES],
            programs: [options.program],
            usages: ["argument"],
            requireFacts: "per-command-stage",
          },
        },
      ],
    },
    reason: options.reason,
    provenance: { source: "shipped" },
  };
}

const CARGO_FMT_ESCAPE_FLAGS = [
  "manifest-path",
  "config-path",
  "config",
  "unstable-features",
  "print-config",
  "emit",
] as const;
const CARGO_FMT_ESCAPE_ARGUMENT_PATTERN =
  "--(?:manifest-path|config-path|config|unstable-features|print-config|emit)(?:=.*)?";

const formatterWriteRules = [
  projectScopedFormatterWriteRule({
    id: "bash.dev.verify:allow-biome-project-write",
    program: "biome",
    writeMatcher: { flagPresent: "write" },
    escapeFlags: ["config-path", "config", "unsafe"],
    reason: "biome write stays inside configured project/temp path scope",
  }),
  projectScopedFormatterWriteRule({
    id: "bash.dev.verify:allow-prettier-project-write",
    program: "prettier",
    writeMatcher: { flagPresent: "write" },
    escapeFlags: [
      "config",
      "config-path",
      "plugin",
      "plugin-search-dir",
      "ignore-path",
      "stdin-filepath",
    ],
    reason: "prettier write stays inside configured project/temp path scope",
  }),
  projectScopedFormatterWriteRule({
    id: "bash.dev.verify:allow-ruff-project-fix",
    program: "ruff",
    commandMatchers: [{ arg0In: ["check"] }],
    writeMatcher: { flagPresent: "fix" },
    escapeFlags: ["config", "extend", "output-file"],
    reason: "ruff fix stays inside configured project/temp path scope",
  }),
  projectScopedFormatterWriteRule({
    id: "bash.dev.verify:allow-eslint-project-fix",
    program: "eslint",
    writeMatcher: { flagPresent: "fix" },
    escapeFlags: [
      "config",
      "rulesdir",
      "resolve-plugins-relative-to",
      "plugin",
      "parser",
    ],
    escapeShortChars: ["c"],
    reason: "eslint fix stays inside configured project/temp path scope",
  }),
  projectScopedFormatterWriteRule({
    id: "bash.dev.verify:allow-cargo-fmt-project-files",
    program: "cargo",
    commandMatchers: [
      { arg0In: ["fmt"] },
      // `cargo fmt -- <file>` passes the file to rustfmt. It is allowed only
      // after the path-fact extractor proves that the operand is local.
    ],
    writeMatcher: { always: true },
    escapeFlags: CARGO_FMT_ESCAPE_FLAGS,
    escapeArgumentPattern: CARGO_FMT_ESCAPE_ARGUMENT_PATTERN,
    reason: "cargo fmt files stay inside configured project/temp path scope",
  }),
];

/**
 * Cargo's normal invocation has no file operand: rustfmt uses the current
 * project root. Keep that proof separate from the path-bearing form so an
 * arbitrary `cargo fmt -- <path>` cannot inherit cwd trust.
 */
const cargoFmtCwdRule = {
  id: "bash.dev.verify:allow-cargo-fmt-cwd",
  effect: "allow",
  match: {
    all: [
      { program: "cargo" },
      { arg0In: ["fmt"] },
      // `fmt` itself is arg0; max 1 excludes every explicit path operand.
      { argCount: { max: 1 } },
      {
        not: {
          flagMatches: { names: [...CARGO_FMT_ESCAPE_FLAGS] },
        },
      },
      { not: { anyArgMatches: CARGO_FMT_ESCAPE_ARGUMENT_PATTERN } },
      { noSubstitution: true },
      { noStdoutRedirect: true },
    ],
  },
  reason: "cargo fmt uses the current configured project root",
  provenance: { source: "shipped" },
};

const formatterCwdRule = (options: {
  readonly id: string;
  readonly program: string;
  readonly arg0In?: readonly string[];
  readonly maxArgs: number;
  readonly writeFlag: string;
  readonly escapeFlags: readonly string[];
  readonly reason: string;
}) => ({
  id: options.id,
  effect: "allow",
  match: {
    all: [
      { program: options.program },
      ...(options.arg0In === undefined
        ? []
        : [{ arg0In: [...options.arg0In] }]),
      { flagPresent: options.writeFlag },
      // Cwd-implicit form only: no explicit file operands beyond the
      // subcommand word, so scope proof is the configured project root
      // (owner decision 2, 2026-07-23).
      { argCount: { max: options.maxArgs } },
      { not: { flagMatches: { names: [...options.escapeFlags] } } },
      { noSubstitution: true },
      { noStdoutRedirect: true },
    ],
  },
  reason: options.reason,
  provenance: { source: "shipped" as const },
});

const formatterEscapeReviewRules = [
  {
    id: "bash.dev.verify:review-biome-escape-flags",
    effect: "review",
    match: {
      stageSome: {
        all: [
          { program: "biome" },
          {
            flagMatches: {
              names: ["config-path", "config", "unsafe"],
            },
          },
        ],
      },
    },
    reason: "biome config or unsafe-write flags require review",
    provenance: { source: "shipped" },
  },
  {
    id: "bash.dev.verify:review-prettier-escape-flags",
    effect: "review",
    match: {
      stageSome: {
        all: [
          { program: "prettier" },
          {
            flagMatches: {
              names: [
                "config",
                "config-path",
                "plugin",
                "plugin-search-dir",
                "ignore-path",
                "stdin-filepath",
              ],
            },
          },
        ],
      },
    },
    reason: "prettier config, plugin, or external-path flags require review",
    provenance: { source: "shipped" },
  },
  {
    id: "bash.dev.verify:review-ruff-escape-flags",
    effect: "review",
    match: {
      stageSome: {
        all: [
          { program: "ruff" },
          {
            flagMatches: {
              names: ["config", "extend", "output-file"],
            },
          },
        ],
      },
    },
    reason: "ruff config, extension, or output-path flags require review",
    provenance: { source: "shipped" },
  },
  {
    id: "bash.dev.verify:review-eslint-escape-flags",
    effect: "review",
    match: {
      stageSome: {
        all: [
          { program: "eslint" },
          {
            flagMatches: {
              names: [
                "config",
                "rulesdir",
                "resolve-plugins-relative-to",
                "plugin",
                "parser",
              ],
              shortChars: ["c"],
            },
          },
        ],
      },
    },
    reason: "eslint config, rules, plugin, or parser flags require review",
    provenance: { source: "shipped" },
  },
  {
    id: "bash.dev.verify:review-cargo-fmt-escape-flags",
    effect: "review",
    match: {
      stageSome: {
        all: [
          { program: "cargo" },
          { arg0In: ["fmt"] },
          {
            any: [
              {
                flagMatches: {
                  names: [...CARGO_FMT_ESCAPE_FLAGS],
                },
              },
              { anyArgMatches: CARGO_FMT_ESCAPE_ARGUMENT_PATTERN },
            ],
          },
        ],
      },
    },
    reason:
      "cargo fmt config, manifest, or unstable rustfmt flags require review",
    provenance: { source: "shipped" },
  },
];

const packageRunnerDirectRules = ["pnpm", "npm", "yarn"].flatMap((program) =>
  VERIFY_SCRIPT_NAMES.map((script) => ({
    id: `bash.dev.verify:allow-${program}-${script}`,
    effect: "allow",
    match: {
      all: [
        { program },
        { arg0In: [script] },
        { noSubstitution: true },
        { noStdoutRedirect: true },
      ],
    },
    reason: `${program} ${script} project verification command`,
    provenance: { source: "shipped" },
  })),
);

// Keep the pre-existing npm/yarn named rules for stable provenance. Pnpm's
// named run rules are subsumed by the generalized matcher below.
const packageRunnerScriptRules = ["npm", "yarn"].flatMap((program) =>
  ["run", "run-script"].flatMap((runner) =>
    VERIFY_SCRIPT_NAMES.map((script) => ({
      id: `bash.dev.verify:allow-${program}-${runner}-${script}`,
      effect: "allow",
      match: {
        all: [
          { program },
          { arg0In: [runner] },
          { argAt: { index: 1, value: script } },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: `${program} ${runner} ${script} project verification command`,
      provenance: { source: "shipped" },
    })),
  ),
);

const packageRunnerShorthandRules = [
  ["pnpm", PNPM_KNOWN_SUBCOMMANDS],
  ["npm", NPM_KNOWN_SUBCOMMANDS],
  ["yarn", YARN_KNOWN_SUBCOMMANDS],
] as const;

const packageRunnerScriptWideningRules = packageRunnerShorthandRules.map(
  ([program]) => ({
    id: `bash.dev.verify:allow-${program}-run-script`,
    effect: "allow",
    match: {
      all: [
        { program },
        { arg0In: ["run", "run-script"] },
        { argMatches: { index: 1, pattern: SCRIPT_NAME_PATTERN } },
        { noSubstitution: true },
        { noStdoutRedirect: true },
      ],
    },
    reason: `${program} run/run-script arbitrary project script`,
    provenance: { source: "shipped" },
  }),
);

const packageRunnerShorthandWideningRules = packageRunnerShorthandRules.map(
  ([program, knownSubcommands]) => ({
    id: `bash.dev.verify:allow-${program}-script-shorthand`,
    effect: "allow",
    match: {
      all: [
        { program },
        { argMatches: { index: 0, pattern: SCRIPT_NAME_PATTERN } },
        { not: { arg0In: [...knownSubcommands] } },
        { noSubstitution: true },
        { noStdoutRedirect: true },
      ],
    },
    reason: `${program} arbitrary project script shorthand`,
    provenance: { source: "shipped" },
  }),
);

const rawPack = {
  version: 1,
  id: "bash.dev.verify",
  rules: [
    {
      id: "bash.dev.verify:review-project-context-flags",
      effect: "review",
      match: {
        stageSome: {
          all: [
            {
              any: [
                { program: "pnpm" },
                { program: "npm" },
                { program: "yarn" },
              ],
            },
            {
              any: [
                { flagPresent: "dir" },
                { flagPresent: "prefix" },
                { flagPresent: "cwd" },
              ],
            },
          ],
        },
      },
      reason: "package runner project-context flags require review",
      provenance: { source: "shipped" },
    },
    ...formatterEscapeReviewRules,
    {
      id: "bash.dev.verify:review-mutating-format-flags",
      effect: "review",
      match: {
        stageSome: {
          all: [
            { program: "vitest" },
            {
              any: [
                { flagPresent: "write" },
                { flagPresent: "apply" },
                { flagPresent: "fix" },
                { flagPresent: "u" },
                { flagPresent: "update" },
              ],
            },
          ],
        },
      },
      reason: "mutating test-runner flags require review",
      provenance: { source: "shipped" },
    },
    ...formatterWriteRules,
    cargoFmtCwdRule,
    formatterCwdRule({
      id: "bash.dev.verify:allow-biome-write-cwd",
      program: "biome",
      arg0In: ["check", "format"],
      maxArgs: 1,
      writeFlag: "write",
      escapeFlags: ["config-path", "config", "unsafe"],
      reason: "biome write uses the current configured project root",
    }),
    formatterCwdRule({
      id: "bash.dev.verify:allow-prettier-write-cwd",
      program: "prettier",
      maxArgs: 0,
      writeFlag: "write",
      escapeFlags: [
        "config",
        "config-path",
        "plugin",
        "plugin-search-dir",
        "parser",
        "ignore-path",
      ],
      reason: "prettier write uses the current configured project root",
    }),
    formatterCwdRule({
      id: "bash.dev.verify:allow-eslint-fix-cwd",
      program: "eslint",
      maxArgs: 0,
      writeFlag: "fix",
      escapeFlags: ["config", "c", "rulesdir", "resolve-plugins-relative-to"],
      reason: "eslint fix uses the current configured project root",
    }),
    formatterCwdRule({
      id: "bash.dev.verify:allow-ruff-fix-cwd",
      program: "ruff",
      arg0In: ["check"],
      maxArgs: 1,
      writeFlag: "fix",
      escapeFlags: ["config", "target-version"],
      reason: "ruff fix uses the current configured project root",
    }),
    ...packageRunnerDirectRules,
    ...packageRunnerScriptRules,
    ...packageRunnerShorthandWideningRules,
    ...packageRunnerScriptWideningRules,
    {
      id: "bash.dev.verify:allow-make",
      effect: "allow",
      match: {
        all: [
          { program: "make" },
          {
            not: {
              flagMatches: {
                names: ["f", "file", "makefile", "eval", "C", "directory"],
                shortChars: ["f", "C"],
              },
            },
          },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason:
        "make project verification without file or directory escape flags",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-node-script",
      effect: "allow",
      match: {
        all: [
          { program: "node" },
          { argCount: { min: 1 } },
          { not: { argAt: { index: 0, value: "-" } } },
          {
            not: {
              flagMatches: {
                names: [
                  "eval",
                  "print",
                  "input-type",
                  "loader",
                  "experimental-loader",
                  "import",
                  "require",
                  "env-file",
                  "env-file-if-exists",
                  "inspect",
                  "inspect-brk",
                ],
                shortChars: ["e", "p", "r"],
              },
            },
          },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "node literal script-file verification command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-node-help-version",
      effect: "allow",
      match: {
        all: [
          { program: "node" },
          { argCount: { max: 0 } },
          { flagAllowlist: { names: ["version", "help", "v", "h"] } },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "node help/version inspection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-tsx-script",
      effect: "allow",
      match: {
        all: [
          { program: "tsx" },
          { argCount: { min: 1 } },
          { not: { argAt: { index: 0, value: "-" } } },
          {
            not: {
              flagMatches: {
                names: [
                  "eval",
                  "print",
                  "input-type",
                  "loader",
                  "experimental-loader",
                  "import",
                  "require",
                  "env-file",
                  "env-file-if-exists",
                  "inspect",
                  "inspect-brk",
                ],
                shortChars: ["e", "p", "r"],
              },
            },
          },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "tsx literal script-file verification command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-python-module-tests",
      effect: "allow",
      match: {
        all: [
          { any: [{ program: "python3" }, { program: "python" }] },
          { flagAllowlist: { shortChars: ["m"] } },
          { arg0In: ["pytest", "json.tool", "unittest"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "python module-based verification command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-cargo-test-build-check",
      effect: "allow",
      match: {
        all: [
          { program: "cargo" },
          { arg0In: ["test", "build", "check", "run"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "cargo test/build/check verification command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-cargo-clippy",
      effect: "allow",
      match: {
        all: [
          { program: "cargo" },
          { arg0In: ["clippy"] },
          { not: { flagMatches: { names: ["fix"] } } },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "cargo clippy verification without mutation flags",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-cargo-fmt-check",
      effect: "allow",
      match: {
        all: [
          { program: "cargo" },
          { arg0In: ["fmt"] },
          { flagPresent: "check" },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "cargo fmt check verification command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-go-test-build-vet",
      effect: "allow",
      match: {
        all: [
          { program: "go" },
          { arg0In: ["test", "build", "vet", "run"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "go test/build/vet verification command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-standalone-test-runners",
      effect: "allow",
      match: {
        any: [
          {
            all: [
              { program: "vitest" },
              { noSubstitution: true },
              { noStdoutRedirect: true },
            ],
          },
          {
            all: [
              { program: "jest" },
              { noSubstitution: true },
              { noStdoutRedirect: true },
            ],
          },
          {
            all: [
              { program: "pytest" },
              { noSubstitution: true },
              { noStdoutRedirect: true },
            ],
          },
        ],
      },
      reason: "standalone test runner verification command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-tsc",
      effect: "allow",
      match: {
        all: [
          { program: "tsc" },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "TypeScript compiler/typecheck command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-biome-verify",
      effect: "allow",
      match: {
        all: [
          { program: "biome" },
          { arg0In: ["check", "format", "lint"] },
          {
            not: {
              flagMatches: { names: ["write", "apply", "fix", "unsafe"] },
            },
          },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason:
        "biome check/format/lint verification command without mutating flags",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-eslint",
      effect: "allow",
      match: {
        all: [
          { program: "eslint" },
          { not: { flagMatches: { names: ["fix", "fix-dry-run"] } } },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "eslint lint verification command without fix flag",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-prettier-check",
      effect: "allow",
      match: {
        all: [
          { program: "prettier" },
          { flagPresent: "check" },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "prettier check verification command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-ruff-check",
      effect: "allow",
      match: {
        all: [
          { program: "ruff" },
          { arg0In: ["check"] },
          { not: { flagMatches: { names: ["fix", "fix-only"] } } },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "ruff check verification command without fix flag",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.dev.verify:allow-mypy",
      effect: "allow",
      match: {
        all: [
          { program: "mypy" },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "mypy typecheck verification command",
      provenance: { source: "shipped" },
    },
  ],
} as const;

// Formatter writes are direct, path-scoped allows only. They must not become
// composition families: a write hidden in a heterogeneous chain would need a
// separate whole-command write contract rather than the read-only composition
// proof used by bash.structure.safe.
const FORMATTER_WRITE_RULE_IDS = new Set([
  ...formatterWriteRules.map((rule) => rule.id),
  cargoFmtCwdRule.id,
]);

/** Allow rules that are safe to reuse as read-only/dev verification stages. */
export const BASH_DEV_VERIFY_STAGE_FAMILY_MATCHERS: readonly RawMatcher[] =
  rawPack.rules
    .filter(
      (rule) =>
        rule.effect === "allow" && !FORMATTER_WRITE_RULE_IDS.has(rule.id),
    )
    .map((rule) => rule.match as RawMatcher);

export const bashDevVerifyPack = defineShippedPack(rawPack);
