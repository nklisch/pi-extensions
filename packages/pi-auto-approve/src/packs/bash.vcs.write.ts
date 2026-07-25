import type { RawMatcher } from "./condition-guards.ts";
import { defineShippedPack } from "./define.ts";

const gitWriteMatcher = (
  subcommand: string,
  extra: readonly RawMatcher[] = [],
): RawMatcher => ({
  all: [
    { program: "git" },
    { arg0In: [subcommand] },
    { noSubstitution: true },
    { noStdoutRedirect: true },
    ...extra,
  ],
});

const gitAddMatcher = gitWriteMatcher("add");
const gitCommitMatcher = gitWriteMatcher("commit");
const gitFetchMatcher = gitWriteMatcher("fetch");
const gitPullMatcher = gitWriteMatcher("pull");
const gitMergeMatcher = gitWriteMatcher("merge");
const gitSwitchMatcher = gitWriteMatcher("switch", [
  {
    not: {
      flagMatches: {
        names: ["f", "force", "C", "force-create", "discard-changes"],
        shortChars: ["f", "C"],
      },
    },
  },
]);
// The overlap checker cannot prove a positive flagMatches clause disjoint from
// the sealed floor. Keep the allow structurally narrow to checkout and pair it
// with the same-pack review gate below; the gate uses shortChars so bundled
// `-qb` is allowed while plain/force checkout remains review.
const gitCheckoutNewBranchMatcher = gitWriteMatcher("checkout");

/**
 * Stage-shaped write families are deliberately not registered for v1
 * composition. Keeping this pack's families private prevents a compound
 * allow from silently turning a chain of local writes into an auto-allow.
 */
const rawPack = {
  version: 1,
  id: "bash.vcs.write",
  rules: [
    {
      id: "bash.vcs.write:allow-git-add",
      effect: "allow",
      match: gitAddMatcher,
      reason: "git stages local changes",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.write:allow-git-commit",
      effect: "allow",
      match: gitCommitMatcher,
      reason: "git creates a local commit",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.write:allow-git-fetch",
      effect: "allow",
      match: gitFetchMatcher,
      reason: "git fetch updates local remote-tracking refs",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.write:allow-git-pull",
      effect: "allow",
      match: gitPullMatcher,
      reason: "git fetches and integrates updates into the local branch",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.write:allow-git-switch",
      effect: "allow",
      match: gitSwitchMatcher,
      reason: "git switches local branches without force flags",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.write:allow-git-merge",
      effect: "allow",
      match: gitMergeMatcher,
      reason: "git merges local branch history",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.write:allow-git-checkout-new-branch",
      effect: "allow",
      match: gitCheckoutNewBranchMatcher,
      reason: "git checks out a newly created local branch",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.vcs.write:review-git-checkout-not-new-branch",
      effect: "review",
      match: {
        all: [
          { program: "git" },
          { arg0In: ["checkout"] },
          {
            not: {
              flagMatches: { names: ["b"], shortChars: ["b"] },
            },
          },
        ],
      },
      reason: "plain git checkout can discard working-tree changes",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const bashVcsWritePack = defineShippedPack(rawPack);
