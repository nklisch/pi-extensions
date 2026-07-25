import { describe, expect, it } from "vitest";
import { bashInspectCorePack } from "../../src/packs/bash.inspect.core.ts";
import { bashSearchReadPack } from "../../src/packs/bash.search.read.ts";
import { conditionGuardClauses } from "../../src/packs/condition-guards.ts";
import {
  classifyStageEffect,
  EFFECT_REGISTRY,
  type EffectRegistryEntry,
} from "../../src/parse/native-effects.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import type { BashStage } from "../../src/parse/shape.ts";
import type { DecisionEffect, PolicyPack } from "../../src/policy/core.ts";
import { compileMatch, getMatcherExpr } from "../../src/policy/core.ts";
import { decideWithPacks } from "./helpers.ts";

const INSPECTION_THEME_PROGRAMS = new Set([
  "ls",
  "cat",
  "head",
  "wc",
  "file",
  "stat",
  "pwd",
  "uname",
  "whoami",
  "id",
  "tree",
  "du",
  "df",
  "nl",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "which",
  "whereis",
  "type",
  "locate",
  "sha1sum",
  "sha224sum",
  "sha256sum",
  "sha384sum",
  "sha512sum",
  "md5sum",
  "b2sum",
  "shasum",
  "diff",
  "ps",
  "pgrep",
  "uptime",
  "groups",
  "sleep",
  "date",
  "printf",
  "echo",
]);

const SEARCH_SIMPLE_THEME_PROGRAMS = new Set([
  "grep",
  "rg",
  "jq",
  "uniq",
  "cut",
  "tr",
]);

const DIRECT_PACK_COMPATIBLE_CONDITIONAL_READS = new Set(["grep", "rg"]);

const PACK_ALLOW_EXAMPLES = [
  {
    pack: bashInspectCorePack,
    expectedPrograms: [
      "tail",
      "hostname",
      ...readOnlyRegistryPrograms((entry) =>
        INSPECTION_THEME_PROGRAMS.has(entry.program),
      ),
    ],
    examples: {
      tail: "tail -n 10 file",
      ls: "ls -la",
      cat: "cat README.md",
      head: "head -n 5 file",
      wc: "wc -l file",
      file: "file bin",
      stat: "stat file",
      pwd: "pwd",
      uname: "uname -a",
      whoami: "whoami",
      id: "id",
      echo: "echo hello",
      printf: "printf hello",
    },
  },
  {
    pack: bashSearchReadPack,
    expectedPrograms: [
      "sort",
      "find",
      "sed",
      ...readOnlyRegistryPrograms(
        (entry) =>
          SEARCH_SIMPLE_THEME_PROGRAMS.has(entry.program) &&
          (entry.condition === undefined ||
            DIRECT_PACK_COMPATIBLE_CONDITIONAL_READS.has(entry.program)),
      ),
    ],
    examples: {
      sort: "sort file",
      find: "find . -name '*.ts'",
      sed: "sed -n '1,10p' file",
      grep: "grep foo README.md",
      rg: "rg pattern src/",
      jq: "jq . data.json",
      uniq: "uniq file",
      cut: "cut -d: -f1 file",
      tr: "tr a-z A-Z < file",
    },
  },
] as const;

