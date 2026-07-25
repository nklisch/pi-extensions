import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createPackagedPluginHost } from "../../src/composition/create-packaged-plugin-host.js";
import { createPluginHostPathPlan } from "../../src/composition/plugin-host-paths.js";
import { createNodeLifecycleStateAdapters } from "../../src/infrastructure/state/sqlite-lifecycle-state-store.js";
import { createNodeRecoveryAdapters } from "../../src/infrastructure/recovery/create-node-recovery-adapters.js";
import { createScopeContext, deriveProjectKey } from "../../src/domain/state/scope.js";

const fixture = resolve(process.cwd(), "test/fixtures/recovery/child-packaged-crash-state.mjs");
const loader = resolve(process.cwd(), "test/fixtures/locking/source-loader.mjs");
const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

function createCrashState(agentDir: string, projectRoot: string): Promise<{ reference: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const handle = spawn(process.execPath, [
      "--experimental-strip-types",
      "--experimental-transform-types",
      "--loader",
      loader,
      fixture,
      agentDir,
      projectRoot,
    ], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "", VITEST: undefined }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    handle.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    handle.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    handle.once("close", (code) => {
      if (code !== 0) rejectPromise(new Error(`crash-state child failed: ${stderr}`));
      else resolvePromise(JSON.parse(stdout.trim()) as { reference: string });
    });
  });
}

function pi() { return { on() {}, sendMessage() {}, setSessionName() {} }; }
function context(cwd: string) {
  return { cwd, mode: "interactive", sessionManager: { getSessionId: () => "fresh-recovery-session", getSessionFile: () => undefined }, isProjectTrusted: () => true };
}

describe("packaged host fresh-process crash recovery", () => {
  it("locally reconciles and rolls back a pending install before desired-state publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-crash-recovery-"));
    const agentDir = join(root, "agent");
    const projectRoot = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(projectRoot)]);
    try {
      const crash = await createCrashState(agentDir, projectRoot);
      const host = createPackagedPluginHost({ pi: pi() as never, agentDir });
      const started = await host.start({ type: "session_start", reason: "startup" } as never, context(projectRoot) as never);
      if (started.startup.status !== "ready") throw new Error(JSON.stringify(started.startup));
      expect(started.startup.blocked).toEqual([]);
      await host.dispose("quit");

      const identity = { kind: "path-only" as const, canonicalRoot: pathToFileURL(projectRoot).href as never, limitation: "identity-changes-with-canonical-root" as const };
      const project = createScopeContext({ kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) }, sha256);
      if (project.kind !== "project") throw new Error("project scope unavailable");
      const paths = createPluginHostPathPlan(agentDir);
      const state = await createNodeLifecycleStateAdapters({ paths, currentProject: project, sha256, verifyLocalFilesystem: async () => {} });
      const recovery = await createNodeRecoveryAdapters({ hostRoot: paths.hostRoot, verifyLocalFilesystem: async () => {} });
      try {
        const loaded = await state.state.read({ kind: "user" }, new AbortController().signal);
        expect(loaded.ok && loaded.snapshot.installed.plugins).toEqual([]);
        const journal = await recovery.transitionStore.read!({ scope: { kind: "user" }, reference: crash.reference as never }, new AbortController().signal);
        expect(journal).toMatchObject({ kind: "found", entry: { status: { kind: "rolled-back" } } });
      } finally {
        await state.close();
        await recovery.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
