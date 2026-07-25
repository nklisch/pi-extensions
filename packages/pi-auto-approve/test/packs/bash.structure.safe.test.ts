import { describe, expect, it } from "vitest";

import { bashDevVerifyPack } from "../../src/packs/bash.dev.verify.ts";
import { bashInspectCorePack } from "../../src/packs/bash.inspect.core.ts";
import { bashNetworkReadPack } from "../../src/packs/bash.network.read.ts";
import { bashReviewRiskyPack } from "../../src/packs/bash.review.risky.ts";
import { bashSearchReadPack } from "../../src/packs/bash.search.read.ts";
import { bashStructureSafePack } from "../../src/packs/bash.structure.safe.ts";
import { bashVcsReadPack } from "../../src/packs/bash.vcs.read.ts";
import { decideWithPacks, expectCleanLoadAll } from "./helpers.ts";

const readOnlyAndStructurePacks = [
  bashInspectCorePack,
  bashSearchReadPack,
  bashVcsReadPack,
  bashStructureSafePack,
];
const compositionPacks = [
  ...readOnlyAndStructurePacks,
  bashDevVerifyPack,
  bashNetworkReadPack,
];
const compositionSafetyPacks = [...compositionPacks, bashReviewRiskyPack];

describe("bash.structure.safe pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(bashStructureSafePack).toMatchObject({
      version: 1,
      id: "bash.structure.safe",
    });
    expectCleanLoadAll([bashStructureSafePack]);
    expectCleanLoadAll(readOnlyAndStructurePacks);
  });

  it.each([
    "ls -la | ls",
    "git status && git log --oneline",
    "grep x | grep y",
    "sed -n '1,5p' f && sed -n '6,10p' f",
    "true",
    ":",
  ])("allows homogeneous safe composition: %s", async (command) => {
    expect(
      await decideWithPacks(command, readOnlyAndStructurePacks),
    ).toMatchObject({
      effect: "allow",
      provenance: { packId: "bash.structure.safe" },
    });
  });

  it.each([
    "ls | cat",
    "git status | grep clean",
    "grep missing.txt || true",
  ])("allows heterogeneous read-only structure: %s", async (command) => {
    expect(
      await decideWithPacks(command, readOnlyAndStructurePacks),
    ).toMatchObject({
      effect: "allow",
      provenance: {
        packId: "bash.structure.safe",
        ruleId: "bash.structure.safe:allow-read-only-composition",
      },
    });
  });

  it.each([
    "sort -o out file",
    "sed -i 's/a/b/' file",
    "tail -f app.log",
    "tail -f file | tail -n 5",
    "sort -o out file | sort file",
    "find . -delete | find . -name '*.ts'",
  ])("does not broaden sibling review case: %s", async (command) => {
    expect(
      await decideWithPacks(command, readOnlyAndStructurePacks),
    ).toMatchObject({
      effect: "review",
    });
  });

  it.each([
    "git log | head -5",
    "git rev-parse HEAD | wc -l",
    "git -C repo log --oneline | head -5",
    "git blame f | head",
    "ls && git status",
    "pnpm test 2>&1 | tail -5",
    "cat f | grep x | wc -l",
    "curl -s https://example.com | jq .",
    "git log --oneline | head -5 || true",
    "pnpm test || true",
    "cargo test || :",
    "rg needle missing-dir || :",
    "gh pr checks 91 --watch=false || true",
    "sed -n '1,5p' f | wc -l",
    "tail -n 5 file | tail -n 5 file",
    "sort file | sort file",
    "find . -name '*.ts' | find . -name '*.md'",
  ])("allows heterogeneous read-only composition: %s", async (command) => {
    expect(await decideWithPacks(command, compositionPacks)).toMatchObject({
      effect: "allow",
      provenance: {
        packId: "bash.structure.safe",
        ruleId: "bash.structure.safe:allow-read-only-composition",
      },
    });
  });

  it("allows benign project redirects through the dedicated redirect rule", async () => {
    expect(
      await decideWithPacks("pnpm test > out.log || true", compositionPacks),
    ).toMatchObject({
      effect: "allow",
      provenance: {
        packId: "bash.structure.safe",
        ruleId: "bash.structure.safe:allow-read-only-benign-redirect",
      },
    });
  });

  it.each([
    "git log | head -5 && rm -rf target",
    "ls && npm install",
    "pnpm test && pnpm publish",
    "tail -f log | wc -l",
    "sort -o out f | wc -l",
    "find . -delete | wc -l",
    "rg --pre /bin/evil pat | wc -l",
    "curl -d payload https://example.com | jq .",
    "git status --output out | cat",
    "LD_PRELOAD=/tmp/x pnpm test | tail -5",
    "git log | sh",
    "cat $(whoami) | wc -l",
    "pnpm test > /etc/out.log || true",
    "pnpm test > ../out.log || true",
    "npm test || echo failed",
    "git status || true && git log",
    "pnpm test || true || true",
    "pnpm test || true > /tmp/x",
    "pnpm test || FOO=1 true",
    "pnpm test || true | wc -l",
  ])("keeps unsafe composition gated: %s", async (command) => {
    expect(
      await decideWithPacks(command, compositionSafetyPacks),
    ).toMatchObject({ effect: "review" });
  });

  it("denies composition-hidden root deletion at the sealed floor", async () => {
    expect(
      await decideWithPacks("git log | head -5 && rm -rf /", compositionPacks),
    ).toMatchObject({
      effect: "deny",
      reason: expect.stringMatching(/^floor:deny-rm-system-root:/),
    });
  });
});