const CONDITIONAL_DIRECT_PACK_TABLE = [
  {
    program: "tail",
    pack: bashInspectCorePack,
    safe: "tail file",
    forbidden: [
      {
        command: "tail -f file",
        classifierReason: "forbidden-flag-present",
        direct: {
          effect: "review",
          ruleId: "bash.inspect.core:review-tail-follow",
        },
      },
      {
        command: "tail -F file",
        classifierReason: "forbidden-flag-present",
        direct: {
          effect: "review",
          ruleId: "bash.inspect.core:review-tail-follow",
        },
      },
    ],
  },
  {
    program: "find",
    pack: bashSearchReadPack,
    safe: "find . -print",
    forbidden: [
      {
        command: "find . -delete",
        classifierReason: "forbidden-flag-present",
        direct: {
          effect: "review",
          ruleId: "bash.search.read:review-find-mutating-action",
        },
      },
      {
        command: "find . -fprint out",
        classifierReason: "forbidden-flag-present",
        direct: {
          effect: "review",
          ruleId: "bash.search.read:review-find-mutating-action",
        },
      },
    ],
  },
  {
    program: "sort",
    pack: bashSearchReadPack,
    safe: "sort file",
    forbidden: [
      {
        command: "sort -o out file",
        classifierReason: "forbidden-flag-present",
        direct: {
          effect: "review",
          ruleId: "bash.search.read:review-sort-output",
        },
      },
      {
        command: "sort -oout file",
        classifierReason: "forbidden-flag-present",
        direct: { effect: "review" },
        divergence: "derived guard falls through to the default review",
      },
    ],
  },
  {
    program: "sed",
    pack: bashSearchReadPack,
    safe: "sed -n '1,10p' file",
    forbidden: [
      {
        command: "sed -i 's/a/b/' file",
        classifierReason: "forbidden-flag-present",
        direct: {
          effect: "review",
          ruleId: "bash.search.read:review-sed-in-place",
        },
      },
      {
        command: "sed -n 'w out' file",
        classifierReason: "argument-shape-unsupported",
        direct: { effect: "allow", ruleId: "bash.search.read:allow-sed-print" },
        divergence: "compound-only stricter sed script-body classification",
      },
    ],
  },
  {
    program: "grep",
    pack: bashSearchReadPack,
    safe: "grep pattern file",
    forbidden: [],
  },
  {
    program: "rg",
    pack: bashSearchReadPack,
    safe: "rg pattern src/",
    forbidden: [
      {
        command: "rg --replace X pattern file",
        classifierReason: "forbidden-flag-present",
        direct: {
          effect: "review",
          ruleId: "bash.search.read:review-rg-rewrite",
        },
      },
      {
        command: "rg --pre cmd pattern file",
        classifierReason: "forbidden-flag-present",
        direct: {
          effect: "review",
          ruleId: "bash.search.read:review-rg-rewrite",
        },
      },
    ],
  },
] as const;

const NON_PACK_REGISTRY_CONSUMERS = {
  mv: "compound-classifier plus shipped write/risky review policy",
  cp: "compound-classifier plus shipped write/risky review policy",
  install: "compound-classifier plus shipped write/risky review policy",
  mkdir: "compound-classifier plus shipped write/risky review policy",
  touch: "compound-classifier plus shipped write/risky review policy",
  mktemp: "compound-classifier plus shipped write/risky review policy",
  tee: "compound-classifier plus shipped write/risky review policy",
  dd: "compound-classifier plus shipped write/risky review policy",
  ln: "compound-classifier plus shipped write/risky review policy",
  truncate: "compound-classifier plus shipped write/risky review policy",
  rm: "compound-classifier plus sealed floor/risky review policy",
  rmdir: "compound-classifier plus shipped risky review policy",
  shred: "compound-classifier plus shipped risky review policy",
  curl: "compound-classifier plus network/risky review policy",
  wget: "compound-classifier plus network/risky review policy",
  scp: "compound-classifier plus network/risky review policy",
  rsync: "compound-classifier plus network/risky review policy",
  ssh: "compound-classifier plus network/risky review policy",
  nc: "compound-classifier plus network/risky review policy",
  ftp: "compound-classifier plus network/risky review policy",
  sh: "compound-classifier plus sealed floor/risky review policy",
  bash: "compound-classifier plus sealed floor/risky review policy",
  zsh: "compound-classifier plus sealed floor/risky review policy",
  dash: "compound-classifier plus sealed floor/risky review policy",
  ksh: "compound-classifier plus sealed floor/risky review policy",
  fish: "compound-classifier plus sealed floor/risky review policy",
  eval: "compound-classifier plus sealed floor/risky review policy",
  source: "compound-classifier plus shipped risky review policy",
  exec: "compound-classifier plus shipped risky review policy",
  xargs: "compound-classifier plus shipped risky review policy",
  env: "compound-classifier plus shipped risky review policy",
} as const satisfies Record<string, string>;

