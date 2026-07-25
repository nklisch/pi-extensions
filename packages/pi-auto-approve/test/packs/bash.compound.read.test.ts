import { describe, expect, it } from "vitest";

import type { ResolvedProjectScope } from "../../src/config/loader.ts";
import { baselinePacks } from "../../src/packs/baseline.ts";
import { bashCompoundReadPack } from "../../src/packs/bash.compound.read.ts";
import { bashReviewCompoundPack } from "../../src/packs/bash.review.compound.ts";
import { sealedFloor } from "../../src/packs/floor.ts";
import { piFileMutatePack } from "../../src/packs/pi.file.mutate.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import {
  analyzePiBuiltinTool,
  SUPPORTED_PI_MUTATION_TOOL_SPECS,
} from "../../src/parse/native-tool.ts";
import type { Decision, PolicyPack } from "../../src/policy/core.ts";
import { decide } from "../../src/policy/core.ts";
import { loadEffectivePolicy } from "../../src/policy/loader.ts";
import { expectCleanLoad, expectCleanLoadAll } from "./helpers.ts";

const baselinePolicyPack: PolicyPack = {
  version: 1,
  id: "baseline:test",
  rules: baselinePacks.flatMap((pack) => pack.rules),
};
const strictPolicyPack: PolicyPack = {
  version: 1,
  id: "baseline:strict-test",
  rules: baselinePacks.slice(0, 10).flatMap((pack) => pack.rules),
};
const defaultPolicyPack = baselinePolicyPack;
const permissivePolicyPack = baselinePolicyPack;

const TEST_CWD = "/repo";
const TEST_HOME = "/home/user";
const TEST_TEMP = "/tmp/os-tmp";
const SAFE_SCOPED_LOOP =
  "for f in .work/backlog/*.md; do echo '---' \"$f\"; sed -n '1,120p' \"$f\"; done";

function projectScope(
  overrides: Partial<ResolvedProjectScope> = {},
): ResolvedProjectScope {
  return {
    roots: [TEST_CWD],
    writableDirectories: [TEST_CWD],
    tempDirectories: [TEST_TEMP],
    deniedDirectories: [`${TEST_CWD}/denied`],
    safeHomeDirectories: [],
    unknownPathBehavior: "review",
  sensitivePathBehavior: "review",
  homePathBehavior: "allow",
    ...overrides,
  };
}

async function decideBash(
  command: string,
  pack: PolicyPack,
  options: {
    readonly projectScope?: ResolvedProjectScope;
    readonly homeDirectory?: string;
  } = {},
): Promise<Decision> {
  const shape = await analyzeBashCommand(command);
  const enriched = enrichToolShapeWithPathFacts(shape, {
    cwd: TEST_CWD,
    projectScope: options.projectScope ?? projectScope(),
    ...(options.homeDirectory === undefined
      ? {}
      : { homeDirectory: options.homeDirectory }),
  });
  return decide(enriched, {
    floor: sealedFloor.rules,
    active: pack.rules,
  });
}

function decidePiMutation(
  toolName: "edit" | "write",
  input: Record<string, unknown>,
  pack: PolicyPack,
): Decision {
  const spec = SUPPORTED_PI_MUTATION_TOOL_SPECS.find(
    (candidate) => candidate.toolName === toolName,
  );
  if (spec === undefined) {
    throw new Error(`missing mutation tool spec for ${toolName}`);
  }

  const shape = enrichToolShapeWithPathFacts(
    analyzePiBuiltinTool(spec, input),
    {
      cwd: TEST_CWD,
      projectScope: projectScope(),
    },
  );
  return decide(shape, {
    floor: sealedFloor.rules,
    active: pack.rules,
  });
}

function expectCompoundAllow(decision: Decision): void {
  expect(decision).toMatchObject({
    effect: "allow",
    provenance: {
      source: "shipped",
      packId: "bash.compound.read",
      ruleId: "bash.compound.read:allow-project-for-loop-read",
    },
  });
}

function expectCompoundReview(decision: Decision, ruleId: string): void {
  expect(decision).toMatchObject({
    effect: "review",
    provenance: {
      source: "shipped",
      packId: "bash.review.compound",
      ruleId,
    },
  });
}

