import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeCommandRunner } from "../../../src/infrastructure/process/command-runner.js";
import { createNodeProjectRootResolver } from "../../../src/infrastructure/project/node-project-root-resolver.js";

const execFile = promisify(execFileCallback);
const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function gitRepository() {
  const root = await mkdtemp(join(tmpdir(), "project-root-resolver-"));
  roots.push(root);
  await execFile("git", ["init", root]);
  return root;
}

describe("node project root resolver", () => {
  it("derives the repository fingerprint from the git common directory inode only", async () => {
    const cwd = await gitRepository();
    const resolved = (await createNodeProjectRootResolver({ cwd, sha256, git: createNodeCommandRunner() }).resolve(signal)) as {
      identity: { kind: string; repositoryFingerprint?: string };
    };
    expect(resolved.identity.kind).toBe("repository");
    // v2 is mount-stable by construction: st_dev changes per mount on btrfs and
    // similar filesystems, so the preimage must contain the inode only.
    const common = await realpath(join(cwd, ".git"));
    const stats = await lstat(common);
    const preimage = new TextEncoder().encode(`git-common-directory-v2\0inode:${String(stats.ino)}`);
    const expected = `sha256:${[...sha256(preimage)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    expect(resolved.identity.repositoryFingerprint).toBe(expected);
  });

  it("returns path-only identity outside a git repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "project-root-resolver-plain-"));
    roots.push(cwd);
    const resolved = (await createNodeProjectRootResolver({ cwd, sha256, git: createNodeCommandRunner() }).resolve(signal)) as {
      identity: { kind: string };
    };
    expect(resolved.identity.kind).toBe("path-only");
  });
});
