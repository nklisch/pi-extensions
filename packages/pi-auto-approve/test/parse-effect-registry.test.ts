import { describe, expect, it } from "vitest";
import {
  classifyStageEffect,
  EFFECT_CLASSES,
  EFFECT_REGISTRY,
  type EffectClass,
  getStageFileInputArgIndices,
} from "../src/parse/native-effects.ts";
import { analyzeBashCommand } from "../src/parse/native-parser.ts";
import type { BashStage } from "../src/parse/shape.ts";

const UNCONDITIONAL_READ_ONLY_PROGRAMS = [
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
  "hostname",
  "test",
  "[",
  "[[",
  "cd",
  "export",
  "set",
  "echo",
  "printf",
  "jq",
  "uniq",
  "cut",
  "tr",
] as const;

const CONDITIONAL_READ_ONLY_PROGRAMS = [
  "tree",
  "date",
  "command",
  "tail",
  "grep",
  "rg",
  "find",
  "sort",
  "sed",
] as const;

const WRITE_PROGRAMS = [
  "mv",
  "cp",
  "install",
  "mkdir",
  "touch",
  "mktemp",
  "tee",
  "dd",
  "ln",
  "truncate",
] as const;

const DESTRUCTIVE_PROGRAMS = ["rm", "rmdir", "shred"] as const;

const NETWORK_PROGRAMS = [
  "curl",
  "wget",
  "scp",
  "rsync",
  "ssh",
  "nc",
  "ftp",
] as const;

const SHELL_WRAP_PROGRAMS = [
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "eval",
  "source",
  "exec",
  "xargs",
  "env",
] as const;

const POSITIONAL_FILE_INPUTS = new Map<string, "all" | "program-specific">([
  ["ls", "all"],
  ["cat", "all"],
  ["head", "program-specific"],
  ["wc", "all"],
  ["file", "all"],
  ["stat", "all"],
  ["tree", "all"],
  ["du", "all"],
  ["df", "all"],
  ["nl", "all"],
  ["readlink", "all"],
  ["realpath", "all"],
  ["basename", "all"],
  ["dirname", "all"],
  ["which", "all"],
  ["whereis", "all"],
  ["type", "all"],
  ["locate", "all"],
  ["sha1sum", "all"],
  ["sha224sum", "all"],
  ["sha256sum", "all"],
  ["sha384sum", "all"],
  ["sha512sum", "all"],
  ["md5sum", "all"],
  ["b2sum", "all"],
  ["shasum", "all"],
  ["diff", "all"],
  ["jq", "program-specific"],
  ["cut", "program-specific"],
  ["tail", "program-specific"],
  ["grep", "program-specific"],
  ["rg", "program-specific"],
  ["find", "program-specific"],
  ["sort", "program-specific"],
  ["sed", "program-specific"],
]);