const REPRESENTATIVE_DECISION_CORPUS = [
  {
    command: "cat foo",
    packs: [bashInspectCorePack],
    effect: "allow",
    ruleId: "bash.inspect.core:allow-cat",
  },
  {
    command: "tail -f x",
    packs: [bashInspectCorePack],
    effect: "review",
    ruleId: "bash.inspect.core:review-tail-follow",
  },
  {
    command: "sed -i f",
    packs: [bashSearchReadPack],
    effect: "review",
    ruleId: "bash.search.read:review-sed-in-place",
  },
  {
    command: "find . -delete",
    packs: [bashSearchReadPack],
    effect: "review",
    ruleId: "bash.search.read:review-find-mutating-action",
  },
  {
    command: "grep pat f",
    packs: [bashSearchReadPack],
    effect: "allow",
    ruleId: "bash.search.read:allow-grep",
  },
  {
    command: "rg --replace x p f",
    packs: [bashSearchReadPack],
    effect: "review",
    ruleId: "bash.search.read:review-rg-rewrite",
  },
  {
    command: "rg --pre cmd p f",
    packs: [bashSearchReadPack],
    effect: "review",
    ruleId: "bash.search.read:review-rg-rewrite",
  },
  {
    command: "sort -o o f",
    packs: [bashSearchReadPack],
    effect: "review",
    ruleId: "bash.search.read:review-sort-output",
  },
  {
    command: "ls",
    packs: [bashInspectCorePack],
    effect: "allow",
    ruleId: "bash.inspect.core:allow-ls",
  },
  {
    command: "echo $X",
    packs: [bashInspectCorePack],
    effect: "review",
    ruleId: undefined,
    note: "substitution does not match the direct allow rule",
  },
] as const satisfies readonly {
  readonly command: string;
  readonly packs: readonly PolicyPack[];
  readonly effect: DecisionEffect;
  readonly ruleId?: string | undefined;
  readonly note?: string;
}[];

describe("effect registry and direct read-only pack consistency", () => {
  it("derives direct pack allow programs from read-only registry membership", () => {
    for (const fixture of PACK_ALLOW_EXAMPLES) {
      expect(allowPrograms(fixture.pack)).toEqual(fixture.expectedPrograms);
    }
  });

  it("embeds every registry condition in its direct allow matcher", () => {
    for (const pack of [bashInspectCorePack, bashSearchReadPack]) {
      for (const rule of pack.rules.filter(
        (candidate) => candidate.effect === "allow",
      )) {
        const programName = programFromRuleId(rule.id);
        const entry = EFFECT_REGISTRY.find(
          (candidate) => candidate.program === programName,
        );
        if (
          entry?.condition === undefined ||
          // sed's requireAnyFlag is already explicit in the hand-authored
          // print-only rule; its script-body condition remains DSL-inexpressible.
          programName === "sed"
        ) {
          continue;
        }

        const expr = getMatcherExpr(rule.match);
        expect(expr?.kind, rule.id).toBe("all");
        if (expr?.kind !== "all") {
          continue;
        }

        for (const rawGuard of conditionGuardClauses(entry.condition)) {
          const compiled = compileMatch(rawGuard);
          expect("expr" in compiled, rule.id).toBe(true);
          if ("expr" in compiled) {
            expect(expr.of, rule.id).toContainEqual(compiled.expr);
          }
        }
      }
    }
  });

  it("classifies every direct pack allow example as read-only end-to-end", async () => {
    for (const fixture of PACK_ALLOW_EXAMPLES) {
      for (const [program, command] of Object.entries(fixture.examples)) {
        expect(
          await classifyCommand(command),
          `${program}: ${command}`,
        ).toMatchObject({
          class: "read-only",
        });
      }
    }
  });

  it("documents conditional direct-pack compatibility and compound-only stricter cases", async () => {
    for (const row of CONDITIONAL_DIRECT_PACK_TABLE) {
      expect(
        await classifyCommand(row.safe),
        `${row.program} safe`,
      ).toMatchObject({
        class: "read-only",
      });

      for (const forbidden of row.forbidden) {
        expect(
          await classifyCommand(forbidden.command),
          forbidden.command,
        ).toEqual({
          class: "unknown",
          reason: forbidden.classifierReason,
        });

        const decision = await decideWithPacks(forbidden.command, [row.pack]);
        expect(decision, forbidden.command).toMatchObject({
          effect: forbidden.direct.effect,
        });
        if ("ruleId" in forbidden.direct) {
          expect(decision.provenance.ruleId, forbidden.command).toBe(
            forbidden.direct.ruleId,
          );
        }
      }
    }
  });

  it("classifies every registry exclusion entry to its exclusion class", async () => {
    for (const entry of EFFECT_REGISTRY.filter(
      (candidate) => candidate.class !== "read-only",
    )) {
      expect(
        await classifyCommand(minimalCommand(entry)),
        entry.program,
      ).toEqual({
        class: entry.class,
        reason: entry.reason,
      });
    }
  });

  it("documents every registry entry consumer so direct packs and compound classification cannot drift silently", () => {
    const packedPrograms = new Set([
      ...rulePrograms(bashInspectCorePack),
      ...rulePrograms(bashSearchReadPack),
      "hostname",
      "test",
      "[",
      "[[",
      "command",
      "export",
      "set",
      "cd",
      "journalctl",
      "systemctl",
      "docker",
      "podman",
    ]);
    const compoundOnlyPrograms = new Set(
      Object.keys(NON_PACK_REGISTRY_CONSUMERS),
    );
    // The new shell/system packs own their registry entries directly; the
    // compact rule ids for their generated families do not encode every
    // program name, so keep their ownership table explicit here.

    for (const program of compoundOnlyPrograms) {
      expect(
        EFFECT_REGISTRY.some((entry) => entry.program === program),
        program,
      ).toBe(true);
      expect(packedPrograms.has(program), program).toBe(false);
    }

    for (const entry of EFFECT_REGISTRY) {
      expect(
        packedPrograms.has(entry.program) ||
          compoundOnlyPrograms.has(entry.program),
        `${entry.program} must be consumed by a direct pack or documented as compound-only`,
      ).toBe(true);
    }
  });

  it("preserves representative direct-pack decisions while documenting compound-only divergences", async () => {
    for (const fixture of REPRESENTATIVE_DECISION_CORPUS) {
      const decision = await decideWithPacks(fixture.command, fixture.packs);
      expect(decision, fixture.command).toMatchObject({
        effect: fixture.effect,
      });
      if (fixture.ruleId === undefined) {
        expect(decision.provenance.source, fixture.command).toBe("default");
      } else {
        expect(decision.provenance.ruleId, fixture.command).toBe(
          fixture.ruleId,
        );
      }
    }
  });
});

