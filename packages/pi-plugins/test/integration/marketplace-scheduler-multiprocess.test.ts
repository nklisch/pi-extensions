import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixture = resolve(process.cwd(), "test/fixtures/composition/child-update-scheduler-state.mjs");
const loader = resolve(process.cwd(), "test/fixtures/locking/source-loader.mjs");
const ownerA = "update-scheduler-lease-v1:uuid:123e4567-e89b-42d3-a456-426614174000";
const ownerB = "update-scheduler-lease-v1:uuid:123e4567-e89b-42d3-a456-426614174001";

function child<T>(agentDir: string, projectRoot: string, mode: "lease" | "seed" | "inventory", now: number, value?: string | number): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const handle = spawn(process.execPath, [
      "--experimental-strip-types", "--experimental-transform-types", "--loader", loader,
      fixture, agentDir, projectRoot, mode, String(now), ...(value === undefined ? [] : [String(value)]),
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
      if (code !== 0) rejectPromise(new Error(`scheduler child failed (${mode}): ${stderr}`));
      else resolvePromise(JSON.parse(stdout.trim()) as T);
    });
  });
}

async function roots() {
  const root = await mkdtemp(join(tmpdir(), "pi-update-scheduler-process-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(project)]);
  return { root, agentDir, project };
}

describe("multiprocess update scheduler ownership", () => {
  it("elects one SQLite-backed owner and permits expiry takeover from a fresh process", async () => {
    const value = await roots();
    try {
      const initial = await Promise.all([
        child<{ result: string }>(value.agentDir, value.project, "lease", 1_000, ownerA),
        child<{ result: string }>(value.agentDir, value.project, "lease", 1_000, ownerB),
      ]);
      expect(initial.map((entry) => entry.result).sort()).toEqual(["other", "self"]);
      const loser = initial[0]!.result === "self" ? ownerB : ownerA;
      await expect(child<{ result: string }>(value.agentDir, value.project, "lease", 2_001, loser)).resolves.toEqual({ result: "self" });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("treats a future-clock owner as expired without publishing lease identity", async () => {
    const value = await roots();
    try {
      await expect(child<{ result: string }>(value.agentDir, value.project, "lease", 5_000, ownerA)).resolves.toEqual({ result: "self" });
      await expect(child<{ result: string }>(value.agentDir, value.project, "lease", 1_000, ownerB)).resolves.toEqual({ result: "self" });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves deterministic failure backoff/jitter across restart and reports backward clock", async () => {
    const value = await roots();
    try {
      const seeded = await child<{ result: string; schedule: { anchorAt: number; dueAt: number; jitterMs: number } }>(value.agentDir, value.project, "seed", 10_000, 3);
      expect(seeded.result).toBe("committed");
      const restarted = await child<{ plan: { dueAt: number; clock: string } }>(value.agentDir, value.project, "inventory", 10_001);
      expect(restarted.plan).toMatchObject({ dueAt: seeded.schedule.dueAt, clock: "current" });
      const regressed = await child<{ plan: { dueAt: number; clock: string } }>(value.agentDir, value.project, "inventory", 9_999);
      expect(regressed.plan).toMatchObject({ dueAt: seeded.schedule.dueAt, clock: "regressed" });
      expect(seeded.schedule.dueAt).toBeGreaterThan(seeded.schedule.anchorAt);
      expect(Number.isSafeInteger(seeded.schedule.jitterMs)).toBe(true);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }, 30_000);
});