describe("compound shell shipped packs", () => {
  it("compile and load cleanly, including the canonical compound allow proof", () => {
    expect(bashCompoundReadPack).toMatchObject({
      version: 1,
      id: "bash.compound.read",
    });
    expect(bashReviewCompoundPack).toMatchObject({
      version: 1,
      id: "bash.review.compound",
    });
    expectCleanLoad(bashCompoundReadPack);
    expectCleanLoad(bashReviewCompoundPack);
    expectCleanLoadAll([bashReviewCompoundPack, bashCompoundReadPack]);

    const loaded = loadEffectivePolicy({
      floor: sealedFloor,
      active: [bashCompoundReadPack],
    });
    expect(loaded.ok).toBe(true);
  });

  it("allows the motivating loop in default and permissive when project scope is configured", async () => {
    expectCompoundAllow(await decideBash(SAFE_SCOPED_LOOP, defaultPolicyPack));
    expectCompoundAllow(
      await decideBash(SAFE_SCOPED_LOOP, permissivePolicyPack),
    );
  });

  it("keeps strict on review for the motivating compound loop", async () => {
    expect(await decideBash(SAFE_SCOPED_LOOP, strictPolicyPack)).toEqual({
      effect: "review",
      reason: "no matching rule",
      provenance: { source: "default" },
    });
  });

  it.each([
    {
      label: "home",
      command: 'for f in ~/notes/*.md; do cat "$f"; done',
      options: { homeDirectory: TEST_HOME },
    },
    { label: "outside", command: 'for f in /srv/docs/*.md; do cat "$f"; done' },
    { label: "system", command: 'for f in /etc/*.conf; do cat "$f"; done' },
    {
      label: "denied",
      command: 'for f in denied/*.md; do cat "$f"; done',
      options: {
        projectScope: projectScope({
          deniedDirectories: [`${TEST_CWD}/denied`],
        }),
      },
    },
    { label: "unknown", command: 'for f in ~/notes/*.md; do cat "$f"; done' },
  ])("reviews $label iterator scope in default and permissive", async ({
    command,
    options,
  }) => {
    expectCompoundReview(
      await decideBash(command, defaultPolicyPack, options),
      "bash.review.compound:review-for-iterator-out-of-scope",
    );
    expectCompoundReview(
      await decideBash(command, permissivePolicyPack, options),
      "bash.review.compound:review-for-iterator-out-of-scope",
    );
  });

  it.each([
    ["eval", 'for f in .work/backlog/*.md; do eval "cat $f"; done'],
    ["sh -c", 'for f in .work/backlog/*.md; do sh -c "cat $1" sh "$f"; done'],
    [
      "pipe-to-shell",
      'for f in .work/backlog/*.md; do echo "cat $f" | sh; done',
    ],
    [
      "command substitution",
      'for f in .work/backlog/*.md; do echo "$(cat "$f")"; done',
    ],
    [
      "process substitution",
      'for f in .work/backlog/*.md; do cat <(cat "$f"); done',
    ],
    [
      "arithmetic substitution",
      "for f in .work/backlog/*.md; do echo $((1)); done",
    ],
    ["destructive program", 'for f in .work/backlog/*.md; do rm "$f"; done'],
    ["output redirect", 'for f in .work/backlog/*.md; do cat "$f" > out; done'],
  ])("reviews or denies body containing %s", async (_label, command) => {
    for (const pack of [defaultPolicyPack, permissivePolicyPack]) {
      const decision = await decideBash(command, pack);
      expect(["review", "deny"]).toContain(decision.effect);
      expect(decision).not.toMatchObject({
        provenance: { packId: "bash.compound.read" },
      });
    }
  });

  it("uses compound review provenance for hidden behavior in a for body", async () => {
    expectCompoundReview(
      await decideBash(
        'for f in .work/backlog/*.md; do eval "cat $f"; done',
        defaultPolicyPack,
      ),
      "bash.review.compound:review-for-non-read-only-body",
    );
  });

  it("reviews unsupported compound diagnostics with compound provenance", async () => {
    expectCompoundReview(
      await decideBash("case x in a) echo;; esac", defaultPolicyPack),
      "bash.review.compound:review-unsupported-feature",
    );
    expectCompoundReview(
      await decideBash(
        'for f in *.md; do while true; do echo "$f"; done; done',
        defaultPolicyPack,
      ),
      "bash.review.compound:review-unsupported-body",
    );
  });

  it.each([
    {
      family: "brace group",
      command: "{ echo hi; echo bye; }",
      ruleId: "bash.review.compound:review-brace-group",
    },
    {
      family: "conditional",
      command: "if git diff --quiet; then echo ok; fi",
      ruleId: "bash.review.compound:review-conditional",
    },
    {
      family: "opaque iterator",
      command: 'for f in $LIST; do echo "$f"; done',
      ruleId: "bash.review.compound:review-unsupported-iterator",
    },
    {
      family: "out-of-scope iterator",
      command: 'for f in /etc/*.conf; do cat "$f"; done',
      ruleId: "bash.review.compound:review-for-iterator-out-of-scope",
    },
    {
      family: "non-read-only body",
      command: 'for f in .work/backlog/*.md; do rm "$f"; done',
      ruleId: "bash.review.compound:review-for-non-read-only-body",
    },
    {
      family: "unsupported diagnostic",
      command: "while true; do echo hi; done",
      ruleId: "bash.review.compound:review-unsupported-feature",
    },
  ])("uses bash.review.compound provenance for $family", async ({
    command,
    ruleId,
  }) => {
    expectCompoundReview(await decideBash(command, defaultPolicyPack), ruleId);
  });

  it("keeps typed Pi edit/write decisions independent from compound shell packs", () => {
    expect(
      decidePiMutation(
        "edit",
        { path: "src/a.ts", oldText: "a", newText: "b" },
        defaultPolicyPack,
      ),
    ).toMatchObject({
      effect: "allow",
      provenance: {
        source: "shipped",
        packId: "pi.file.mutate",
        ruleId: "pi.file.mutate:allow-project-scoped-mutation",
      },
    });
    expect(
      decidePiMutation(
        "write",
        { path: "src/a.ts", content: "body" },
        permissivePolicyPack,
      ),
    ).toMatchObject({
      effect: "allow",
      provenance: {
        source: "shipped",
        packId: "pi.file.mutate",
        ruleId: "pi.file.mutate:allow-project-scoped-mutation",
      },
    });
    expect(
      decidePiMutation(
        "write",
        { path: "src/a.ts", content: "body" },
        piFileMutatePack,
      ),
    ).toMatchObject({
      effect: "allow",
      provenance: { packId: "pi.file.mutate" },
    });
  });

  it("does not let shell-wrapped typed-tool-like commands inherit typed-tool allows", async () => {
    const decision = await decideBash(
      'for f in .work/backlog/*.md; do edit "$f"; done',
      defaultPolicyPack,
    );
    expect(decision.effect).toBe("review");
    expect(decision.provenance).not.toMatchObject({ packId: "pi.file.mutate" });
    expect(decision.provenance).not.toMatchObject({
      packId: "bash.compound.read",
    });
  });
});
