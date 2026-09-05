import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveProjectIdentity } from "../src/scope.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project identity", () => {
  it("shares identity across subdirectories and linked worktrees", () => {
    const parent = mkdtempSync(join(tmpdir(), "pocket-scope-"));
    roots.push(parent);
    const repo = join(parent, "repo");
    const worktree = join(parent, "worktree");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    writeFileSync(join(repo, "tracked.txt"), "x");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
    mkdirSync(join(repo, "nested"));
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", worktree]);

    const identity = resolveProjectIdentity(repo);
    expect(resolveProjectIdentity(join(repo, "nested"))).toBe(identity);
    expect(resolveProjectIdentity(worktree)).toBe(identity);
  });

  it("uses a resolved cwd for non-Git directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-no-git-"));
    roots.push(dir);
    expect(resolveProjectIdentity(dir)).toBe(dir);
  });
});
