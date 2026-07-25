import { describe, expect, it } from "vitest";

import { bashPackagesCommonPack } from "../../src/packs/bash.packages.common.ts";
import {
  expectAllowFromPack,
  expectCleanLoad,
  expectDecisionEffect,
} from "./helpers.ts";

describe("bash.packages.common pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(bashPackagesCommonPack).toMatchObject({
      version: 1,
      id: "bash.packages.common",
    });
    expectCleanLoad(bashPackagesCommonPack);
  });

  it.each([
    "npm install",
    "npm ci",
    "npm update",
    "pnpm install",
    "pnpm --dir /tmp install",
    "pnpm add typescript",
    "pnpm remove x",
    "pnpm update",
    "yarn install",
    "yarn add x",
    "yarn remove x",
    "yarn upgrade",
    "cargo add tokio",
    "cargo update",
    "cargo remove x",
    "uv sync",
    "uv add x",
    "uv remove x",
    "uv pip install -r requirements.txt",
    "uv pip sync requirements.txt",
    "pip install -r requirements.txt",
    "go mod tidy",
    "go mod download",
    "go get ./...",
  ])("allows common package workflow: %s", async (command) => {
    await expectAllowFromPack(
      command,
      bashPackagesCommonPack,
      "bash.packages.common",
    );
  });

  it.each([
    "npm install -g",
    "npm install --prefix /tmp",
    "pnpm --global add x",
    "pip install --user x",
    "pip install --target /tmp x",
    "uv pip install --system x",
    "uv pip install --target /tmp x",
    "npm install $(cmd)",
    "pnpm install > out.log",
    "go mod edit -replace x=y",
  ])("reviews global/scope/hidden package workflow: %s", async (command) => {
    await expectDecisionEffect(command, bashPackagesCommonPack, "review");
  });

  it("keeps sealed floor precedence", async () => {
    await expectDecisionEffect(
      "sudo npm install",
      bashPackagesCommonPack,
      "deny",
    );
  });
});
