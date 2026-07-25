import { describe, it } from "vitest";

import { bashShellBuiltinsPack } from "../../src/packs/bash.shell.builtins.ts";
import {
  expectAllowFromPack,
  expectCleanLoad,
  expectDecisionEffect,
} from "./helpers.ts";

describe("bash.shell.builtins pack", () => {
  it("loads cleanly against the sealed floor", () => {
    expectCleanLoad(bashShellBuiltinsPack);
  });

  it.each([
    "test -f x",
    "[ -f x ]",
    "[[ -n literal ]]",
    "command -v node",
    "command -V node",
    "export FOO=1",
    "export FOO=1 BAR=2",
    "set -e",
    "set -euo pipefail",
    "cd ..",
  ])("allows safe shell builtin form: %s", async (command) => {
    await expectAllowFromPack(
      command,
      bashShellBuiltinsPack,
      "bash.shell.builtins",
    );
  });

  it.each([
    "export",
    "export -p",
    "export FOO=$HOME",
    "set -x",
    "cd a b",
    "cd x; ls",
    "command rm file",
  ])("keeps unsafe or ambiguous shell builtin form gated: %s", async (command) => {
    await expectDecisionEffect(command, bashShellBuiltinsPack, "review");
  });
});
