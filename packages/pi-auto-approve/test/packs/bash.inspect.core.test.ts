import { describe, expect, it } from "vitest";

import { bashInspectCorePack } from "../../src/packs/bash.inspect.core.ts";
import {
  decideWithPacks,
  expectAllowFromPack,
  expectCleanLoad,
  expectDecisionEffect,
} from "./helpers.ts";

describe("bash.inspect.core pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(bashInspectCorePack).toMatchObject({
      version: 1,
      id: "bash.inspect.core",
    });
    expectCleanLoad(bashInspectCorePack);
  });

  it.each([
    "ls -la",
    "cat README.md",
    "head -n 5 file",
    "tail -n 10 file",
    "wc -l file",
    "file bin",
    "stat file",
    "pwd",
    "uname -a",
    "whoami",
    "id",
    "printf hello",
    "echo hello",
  ])("allows read-only inspection command: %s", async (command) => {
    await expectAllowFromPack(
      command,
      bashInspectCorePack,
      "bash.inspect.core",
    );
  });

  it.each([
    "tail -f app.log",
    "tail -F app.log",
    "tail --follow app.log",
  ])("reviews long-running tail follow mode: %s", async (command) => {
    await expectDecisionEffect(command, bashInspectCorePack, "review");
  });

  it.each([
    "cat $(ls)",
    "echo $SECRET",
    "ls $(pwd)",
    "ls > out",
    "cat file >> out",
    "echo x &> out",
  ])("reviews substitution or stdout redirection: %s", async (command) => {
    await expectDecisionEffect(command, bashInspectCorePack, "review");
  });

  it.each([
    "sudo ls",
    "rm -rf /",
    "shutdown -h now",
  ])("keeps sealed floor precedence for %s", async (command) => {
    await expectDecisionEffect(command, bashInspectCorePack, "deny");
  });

  it("gates secret-path reads behind the argument path guard", async () => {
    // The read-program path guard (2026-07-23) scopes file-input reads to
    // project/temp/non-secret home: secret material must review, never
    // exfiltrate to the transcript.
    expect(
      await decideWithPacks("cat ~/.ssh/id_rsa", [bashInspectCorePack]),
    ).toMatchObject({
      effect: "review",
    });
  });
});
