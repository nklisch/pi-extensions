import { describe, expect, it } from "vitest";

import { bashSearchReadPack } from "../../src/packs/bash.search.read.ts";
import {
  decideWithPacks,
  expectAllowFromPack,
  expectCleanLoad,
  expectDecisionEffect,
} from "./helpers.ts";

describe("bash.search.read pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(bashSearchReadPack).toMatchObject({
      version: 1,
      id: "bash.search.read",
    });
    expectCleanLoad(bashSearchReadPack);
  });

  it.each([
    "grep foo README.md",
    "rg pattern src/",
    "jq . data.json",
    "sort file",
    "uniq file",
    "cut -d: -f1 file",
    "tr a-z A-Z < file",
    "find . -name '*.ts'",
    "sed -n '1,10p' file",
  ])("allows read-only search/filter command: %s", async (command) => {
    await expectAllowFromPack(command, bashSearchReadPack, "bash.search.read");
  });

  it.each([
    "sort -o out file",
    "sort -oout file",
    "sort --output=out file",
    "sort --compress-program=gzip file",
    "sort -uo out file",
    "find . -delete",
    "find . -fprint /tmp/out",
    "find . -fprintf /tmp/out %p",
    "find . -fls /tmp/out",
    "rg --pre /bin/evil pattern",
    "rg --pre-glob='*.txt' pattern",
    "rg --replace=x pattern file",
    "rg -r x pattern file",
    "find . -exec rm {} ;",
    "find . -ok rm {} ;",
    "sed -i 's/a/b/' file",
    "sed --in-place file",
    "grep $(cmd) x",
    "jq . > out",
  ])("reviews mutating or hidden search/read form: %s", async (command) => {
    await expectDecisionEffect(command, bashSearchReadPack, "review");
  });

  it("documents the sed script-body mutation gap until structural safety lands", async () => {
    // Parent/story design: current DSL can require `-n` but cannot inspect sed scripts.
    // A posture-level review gate owns script-body write/execute detection.
    expect(
      await decideWithPacks("sed -n 'w out' file", [bashSearchReadPack]),
    ).toMatchObject({
      effect: "allow",
      provenance: { packId: "bash.search.read" },
    });
  });
});
