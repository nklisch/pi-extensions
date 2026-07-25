import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSessionBinding } from "../../src/pi/pi-session-binding.js";
import { createPiProjectContextAdapters } from "../../src/pi/pi-project-context.js";
import { createNodeCommandRunner } from "../../src/infrastructure/process/command-runner.js";
import { createNodeConfigurationPathPort } from "../../src/infrastructure/configuration/node-configuration-path.js";

const run = promisify(execFile);
const roots: string[] = [];
const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context(cwd: string, trusted: () => boolean, sessionId = "session-1"): ExtensionContext {
  return {
    cwd,
    mode: "tui",
    isProjectTrusted: trusted,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
  } as unknown as ExtensionContext;
}

describe("Pi project context adapters", () => {
  it("binds canonical Git identity and live Pi trust to one session project", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-host-project-"));
    roots.push(root);
    await run("git", ["init", "-q", root]);
    let trusted = true;
    const binding = createPiSessionBinding(context(root, () => trusted));
    const project = await createPiProjectContextAdapters({ binding, sha256, git: createNodeCommandRunner() });
    expect(project.scope.identity.kind).toBe("repository");
    expect(project.current()).toMatchObject({ projectKey: project.scope.projectKey, trust: { kind: "trusted" } });
    expect(await project.trust.assess(project.scope.projectKey, new AbortController().signal)).toEqual({ kind: "trusted" });
    trusted = false;
    expect(project.current().trust).toEqual({ kind: "untrusted" });
    expect(await project.trust.assess(project.scope.projectKey, new AbortController().signal)).toEqual({ kind: "untrusted" });
    expect(await project.trust.assess(`project-v1:sha256:${"f".repeat(64)}` as never, new AbortController().signal)).toEqual({ kind: "untrusted" });
  });

  it("invalidates old root capabilities when the Git common-directory identity is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-host-project-replaced-"));
    roots.push(root);
    await run("git", ["init", "-q", root]);
    const binding = createPiSessionBinding(context(root, () => true));
    const project = await createPiProjectContextAdapters({ binding, sha256, git: createNodeCommandRunner() });
    const capability = await project.authority.acquire(new AbortController().signal);
    await rm(join(root, ".git"), { recursive: true, force: true });
    // A distinct common-directory path makes identity replacement deterministic;
    // deleting and recreating `.git` can reuse the same inode on CI filesystems.
    await run("git", ["init", "-q", `--separate-git-dir=${join(root, "replacement.git")}`, root]);

    await expect(project.trust.assess(project.scope.projectKey, new AbortController().signal)).resolves.toEqual({ kind: "untrusted" });
    expect(() => project.authority.verify(capability, project.scope)).toThrow(/capability/);
    const paths = createNodeConfigurationPathPort({ binding, projectRoots: project.authority });
    await expect(paths.normalizeAndInspect({
      value: "config.json",
      expected: "file",
      mustExist: false,
      context: { scope: project.scope, trustedProjectRoot: capability },
    }, new AbortController().signal)).resolves.toEqual({ kind: "invalid" });
  });

  it("denies lexical and symlink escape through the trusted-root capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-host-project-path-"));
    const outside = await mkdtemp(join(tmpdir(), "plugin-host-project-outside-"));
    roots.push(root, outside);
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "valid.txt"), "ok");
    await writeFile(join(outside, "secret.txt"), "CANARY");
    await symlink(outside, join(root, "escape"));
    const binding = createPiSessionBinding(context(root, () => true));
    const project = await createPiProjectContextAdapters({ binding, sha256 });
    const capability = await project.authority.acquire(new AbortController().signal);
    const paths = createNodeConfigurationPathPort({ binding, projectRoots: project.authority });
    const base = { scope: project.scope, trustedProjectRoot: capability };
    await expect(paths.normalizeAndInspect({ value: "config/valid.txt", expected: "file", mustExist: true, context: base }, new AbortController().signal))
      .resolves.toMatchObject({ kind: "valid" });
    await expect(paths.normalizeAndInspect({ value: "../plugin-host-project-outside/secret.txt", expected: "file", mustExist: true, context: base }, new AbortController().signal))
      .resolves.toEqual({ kind: "invalid" });
    await expect(paths.normalizeAndInspect({ value: "escape/secret.txt", expected: "file", mustExist: true, context: base }, new AbortController().signal))
      .resolves.toEqual({ kind: "invalid" });
    await expect(paths.normalizeAndInspect({ value: "config/valid.txt", expected: "file", mustExist: true, context: { ...base, trustedProjectRoot: { ...capability } as never } }, new AbortController().signal))
      .resolves.toEqual({ kind: "invalid" });
  });
});
