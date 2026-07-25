import { defineShippedPack } from "./define.ts";
import { BENIGN_REDIRECT_STRUCTURE } from "./redirect-safety.ts";

const DANGEROUS_ENV_ASSIGNMENT_NAMES = [
  "PATH",
  "CDPATH",
  "IFS",
  "SHELL",
  "HOME",
  "ENV",
  "BASH_ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PROMPT_COMMAND",
  "PS4",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "RUSTC",
  "RUSTC_WRAPPER",
  "CARGO",
  "RUSTFLAGS",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTDOC",
  "CARGO_BUILD_RUNNER",
  "MAKE",
  "MAKEFILES",
  "MAKEFLAGS",
  "GOFLAGS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_INDEX_FILE",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "BROWSER",
  "CC",
  "CXX",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "PIP_INDEX_URL",
  "PIP_EXTRA_INDEX_URL",
] as const;

const rawPack = {
  version: 1,
  id: "bash.review.risky",
  rules: [
    {
      id: "bash.review.risky:review-dangerous-env-assignment",
      effect: "review",
      match: {
        envAssignmentNameIn: {
          names: [...DANGEROUS_ENV_ASSIGNMENT_NAMES],
          prefixes: ["LD_", "DYLD_", "GIT_CONFIG_", "CARGO_TARGET_"],
          caseInsensitivePrefixes: ["npm_config_"],
        },
      },
      reason:
        "environment assignment can alter loaders, runtimes, toolchains, or package configuration",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-pipe-to-shell",
      effect: "review",
      match: {
        any: [{ pipeline: "sh" }, { pipeline: "bash" }, { pipeline: "zsh" }],
      },
      reason: "pipeline feeds a shell interpreter",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-shell-interpreter",
      effect: "review",
      match: {
        any: [
          { program: "bash" },
          { program: "sh" },
          { program: "zsh" },
          { program: "dash" },
          { program: "fish" },
          { program: "ksh" },
        ],
      },
      reason: "shell interpreter invocation is opaque to structural analysis",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-substitution",
      effect: "review",
      // Projected compound forms are handled by bash.review.compound so users
      // get the more specific compound provenance. Add future projected forms
      // here when the parser grows beyond for/brace/if.
      match: {
        all: [
          { stageSome: { not: { noSubstitution: true } } },
          { not: { compoundForm: "for" } },
          { not: { compoundForm: "brace-group" } },
          { not: { compoundForm: "if" } },
        ],
      },
      reason: "command, process, or variable substitution hides behavior",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-stdin-redirect",
      effect: "review",
      match: { stageSome: { redirect: { stream: "stdin" } } },
      reason: "input redirect may expose secret files or heredoc content",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-stdout-redirect",
      effect: "review",
      match: {
        all: [
          {
            stageSome: {
              any: [
                { redirect: { stream: "stdout", targetKind: "file" } },
                { redirect: { stream: "both", targetKind: "file" } },
                { redirect: { stream: "fd", targetKind: "file" } },
              ],
            },
          },
          { not: BENIGN_REDIRECT_STRUCTURE },
        ],
      },
      reason: "stdout or file-descriptor redirect writes to a file",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-or-operator",
      effect: "review",
      match: {
        all: [
          { operator: "or" },
          {
            not: {
              composition: {
                stage: { always: true },
                operators: ["and", "seq"],
                orFallback: ["true", ":"],
              },
            },
          },
        ],
      },
      reason: "or-fallback composition cannot be proven safely in v1",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-background",
      effect: "review",
      match: { operator: "background" },
      reason: "backgrounded command is detached and harder to reason about",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-git-push",
      effect: "review",
      match: { all: [{ program: "git" }, { arg0In: ["push"] }] },
      reason: "git push changes a remote and requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-git-reset",
      effect: "review",
      match: { all: [{ program: "git" }, { arg0In: ["reset"] }] },
      reason: "git reset moves local history and requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-git-clean",
      effect: "review",
      match: { all: [{ program: "git" }, { arg0In: ["clean"] }] },
      reason: "git clean removes working-tree files and requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-git-branch-destructive",
      effect: "review",
      match: {
        all: [
          { program: "git" },
          { arg0In: ["branch"] },
          {
            flagMatches: {
              names: ["d", "D", "delete", "f", "force"],
              shortChars: ["d", "D", "f"],
            },
          },
        ],
      },
      reason: "git branch deletion or force update requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-git-tag-destructive",
      effect: "review",
      match: {
        all: [
          { program: "git" },
          { arg0In: ["tag"] },
          {
            flagMatches: {
              names: ["d", "delete", "f", "force"],
              shortChars: ["d", "f"],
            },
          },
        ],
      },
      reason: "git tag deletion or force update requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-git-checkout-destructive",
      effect: "review",
      match: {
        all: [
          { program: "git" },
          { arg0In: ["checkout"] },
          {
            flagMatches: {
              names: ["B", "force", "f"],
              shortChars: ["B", "f"],
            },
          },
        ],
      },
      reason: "git checkout forcefully replaces branch or worktree state",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-git-worktree-mutation",
      effect: "review",
      match: {
        all: [
          { program: "git" },
          { arg0In: ["worktree"] },
          { not: { argAt: { index: 1, value: "list" } } },
        ],
      },
      reason: "git worktree mutation requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-git-stash-mutation",
      effect: "review",
      match: {
        all: [
          { program: "git" },
          { arg0In: ["stash"] },
          { not: { argAt: { index: 1, value: "list" } } },
        ],
      },
      reason: "git stash mutation requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-git-remote-mutation",
      effect: "review",
      match: {
        all: [
          { program: "git" },
          { arg0In: ["remote"] },
          {
            any: [
              { argAt: { index: 1, value: "add" } },
              { argAt: { index: 1, value: "remove" } },
              { argAt: { index: 1, value: "rm" } },
              { argAt: { index: 1, value: "rename" } },
              { argAt: { index: 1, value: "set-url" } },
              { argAt: { index: 1, value: "set-head" } },
              { argAt: { index: 1, value: "set-branches" } },
              { argAt: { index: 1, value: "prune" } },
              { argAt: { index: 1, value: "update" } },
              {
                not: {
                  any: [
                    { argAt: { index: 1, value: "show" } },
                    { argAt: { index: 1, value: "get-url" } },
                    { flagMatches: { names: ["v", "verbose"] } },
                  ],
                },
              },
            ],
          },
        ],
      },
      reason: "git remote mutation requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-git-switch-force",
      effect: "review",
      match: {
        all: [
          { program: "git" },
          { arg0In: ["switch"] },
          {
            flagMatches: {
              names: ["f", "force", "C", "force-create", "discard-changes"],
              shortChars: ["f", "C"],
            },
          },
        ],
      },
      reason: "git switch force flag can discard local changes",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-unmodeled-leading-option",
      effect: "review",
      match: { diagnosticCode: "bash:leading-option-unmodeled" },
      reason: "unmodeled leading option prevents safe subcommand projection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.review.risky:review-recursive-rm",
      effect: "review",
      match: {
        all: [
          { program: "rm" },
          {
            any: [
              { flagPresent: "r" },
              { flagPresent: "R" },
              { flagPresent: "recursive" },
              { flagPresent: "rf" },
              { flagPresent: "fr" },
            ],
          },
        ],
      },
      reason: "recursive delete outside the catastrophic floor case",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const bashReviewRiskyPack = defineShippedPack(rawPack);
