import type { RawMatcher } from "./condition-guards.ts";
import { defineShippedPack } from "./define.ts";

const testMatcher = (name: "test" | "[" | "[["): RawMatcher => ({
  all: [
    { program: name },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
});

const commandExistenceMatcher: RawMatcher = {
  all: [
    { program: "command" },
    { any: [{ flagPresent: "v" }, { flagPresent: "V" }] },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const exportLiteralMatcher: RawMatcher = {
  all: [
    { program: "export" },
    { argCount: { max: 0 } },
    { flagAllowlist: {} },
    { envAssignmentCount: { min: 1 } },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const setSafeOptionsMatcher: RawMatcher = {
  all: [
    { program: "set" },
    { flagAllowlist: { shortChars: ["e", "u"] } },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const setPipefailMatcher: RawMatcher = {
  all: [
    { program: "set" },
    { flagAllowlist: { shortChars: ["e", "u", "o"] } },
    { argAt: { index: 0, value: "pipefail" } },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

const cdMatcher: RawMatcher = {
  all: [
    { program: "cd" },
    { argCount: { max: 1 } },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

/** Stage-shaped shell-builtin families reused by heterogeneous composition. */
export const BASH_SHELL_BUILTINS_STAGE_FAMILY_MATCHERS: readonly RawMatcher[] =
  [
    testMatcher("test"),
    testMatcher("["),
    testMatcher("[["),
    commandExistenceMatcher,
    exportLiteralMatcher,
    setSafeOptionsMatcher,
    setPipefailMatcher,
    cdMatcher,
  ];

const rawPack = {
  version: 1,
  id: "bash.shell.builtins",
  rules: [
    {
      id: "bash.shell.builtins:allow-test",
      effect: "allow",
      match: testMatcher("test"),
      reason: "shell test predicate without substitution or stdout redirection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.shell.builtins:allow-bracket-test",
      effect: "allow",
      match: testMatcher("["),
      reason:
        "bracket test predicate without substitution or stdout redirection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.shell.builtins:allow-double-bracket-test",
      effect: "allow",
      match: testMatcher("[["),
      reason:
        "double-bracket test predicate without substitution or stdout redirection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.shell.builtins:allow-command-existence",
      effect: "allow",
      match: commandExistenceMatcher,
      reason: "command -v/-V existence inspection",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.shell.builtins:allow-export-literals",
      effect: "allow",
      match: exportLiteralMatcher,
      reason: "literal environment declaration in a fresh shell",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.shell.builtins:allow-set-safe-options",
      effect: "allow",
      match: setSafeOptionsMatcher,
      reason: "safe shell error-handling options",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.shell.builtins:allow-set-pipefail",
      effect: "allow",
      match: setPipefailMatcher,
      reason: "safe shell pipefail option",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.shell.builtins:allow-cd-fresh-shell",
      effect: "allow",
      match: cdMatcher,
      reason: "cwd change has no later command in a fresh shell",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const bashShellBuiltinsPack = defineShippedPack(rawPack);
