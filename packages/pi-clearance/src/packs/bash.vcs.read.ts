import type { RawMatcher } from "./condition-guards.ts";
import { defineShippedPack } from "./define.ts";

const GIT_READ_SUBCOMMANDS = [
  "status",
  "log",
  "diff",
  "show",
  "ls-files",
  "rev-parse",
  "blame",
  "grep",
  "ls-tree",
  "cat-file",
  "merge-base",
  "describe",
  "shortlog",
  "show-ref",
  "check-ignore",
  "name-rev",
  "count-objects",
  "ls-remote",
  "diff-tree",
  "diff-index",
] as const;

const gitReadMatcher: RawMatcher = {
  all: [
    { program: "git" },
    { arg0In: [...GIT_READ_SUBCOMMANDS] },
    { not: { flagMatches: { names: ["output"] } } },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const gitHelpMatcher: RawMatcher = {
  all: [
    { program: "git" },
    { flagPresent: "help" },
    { not: { flagMatches: { names: ["output"] } } },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const gitVersionMatcher: RawMatcher = {
  all: [
    { program: "git" },
    { flagPresent: "version" },
    { not: { flagMatches: { names: ["output"] } } },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const gitBranchMatcher: RawMatcher = {
  all: [
    { program: "git" },
    { arg0In: ["branch"] },
    {
      not: {
        flagMatches: {
          names: ["d", "D", "delete", "f", "force"],
          shortChars: ["d", "D", "f"],
        },
      },
    },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const gitTagMatcher: RawMatcher = {
  all: [
    { program: "git" },
    { arg0In: ["tag"] },
    {
      not: {
        flagMatches: {
          names: ["d", "delete", "f", "force"],
          shortChars: ["d", "f"],
        },
      },
    },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const gitRemoteMatchers: readonly RawMatcher[] = [
  { argAt: { index: 1, value: "show" } },
  { argAt: { index: 1, value: "get-url" } },
  { flagPresent: "v" },
  { flagPresent: "verbose" },
  // This allow is intentionally broad: `git remote -v add ...` also matches,
  // but the paired review-git-remote-mutation gate (mutating subactions)
  // wins by review > allow precedence — the same defense-in-depth pair as
  // checkout -b. A positive "no subaction" allow clause would be
  // undecidable for the floor-overlap checker.
].map((condition) => ({
  all: [
    { program: "git" },
    { arg0In: ["remote"] },
    condition,
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
}));

const gitConfigMatchers: readonly RawMatcher[] = [
  "get",
  "get-all",
  "get-regexp",
  "list",
  "l",
].map((flag) => ({
  all: [
    { program: "git" },
    { arg0In: ["config"] },
    { flagPresent: flag },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
}));

const gitStashListMatcher: RawMatcher = {
  all: [
    { program: "git" },
    { arg0In: ["stash"] },
    { argAt: { index: 1, value: "list" } },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const gitWorktreeListMatcher: RawMatcher = {
  all: [
    { program: "git" },
    { arg0In: ["worktree"] },
    { argAt: { index: 1, value: "list" } },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const ghActionMatchers = (
  arg0: string,
  actions: readonly string[],
): readonly RawMatcher[] =>
  actions.map((action) => ({
    all: [
      { program: "gh" },
      { arg0In: [arg0] },
      { argAt: { index: 1, value: action } },
      { noSubstitution: true },
      { noStdoutRedirect: true },
    ],
  }));

const ghActionRules = (
  idPrefix: string,
  arg0: string,
  actions: readonly string[],
  reason: string,
  matchers: readonly RawMatcher[] = ghActionMatchers(arg0, actions),
) => {
  return actions.map((action, index) => {
    const match = matchers[index];
    if (match === undefined) {
      throw new Error(`missing GitHub matcher for ${arg0} ${action}`);
    }
    return {
      id: `${idPrefix}-${action}`,
      effect: "allow",
      match,
      reason,
      provenance: { source: "shipped" },
    };
  });
};

const ghPrReadMatchers = ghActionMatchers("pr", [
  "view",
  "list",
  "checks",
  "diff",
  "status",
]);
const ghIssueReadMatchers = ghActionMatchers("issue", [
  "view",
  "list",
  "status",
]);
const ghRepoReadMatchers = ghActionMatchers("repo", ["view", "list"]);
const ghRunReadMatchers = ghActionMatchers("run", ["view", "list"]);
const ghWorkflowReadMatchers = ghActionMatchers("workflow", ["view", "list"]);
const ghReleaseReadMatchers = ghActionMatchers("release", ["view", "list"]);
const ghConfigReadMatchers = ghActionMatchers("config", ["get", "list"]);
const ghAuthStatusMatchers = ghActionMatchers("auth", ["status"]);
const ghExtensionListMatchers = ghActionMatchers("extension", ["list"]);
const ghSearchReadMatchers = ghActionMatchers("search", [
  "repos",
  "issues",
  "prs",
  "code",
  "commits",
]);

const ghApiFieldInputVeto = (): RawMatcher => ({
  not: {
    flagMatches: {
      names: ["F", "field", "f", "raw-field", "input"],
      shortChars: ["F", "f"],
    },
  },
});

const ghApiDefaultGetMatcher: RawMatcher = {
  all: [
    { program: "gh" },
    { arg0In: ["api"] },
    {
      not: {
        flagMatches: {
          names: ["X", "method", "F", "field", "f", "raw-field", "input"],
          shortChars: ["X", "F", "f"],
        },
      },
    },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const ghApiExplicitGetMatcher: RawMatcher = {
  any: [
    {
      all: [
        { program: "gh" },
        { arg0In: ["api"] },
        { any: [{ flagPresent: "X" }, { flagPresent: "method" }] },
        { flagValueIn: { names: ["X", "method"], values: ["GET", "HEAD"] } },
        ghApiFieldInputVeto(),
        { noSubstitution: true },
        { noStdoutRedirect: true },
      ],
    },
    {
      all: [
        { program: "gh" },
        { arg0In: ["api"] },
        { any: [{ flagPresent: "X" }, { flagPresent: "method" }] },
        {
          any: [
            { argAt: { index: 1, value: "GET" } },
            { argAt: { index: 1, value: "HEAD" } },
          ],
        },
        // Last method flag wins at the CLI, so conflicting duplicates must
        // not ride the read allow: at most one method flag, and any inline
        // value must be GET/HEAD (review blocker, 2026-07-23).
        { flagCount: { names: ["X", "method"], max: 1 } },
        {
          flagValueIn: {
            names: ["X", "method"],
            values: ["GET", "HEAD"],
            allowUndefinedValue: true,
          },
        },
        ghApiFieldInputVeto(),
        { noSubstitution: true },
        { noStdoutRedirect: true },
      ],
    },
  ],
};

const ghApiGetMatcher: RawMatcher = {
  any: [ghApiDefaultGetMatcher, ghApiExplicitGetMatcher],
};

/**
 * Stage-shaped read families reused by heterogeneous composition. Each Git
 * family is also the standalone allow matcher, so composition cannot drift
 * from the direct read policy.
 */
export const BASH_VCS_STAGE_FAMILY_MATCHERS: readonly RawMatcher[] = [
  gitReadMatcher,
  gitHelpMatcher,
  gitVersionMatcher,
  gitBranchMatcher,
  gitTagMatcher,
  ...gitRemoteMatchers,
  ...gitConfigMatchers,
  gitStashListMatcher,
  gitWorktreeListMatcher,
  ...ghPrReadMatchers,
  ...ghIssueReadMatchers,
  ...ghRepoReadMatchers,
  ...ghRunReadMatchers,
  ...ghWorkflowReadMatchers,
  ...ghReleaseReadMatchers,
  ...ghConfigReadMatchers,
  ...ghAuthStatusMatchers,
  ...ghExtensionListMatchers,
  ...ghSearchReadMatchers,
  ghApiGetMatcher,
];

const rawPack = {
  version: 1,
  id: "bash.vcs.read",
  rules: [
    {
      id: "bash.vcs.read:review-git-output-flag",
      effect: "review",
      match: { all: [{ program: "git" }, { flagPresent: "output" }] },
      reason: "git output file flag writes to disk",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.read:review-gh-api",
      effect: "review",
      match: {
        all: [{ program: "gh" }, { arg0In: ["api"] }, { not: ghApiGetMatcher }],
      },
      reason: "gh api method and input surface requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.read:allow-git-read-subcommands",
      effect: "allow",
      match: gitReadMatcher,
      reason: "git read-only status/log/diff/show/list inspection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.read:allow-git-help",
      effect: "allow",
      match: gitHelpMatcher,
      reason: "git help inspection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.read:allow-git-version",
      effect: "allow",
      match: gitVersionMatcher,
      reason: "git version inspection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.read:allow-git-branch-inspection",
      effect: "allow",
      match: gitBranchMatcher,
      reason:
        "git branch listing or local branch creation without destructive flags",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.read:allow-git-tag-inspection",
      effect: "allow",
      match: gitTagMatcher,
      reason:
        "git tag inspection or local tag creation without destructive flags",
      provenance: { source: "shipped" },
    },
    ...gitRemoteMatchers.map((match, index) => ({
      id: `bash.vcs.read:allow-git-remote-inspection-${index + 1}`,
      effect: "allow",
      match,
      reason: "git remote URL and remote inspection",
      provenance: { source: "shipped" },
    })),
    ...gitConfigMatchers.map((match, index) => ({
      id: `bash.vcs.read:allow-git-config-inspection-${index + 1}`,
      effect: "allow",
      match,
      reason: "git config read-only inspection",
      provenance: { source: "shipped" },
    })),
    {
      id: "bash.vcs.read:allow-git-stash-list",
      effect: "allow",
      match: gitStashListMatcher,
      reason: "git stash listing",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.read:allow-git-worktree-list",
      effect: "allow",
      match: gitWorktreeListMatcher,
      reason: "git worktree listing",
      provenance: { source: "shipped" },
    },
    ...ghActionRules(
      "bash.vcs.read:allow-gh-pr-read",
      "pr",
      ["view", "list", "checks", "diff", "status"],
      "read-only gh pr inspection",
      ghPrReadMatchers,
    ),
    ...ghActionRules(
      "bash.vcs.read:allow-gh-issue-read",
      "issue",
      ["view", "list", "status"],
      "read-only gh issue inspection",
      ghIssueReadMatchers,
    ),
    ...ghActionRules(
      "bash.vcs.read:allow-gh-repo-read",
      "repo",
      ["view", "list"],
      "read-only gh repo inspection",
      ghRepoReadMatchers,
    ),
    ...ghActionRules(
      "bash.vcs.read:allow-gh-run-read",
      "run",
      ["view", "list"],
      "read-only gh run inspection",
      ghRunReadMatchers,
    ),
    ...ghActionRules(
      "bash.vcs.read:allow-gh-workflow-read",
      "workflow",
      ["view", "list"],
      "read-only gh workflow inspection",
      ghWorkflowReadMatchers,
    ),
    ...ghActionRules(
      "bash.vcs.read:allow-gh-release-read",
      "release",
      ["view", "list"],
      "read-only gh release inspection",
      ghReleaseReadMatchers,
    ),
    ...ghActionRules(
      "bash.vcs.read:allow-gh-config-read",
      "config",
      ["get", "list"],
      "read-only gh config inspection",
      ghConfigReadMatchers,
    ),
    ...ghActionRules(
      "bash.vcs.read:allow-gh-auth-status",
      "auth",
      ["status"],
      "read-only gh auth status inspection",
      ghAuthStatusMatchers,
    ),
    ...ghActionRules(
      "bash.vcs.read:allow-gh-extension-list",
      "extension",
      ["list"],
      "read-only gh extension listing",
      ghExtensionListMatchers,
    ),
    ...ghActionRules(
      "bash.vcs.read:allow-gh-search",
      "search",
      ["repos", "issues", "prs", "code", "commits"],
      "read-only gh search inspection",
      ghSearchReadMatchers,
    ),
    {
      id: "bash.vcs.read:allow-gh-api-get",
      effect: "allow",
      match: ghApiGetMatcher,
      reason: "read-only gh api GET/HEAD request without field or input flags",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const bashVcsReadPack = defineShippedPack(rawPack);
