import { describe, expect, it } from "vitest";

import { baselinePacks } from "../../src/packs/baseline.ts";
import { bashVcsReadPack } from "../../src/packs/bash.vcs.read.ts";
import {
  expectAllowFromPack,
  expectCleanLoad,
  expectDecisionEffect,
} from "./helpers.ts";

describe("bash.vcs.read pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(bashVcsReadPack).toMatchObject({
      version: 1,
      id: "bash.vcs.read",
    });
    expectCleanLoad(bashVcsReadPack);
  });

  it.each([
    "git status",
    "git log --oneline",
    "git diff",
    "git show HEAD",
    "git ls-files",
    "git rev-parse HEAD",
    "git blame file",
    "git grep needle",
    "git ls-tree HEAD",
    "git cat-file -p HEAD",
    "git merge-base main feature",
    "git describe --tags",
    "git shortlog -s",
    "git show-ref",
    "git check-ignore file",
    "git name-rev HEAD",
    "git count-objects",
    "git ls-remote origin",
    "git diff-tree HEAD",
    "git diff-index HEAD",
    "git branch",
    "git branch feature",
    "git branch -v",
    "git tag",
    "git tag v1.0",
    "git tag -a v1 -m x",
    "git remote -v",
    "git remote show origin",
    "git remote get-url origin",
    "git config --get user.email",
    "git config --list",
    "git config -l",
    "git stash list",
    "git worktree list",
    "git --version",
    "git --help",
  ])("allows read-only git command: %s", async (command) => {
    await expectAllowFromPack(command, bashVcsReadPack, "bash.vcs.read");
  });

  it.each([
    "git -C repo rev-parse HEAD",
    "git --git-dir=/x --work-tree=/y log",
    "gh pr list",
    "gh pr checks 1",
    "gh issue view 123",
    "gh repo view",
    "gh run list",
    "gh workflow list",
    "gh release view v1",
    "gh config get git_protocol",
    "gh auth status",
    "gh extension list",
    "gh search repos foo",
    "gh search issues bug",
    "gh api repos/:owner/:repo",
    "gh api --method=GET /repos",
    "gh api -X GET /repos",
  ])("allows read-only gh command: %s", async (command) => {
    await expectAllowFromPack(command, bashVcsReadPack, "bash.vcs.read");
  });

  it.each([
    "git branch -d old",
    "git branch -rd old",
    "git tag -d v1",
    "git remote add origin git@example.com:x/y.git",
    "git remote",
    "git config user.email x",
    "git config user.email",
    "git push",
    "git fetch",
    "git status > out",
    "git status $(cmd)",
    "git diff --output=patch.diff",
    "gh pr create",
    "gh api -X POST /repos",
    "gh api -f k=v /repos",
    "gh api --input request.json /repos",
    "gh auth token",
  ])("reviews mutating or unsupported VCS form: %s", async (command) => {
    await expectDecisionEffect(command, bashVcsReadPack, "review");
  });

  // Verbose remote mutations are caught by the paired review rule in
  // bash.review.risky (review > allow precedence), so they must be asserted
  // against the full baseline, not this pack alone.
  it.each([
    "git remote -v add origin git@example.com:x/y.git",
    "git remote -v set-url origin git@example.com:x/y.git",
    "git remote --verbose remove origin",
  ])("reviews verbose remote mutation across the baseline: %s", async (command) => {
    await expectDecisionEffect(
      command,
      {
        version: 1,
        id: "baseline:test",
        rules: baselinePacks.flatMap((pack) => pack.rules),
      },
      "review",
    );
  });
});
