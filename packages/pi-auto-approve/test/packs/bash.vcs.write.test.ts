import { describe, expect, it } from "vitest";

import { bashReviewRiskyPack } from "../../src/packs/bash.review.risky.ts";
import { bashVcsReadPack } from "../../src/packs/bash.vcs.read.ts";
import { bashVcsWritePack } from "../../src/packs/bash.vcs.write.ts";
import {
  decideWithPacks,
  expectAllowFromPack,
  expectCleanLoad,
  expectDecisionEffect,
} from "./helpers.ts";

describe("bash.vcs.write pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(bashVcsWritePack).toMatchObject({
      version: 1,
      id: "bash.vcs.write",
    });
    expectCleanLoad(bashVcsWritePack);
  });

  it.each([
    "git add .",
    "git add -A",
    "git commit -m msg",
    "git commit --amend -m x",
    "git fetch",
    "git fetch origin --prune",
    "git pull",
    "git pull --rebase",
    "git switch main",
    "git switch -c feature",
    "git merge feature",
    "git merge --abort",
    "git checkout -b feature",
    "git checkout -qb feature base",
    "git -C repo add .",
  ])("allows routine local write: %s", async (command) => {
    await expectAllowFromPack(command, bashVcsWritePack, "bash.vcs.write");
  });

  it.each([
    "git push",
    "git push origin main",
    "git push --delete origin old",
    "git reset --hard HEAD~1",
    "git reset --soft HEAD~1",
    "git clean -f",
    "git clean -n",
    "git branch -d old",
    "git branch -D old",
    "git branch -f old main",
    "git tag -d old",
    "git tag -f old",
    "git checkout -B old main",
    "git checkout -qB old",
    "git checkout --force old",
    "git checkout -f -b feat",
    "git checkout -fb feat",
    "git checkout -- -b",
    "git checkout main",
    "git checkout -- file",
    "git switch --force old",
    "git switch -C old",
    "git switch --discard-changes old",
    "git stash",
    "git stash pop",
    "git stash push -m x",
    "git worktree add /tmp/wt",
    "git remote add origin url",
    "git remote set-url origin url",
    "git config user.email x",
    "git config user.email",
  ])("keeps destructive or unsupported write in review: %s", async (command) => {
    expect(
      await decideWithPacks(command, [
        bashVcsReadPack,
        bashVcsWritePack,
        bashReviewRiskyPack,
      ]),
    ).toMatchObject({ effect: "review" });
  });

  it("keeps write families out of composition v1", async () => {
    expect(
      await decideWithPacks("git add . && git commit -m x", [
        bashVcsReadPack,
        bashVcsWritePack,
      ]),
    ).toMatchObject({ effect: "review" });
  });

  it("keeps substitutions and redirects reviewed", async () => {
    expect(
      await decideWithPacks('git commit -m "$(date)"', [bashVcsWritePack]),
    ).toMatchObject({ effect: "review" });
    expect(
      await decideWithPacks("git add . > out", [bashVcsWritePack]),
    ).toMatchObject({ effect: "review" });
  });

  it("keeps push specifically named by the risky review pack", async () => {
    await expectDecisionEffect(
      "git push origin main",
      bashReviewRiskyPack,
      "review",
    );
    expect(
      await decideWithPacks("git push origin main", [
        bashVcsWritePack,
        bashReviewRiskyPack,
      ]),
    ).toMatchObject({
      effect: "review",
      provenance: {
        packId: "bash.review.risky",
        ruleId: "bash.review.risky:review-git-push",
      },
    });
  });
});
