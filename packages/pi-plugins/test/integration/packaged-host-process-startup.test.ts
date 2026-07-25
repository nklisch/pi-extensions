import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixture = resolve(process.cwd(), "test/fixtures/composition/child-packaged-host-startup.mjs");
const loader = resolve(process.cwd(), "test/fixtures/locking/source-loader.mjs");

function child(agentDir: string, projectRoot: string, sessionId: string): Promise<{ status: string; networkCalls: number; publisherCalls: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const handle = spawn(process.execPath, [
      "--experimental-strip-types",
      "--experimental-transform-types",
      "--loader",
      loader,
      fixture,
      agentDir,
      projectRoot,
      sessionId,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "", VITEST: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    handle.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    handle.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    handle.once("close", (code) => {
      if (code !== 0) rejectPromise(new Error(`host child failed: ${stderr}`));
      else resolvePromise(JSON.parse(stdout.trim()) as { status: string; networkCalls: number; publisherCalls: number });
    });
  });
}

describe("packaged host process startup", () => {
  it("opens two clean hosts concurrently through identity-bound state, lease, and retention initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-dual-startup-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    try {
      const results = await Promise.all([
        child(agentDir, project, "session-left"),
        child(agentDir, project, "session-right"),
      ]);
      expect(results).toEqual([{ status: "ready", networkCalls: 0, publisherCalls: 0 }, { status: "ready", networkCalls: 0, publisherCalls: 0 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