describe("effect registry data", () => {
  it("keeps effect classes in documented order", () => {
    expect(EFFECT_CLASSES).toEqual([
      "read-only",
      "write",
      "destructive",
      "network",
      "shell-wrap",
      "unknown",
    ]);
    expect(EFFECT_CLASSES).toHaveLength(6);
    expect(Object.isFrozen(EFFECT_CLASSES)).toBe(true);
  });

  it("keeps non-empty valid frozen registry entries", () => {
    const validClasses = new Set<EffectClass>(EFFECT_CLASSES);

    expect(EFFECT_REGISTRY.length).toBeGreaterThan(0);
    expect(Object.isFrozen(EFFECT_REGISTRY)).toBe(true);

    for (const entry of EFFECT_REGISTRY) {
      expect(entry.program.trim()).toBe(entry.program);
      expect(entry.program.length).toBeGreaterThan(0);
      expect(entry.reason.trim()).toBe(entry.reason);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(validClasses.has(entry.class)).toBe(true);

      if (entry.condition?.requireAnyFlag !== undefined) {
        expect(entry.condition.requireAnyFlag.length).toBeGreaterThan(0);
      }
      if (entry.condition?.forbidAnyFlag !== undefined) {
        expect(entry.condition.forbidAnyFlag.length).toBeGreaterThan(0);
      }
      if (entry.condition?.forbidFlagNamePrefixes !== undefined) {
        expect(entry.condition.forbidFlagNamePrefixes.length).toBeGreaterThan(
          0,
        );
      }
      if (entry.condition?.forbidShortFlagChars !== undefined) {
        expect(entry.condition.forbidShortFlagChars.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps positional file inputs restricted to read-only entries", () => {
    const positionalEntries = EFFECT_REGISTRY.filter(
      (entry) => entry.fileInputs?.kind === "positional",
    );

    expect(
      positionalEntries.map((entry) => [
        entry.program,
        entry.fileInputs?.kind === "positional"
          ? entry.fileInputs.mode
          : undefined,
      ]),
    ).toEqual([...POSITIONAL_FILE_INPUTS.entries()]);

    for (const entry of positionalEntries) {
      expect(entry.class).toBe("read-only");
      if (entry.fileInputs?.kind !== "positional") {
        throw new Error(
          `${entry.program} should publish positional file inputs`,
        );
      }
      expect(entry.fileInputs.mode).toBe(
        POSITIONAL_FILE_INPUTS.get(entry.program),
      );
    }
  });

  it("keeps omitted fileInputs defaultable to none by convention", () => {
    const omitted = EFFECT_REGISTRY.filter(
      (entry) => entry.fileInputs === undefined,
    );

    expect(omitted.length).toBeGreaterThan(0);
    for (const entry of omitted) {
      expect(entry.fileInputs ?? { kind: "none" }).toEqual({ kind: "none" });
    }
  });

  it("keeps conditions meaningful only for read-only entries", () => {
    const conditionalEntries = EFFECT_REGISTRY.filter(
      (entry) => entry.condition !== undefined,
    );

    expect(conditionalEntries.map((entry) => entry.program)).toEqual(
      CONDITIONAL_READ_ONLY_PROGRAMS,
    );
    for (const entry of conditionalEntries) {
      expect(entry.class).toBe("read-only");
    }
  });

  it("keeps one entry per program", () => {
    const programs = EFFECT_REGISTRY.map((entry) => entry.program);
    expect(new Set(programs).size).toBe(programs.length);
  });

  it("documents the shipped unconditional and conditional sets", () => {
    const entriesByClass = groupProgramsByClass();

    expect(
      EFFECT_REGISTRY.filter(
        (entry) => entry.class === "read-only" && entry.condition === undefined,
      ).map((entry) => entry.program),
    ).toEqual(UNCONDITIONAL_READ_ONLY_PROGRAMS);
    expect(
      EFFECT_REGISTRY.filter((entry) => entry.condition !== undefined).map(
        (entry) => entry.program,
      ),
    ).toEqual(CONDITIONAL_READ_ONLY_PROGRAMS);
    expect(entriesByClass.write).toEqual(WRITE_PROGRAMS);
    expect(entriesByClass.destructive).toEqual(DESTRUCTIVE_PROGRAMS);
    expect(entriesByClass.network).toEqual(NETWORK_PROGRAMS);
    expect(entriesByClass["shell-wrap"]).toEqual(SHELL_WRAP_PROGRAMS);
    expect(entriesByClass.unknown).toEqual([]);
  });
});

describe("classifyStageEffect", () => {
  it("classifies non-command and unresolvable stages as unknown", async () => {
    const loopStage = await firstStage('for f in a; do cat "$f"; done');
    expect(loopStage.kind).toBe("for-loop");
    expect(classifyStageEffect(loopStage)).toEqual({
      class: "unknown",
      reason: "non-command-stage",
    });

    await expectCommandClassification("$prog foo", {
      class: "unknown",
      reason: "unresolvable-program",
    });
  });

  it("runs substitution before registry and redirect classification", async () => {
    await expectCommandClassification("cat $(secret)", {
      class: "unknown",
      reason: "stage-substitution",
    });
    await expectCommandClassification('echo "$(x)"', {
      class: "unknown",
      reason: "stage-substitution",
    });
    await expectCommandClassification("cat $(x) > out", {
      class: "unknown",
      reason: "stage-substitution",
    });
  });

  it("classifies output file redirects as writes and ignores read/fd duplication redirects", async () => {
    for (const command of [
      "cat foo > bar",
      "cat foo >> bar",
      "cat foo 2> err",
      "cat foo &> both",
      "cat foo 3> out",
    ]) {
      await expectCommandClassification(command, {
        class: "write",
        reason: "file-output-redirect",
      });
    }

    await expectCommandClassification("cat < in", {
      class: "read-only",
      reason: "read-only-file-concatenation",
    });
    await expectCommandClassification("cat foo 2>&1", {
      class: "read-only",
      reason: "read-only-file-concatenation",
    });
  });

  it("classifies missing registry entries as unknown", async () => {
    await expectCommandClassification("nosuchcmd foo", {
      class: "unknown",
      reason: "program-not-registered",
    });
  });

  it("classifies unconditional read-only programs", async () => {
    for (const command of [
      "ls",
      "cat file",
      "head file",
      "wc file",
      "echo hi",
      "printf hi",
      "jq . f",
    ]) {
      expect((await classifyCommand(command)).class).toBe("read-only");
    }
  });

  it("classifies sed only for narrow print-only shapes", async () => {
    await expectCommandClassification("sed -n '1,10p' f", {
      class: "read-only",
      reason: "read-only-sed-print-only-without-in-place",
    });
    await expectCommandClassification("sed -i f", {
      class: "unknown",
      reason: "forbidden-flag-present",
    });
    await expectCommandClassification("sed -n -i.bak '1p' f", {
      class: "unknown",
      reason: "forbidden-flag-present",
    });
    await expectCommandClassification("sed f", {
      class: "unknown",
      reason: "missing-required-flag",
    });
    await expectCommandClassification("sed -n 'w out' f", {
      class: "unknown",
      reason: "argument-shape-unsupported",
    });
    await expectCommandClassification("sed -n 's/a/b/w out' f", {
      class: "unknown",
      reason: "argument-shape-unsupported",
    });
  });

  it("classifies find print-only shapes and rejects output/mutation primaries", async () => {
    await expectCommandClassification("find . -print", {
      class: "read-only",
      reason: "read-only-find-without-mutating-action",
    });

    for (const command of [
      "find . -delete",
      "find . -fprint out",
      "find . -fprintf out '%p'",
      "find . -fls out",
    ]) {
      await expectCommandClassification(command, {
        class: "unknown",
        reason: "forbidden-flag-present",
      });
    }
  });

  it("classifies sort only without output-file flags", async () => {
    await expectCommandClassification("sort f", {
      class: "read-only",
      reason: "read-only-sort-without-output-file",
    });
    await expectCommandClassification("sort -o out f", {
      class: "unknown",
      reason: "forbidden-flag-present",
    });
    await expectCommandClassification("sort -oout f", {
      class: "unknown",
      reason: "forbidden-flag-present",
    });
  });

  it("classifies tail only without follow modes", async () => {
    await expectCommandClassification("tail f", {
      class: "read-only",
      reason: "read-only-tail-without-follow",
    });

    for (const command of ["tail -f f", "tail -F f", "tail -nf f"]) {
      await expectCommandClassification(command, {
        class: "unknown",
        reason: "forbidden-flag-present",
      });
    }
  });

  it("treats grep no-op argument shape as read-only and rejects unsafe ripgrep modes", async () => {
    await expectCommandClassification("grep x f", {
      class: "read-only",
      reason: "read-only-grep-compound-compatible",
    });

    for (const command of ["rg --replace X pat f", "rg --pre cmd pat f"]) {
      await expectCommandClassification(command, {
        class: "unknown",
        reason: "forbidden-flag-present",
      });
    }
  });

  it("classifies registry exclusion classes", async () => {
    await expectCommandClassification("rm -rf x", {
      class: "destructive",
      reason: "filesystem-remove",
    });
    await expectCommandClassification("mv a b", {
      class: "write",
      reason: "filesystem-move-write",
    });
    await expectCommandClassification("curl url", {
      class: "network",
      reason: "network-transfer",
    });
    await expectCommandClassification("bash -c 'x'", {
      class: "shell-wrap",
      reason: "shell-wrapper",
    });
    await expectCommandClassification("env", {
      class: "shell-wrap",
      reason: "shell-env-wrapper",
    });
    await expectCommandClassification("command ls", {
      class: "unknown",
      reason: "missing-required-flag",
    });
    await expectCommandClassification("command -v ls", {
      class: "read-only",
      reason: "read-only-command-existence-inspection",
    });
  });
});

describe("getStageFileInputArgIndices", () => {
  it("resolves program-specific file operand indices", async () => {
    await expectFileInputIndices("cat a b c", [0, 1, 2]);
    await expectFileInputIndices("head -n 5 file", [1]);
    await expectFileInputIndices("sed -n '1,10p' f", [1]);
    await expectFileInputIndices("grep -e pat file", [1]);
    await expectFileInputIndices("rg pat path", [1]);
    await expectFileInputIndices("sort f", [0]);
  });

  it("fails closed for non-read-only, value-only, unregistered, and unresolvable stages", async () => {
    await expectFileInputIndices("sort -o out f", []);
    await expectFileInputIndices("sort -oout f", []);
    await expectFileInputIndices("echo hi", []);
    await expectFileInputIndices("cat $(secret)", []);
    await expectFileInputIndices("find . -delete", []);
    await expectFileInputIndices("find . -printf FORMAT", []);
    await expectFileInputIndices("find . -name foo /some/path", []);
    await expectFileInputIndices("find . -type f /some/path", []);
    await expectFileInputIndices("jq . f", []);
    await expectFileInputIndices("jq --slurpfile a file expr f", []);
    await expectFileInputIndices("jq --argjson k 1 expr f", []);
    await expectFileInputIndices("nosuchcmd a b", []);
    await expectFileInputIndices("$prog foo", []);
  });
});

function groupProgramsByClass(): Record<EffectClass, readonly string[]> {
  const grouped: Record<EffectClass, string[]> = {
    "read-only": [],
    write: [],
    destructive: [],
    network: [],
    "shell-wrap": [],
    unknown: [],
  };

  for (const entry of EFFECT_REGISTRY) {
    grouped[entry.class].push(entry.program);
  }

  return grouped;
}

async function expectCommandClassification(
  command: string,
  expected: { readonly class: EffectClass; readonly reason: string },
): Promise<void> {
  expect(await classifyCommand(command)).toEqual(expected);
}

async function classifyCommand(command: string) {
  return classifyStageEffect(await firstStage(command));
}

async function expectFileInputIndices(
  command: string,
  expected: readonly number[],
): Promise<void> {
  expect(getStageFileInputArgIndices(await firstStage(command))).toEqual(
    expected,
  );
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
