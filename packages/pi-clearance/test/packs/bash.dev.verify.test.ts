import { describe, expect, it } from "vitest";

import { bashDevVerifyPack } from "../../src/packs/bash.dev.verify.ts";
import { bashStructureSafePack } from "../../src/packs/bash.structure.safe.ts";
import {
  expectAllowFromPack,
  expectCleanLoad,
  expectDecisionEffect,
} from "./helpers.ts";

describe("bash.dev.verify pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(bashDevVerifyPack).toMatchObject({
      version: 1,
      id: "bash.dev.verify",
    });
    expectCleanLoad(bashDevVerifyPack);
  });

  it.each([
    "pnpm test",
    "pnpm --dir /tmp run lint",
    "pnpm build",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm run test",
    "pnpm run-script build",
    "pnpm vitest",
    "node --version",
    "node --help",
    "npm test",
    "npm deploy",
    "npm run deploy",
    "npm run lint",
    "yarn test",
    "yarn deploy",
    "yarn run deploy",
    "yarn lint",
    "yarn run test",
    "cargo test",
    "cargo build",
    "cargo check",
    "cargo fmt --check",
    "cargo fmt",
    "cargo fmt -- src/lib.rs",
    "cargo run",
    "go test ./...",
    "go run .",
    "go build",
    "go vet",
    "vitest run",
    "jest",
    "pytest",
    "tsc --noEmit",
    "tsc",
    "biome check .",
    "biome format .",
    "biome lint .",
    "biome --write .",
    "biome format --write src",
    "biome check --write",
    "biome format --write",
    "eslint .",
    "eslint --fix .",
    "eslint --fix",
    "prettier --check .",
    "prettier --write .",
    "prettier --write src",
    "prettier --write",
    "ruff check .",
    "ruff check --fix .",
    "ruff check --fix src",
    "ruff check --fix",
    "eslint --fix src",
    "mypy src",
  ])("allows verification workflow command: %s", async (command) => {
    await expectAllowFromPack(command, bashDevVerifyPack, "bash.dev.verify");
  });

  it.each([
    "biome format --apply",
    "biome --write /tmp/out.ts",
    "biome --write --config-path /tmp/biome.json .",
    "prettier --write /tmp/out.ts",
    "prettier --write --config /tmp/prettier.config.js .",
    "prettier --write --config-path /tmp/prettier.config.js .",
    "prettier --write --plugin-search-dir /tmp/plugins .",
    "eslint --fix --config /tmp/eslint.config.js .",
    "eslint --fix --rulesdir /tmp/rules .",
    "ruff check --fix /tmp/out.py",
    "ruff check --fix --config /tmp/ruff.toml .",
    "eslint --fix /tmp/out.js",
    "cargo fmt -- /tmp/out.rs",
    "cargo fmt -- --config-path /tmp/rustfmt.toml",
    "cargo fmt -- --unstable-features",
    "go fmt ./...",
    "node",
    "node -",
    "node -e 'x'",
    "node --inspect script.js",
    "cargo clippy --fix",
    "pnpm test $(cmd)",
    "cargo test > out.log",
    "vitest --update",
  ])("reviews mutating or ambiguous verify form: %s", async (command) => {
    await expectDecisionEffect(command, bashDevVerifyPack, "review");
  });

  it("keeps formatter writes out of read-only composition families", async () => {
    await expectDecisionEffect(
      "prettier --write src && prettier --write src",
      bashStructureSafePack,
      "review",
    );
  });

  it("keeps sealed floor precedence", async () => {
    await expectDecisionEffect("sudo pnpm test", bashDevVerifyPack, "deny");
  });
});