function readOnlyRegistryPrograms(
  membership: (entry: EffectRegistryEntry) => boolean,
): readonly string[] {
  return EFFECT_REGISTRY.filter(
    (entry) => entry.class === "read-only" && membership(entry),
  ).map((entry) => entry.program);
}

function allowPrograms(pack: PolicyPack): readonly string[] {
  return pack.rules
    .filter((rule) => rule.effect === "allow")
    .map((rule) => programFromRuleId(rule.id));
}

function rulePrograms(pack: PolicyPack): readonly string[] {
  return [...new Set(pack.rules.map((rule) => programFromRuleId(rule.id)))];
}

function programFromRuleId(ruleId: string): string {
  const suffix = ruleId.slice(ruleId.lastIndexOf(":") + 1);
  switch (suffix) {
    case "allow-sed-print":
    case "review-sed-in-place":
      return "sed";
    case "review-tail-follow":
      return "tail";
    case "review-sort-output":
      return "sort";
    case "review-find-mutating-action":
      return "find";
    default:
      return suffix.replace(/^allow-/u, "");
  }
}

async function classifyCommand(command: string) {
  return classifyStageEffect(await firstStage(command));
}

async function firstStage(command: string): Promise<BashStage> {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error(`Expected bash shape for ${command}`);
  }
  const stage = shape.stages[0];
  if (stage === undefined) {
    throw new Error(`Expected at least one stage for ${command}`);
  }
  return stage;
}

function minimalCommand(entry: EffectRegistryEntry): string {
  switch (entry.program) {
    case "mkdir":
    case "touch":
    case "mktemp":
    case "rmdir":
    case "shred":
    case "curl":
    case "wget":
    case "ssh":
    case "nc":
    case "ftp":
    case "source":
    case "exec":
    case "xargs":
      return `${entry.program} target`;
    case "dd":
      return "dd if=in of=out";
    case "truncate":
      return "truncate -s 0 target";
    case "eval":
      return "eval x";
    case "env":
      return "env";
    case "command":
      return "command ls";
    default:
      return `${entry.program} source target`;
  }
}
