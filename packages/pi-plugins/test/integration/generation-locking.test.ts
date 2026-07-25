import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createInterface } from "node:readline";
import { createKeyedMutationScheduler } from "../../src/infrastructure/state/keyed-mutation-scheduler.js";
import { createSqliteScopeLockManager } from "../../src/infrastructure/state/sqlite-scope-lock.js";
import type { ScopeReference } from "../../src/domain/state/scope.js";

const user: ScopeReference = { kind: "user" };
const project: ScopeReference = {
  kind: "project",
  projectKey: `project-v1:sha256:${"d".repeat(64)}` as never,
};
const fixture = resolve(process.cwd(), "test/fixtures/locking/child-generation-coordinator.mjs");
const loader = resolve(process.cwd(), "test/fixtures/locking/source-loader.mjs");

type ChildEvent = Readonly<Record<string, unknown>>;

type Child = {
  readonly process: ChildProcessWithoutNullStreams;
  readonly events: ChildEvent[];
  readonly send: (command: string) => void;
  readonly waitFor: (predicate: (event: ChildEvent) => boolean) => Promise<ChildEvent>;
};

const closedChildren = new WeakSet<ChildProcessWithoutNullStreams>();

function child(lockRoot: string, statePath: string, role: string, mode = "normal"): Child {
  const childProcess = spawn(process.execPath, [
    "--experimental-strip-types",
    "--experimental-transform-types",
    "--loader",
    loader,
    fixture,
    lockRoot,
    statePath,
    role,
    mode,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_OPTIONS: "", VITEST: undefined },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: ChildEvent[] = [];
  let stderr = "";
  childProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const waiters: Array<{
    readonly predicate: (event: ChildEvent) => boolean;
    readonly resolve: (event: ChildEvent) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  const lines = createInterface({ input: childProcess.stdout });
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line) as ChildEvent;
      events.push(event);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(event)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    } catch {
      // A malformed child line is surfaced by a later missing event or exit.
    }
  });
  childProcess.once("close", (code, signal) => {
    closedChildren.add(childProcess);
    const error = new Error(`child exited before expected event: ${code ?? signal}; stderr: ${stderr}`);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  return {
    process: childProcess,
    events,
    send(command: string) {
      childProcess.stdin.write(`${command}\n`);
    },
    waitFor(predicate: (event: ChildEvent) => boolean) {
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
        return Promise.reject(new Error(`child exited before expected event: ${childProcess.exitCode ?? childProcess.signalCode}; stderr: ${stderr}`));
      }
      return new Promise((resolvePromise, rejectPromise) => waiters.push({ predicate, resolve: resolvePromise, reject: rejectPromise }));
    },
  };
}

async function waitForExit(childProcess: ChildProcessWithoutNullStreams): Promise<void> {
  if (closedChildren.has(childProcess)) return;
  await new Promise<void>((resolvePromise) => childProcess.once("close", () => resolvePromise()));
}

async function generation(statePath: string): Promise<number> {
  const value = JSON.parse(await readFile(statePath, "utf8")) as { generation?: unknown };
  if (!Number.isSafeInteger(value.generation)) throw new Error("test shared generation is invalid");
  return value.generation;
}

async function prepareState(): Promise<{ readonly lockRoot: string; readonly statePath: string }> {
  const lockRoot = await mkdtemp(join(process.cwd(), ".test-generation-locking-"));
  const statePath = join(lockRoot, "generation.json");
  await writeFile(statePath, JSON.stringify({ generation: 0 }), "utf8");
  return { lockRoot, statePath };
}

async function runFirstUseContention(): Promise<readonly ChildEvent[]> {
  const { lockRoot, statePath } = await prepareState();
  const first = child(lockRoot, statePath, "first");
  const second = child(lockRoot, statePath, "second");
  try {
    await Promise.all([
      first.waitFor((event) => event.event === "ready"),
      second.waitFor((event) => event.event === "ready"),
    ]);
    first.send("go");
    second.send("go");
    return await Promise.all([
      first.waitFor((event) => event.event === "result" || event.event === "error"),
      second.waitFor((event) => event.event === "result" || event.event === "error"),
    ]);
  } finally {
    for (const process of [first.process, second.process]) {
      if (process.exitCode === null) process.kill("SIGKILL");
    }
    await Promise.all([waitForExit(first.process), waitForExit(second.process)]);
    await rm(lockRoot, { recursive: true, force: true });
  }
}

describe("generation-locking integration", () => {
  // Eight fresh process pairs retain repeated first-use coverage. Each child
  // loads the real TypeScript graph in a fresh Node process; under the fully
  // parallel unit suite that startup is substantially slower than in focused
  // runs, so the budget must cover saturated CI rather than only lock work.
  it("repeatedly contends on two real first-use coordinators with one commit and one stale result", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const terminals = await runFirstUseContention();
      expect(
        terminals.every((event) => event.event === "result"),
        JSON.stringify({ attempt, terminals }),
      ).toBe(true);
      const results = terminals.map((event) => event.result as { kind: string });
      expect(results.map((result) => result.kind).sort()).toEqual(["committed", "stale-generation"]);
      expect(results).toHaveLength(2);
    }
  }, 240_000);

  it("keeps a paused live owner, then cancels a waiting process without a lost update", async () => {
    const { lockRoot, statePath } = await prepareState();
    const holder = child(lockRoot, statePath, "holder", "pause");
    let contender: Child | undefined;
    try {
      await holder.waitFor((event) => event.event === "ready");
      holder.send("go");
      await holder.waitFor((event) => event.event === "entered");
      contender = child(lockRoot, statePath, "contender", "cancel-wait");
      await contender.waitFor((event) => event.event === "ready");
      contender.send("go");
      await contender.waitFor((event) => event.event === "started");
      contender.send("cancel");
      const cancelled = await contender.waitFor((event) => event.event === "result" || event.event === "error");
      expect(cancelled.event).toBe("error");
      expect(cancelled.message).toBe("cancelled while waiting for scope lock");
      expect(holder.process.exitCode).toBeNull();
      expect(contender.events.some((event) => event.event === "entered")).toBe(false);
      holder.send("continue");
      const completed = await holder.waitFor((event) => event.event === "result");
      expect((completed.result as { kind: string }).kind).toBe("committed");
      expect(await generation(statePath)).toBe(1);
    } finally {
      for (const process of [holder.process, contender?.process]) {
        if (process !== undefined && process.exitCode === null) process.kill("SIGKILL");
      }
      await Promise.all([waitForExit(holder.process), ...(contender === undefined ? [] : [waitForExit(contender.process)])]);
      await rm(lockRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("releases a crashed coordinator process through the real SQLite transaction", async () => {
    const { lockRoot, statePath } = await prepareState();
    const holder = child(lockRoot, statePath, "crashed-holder", "pause");
    const contender = child(lockRoot, statePath, "after-crash");
    try {
      await holder.waitFor((event) => event.event === "ready");
      holder.send("go");
      await holder.waitFor((event) => event.event === "entered");
      holder.process.kill("SIGKILL");
      await waitForExit(holder.process);
      await contender.waitFor((event) => event.event === "ready");
      contender.send("go");
      const completed = await contender.waitFor((event) => event.event === "result");
      expect((completed.result as { kind: string }).kind).toBe("committed");
      expect(await generation(statePath)).toBe(1);
    } finally {
      for (const process of [holder.process, contender.process]) {
        if (process.exitCode === null) process.kill("SIGKILL");
      }
      await Promise.all([waitForExit(holder.process), waitForExit(contender.process)]);
      await rm(lockRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps independent scope locks concurrently usable", async () => {
    const lockRoot = await mkdtemp(join(process.cwd(), ".test-generation-locking-"));
    try {
      const locks = await createSqliteScopeLockManager({
        lockRoot,
        retryDelayMs: { minimum: 1, maximum: 2 },
        verifyLocalFilesystem: async () => {},
      });
      const userLease = await locks.acquire(user, new AbortController().signal);
      const projectLease = await locks.acquire(project, new AbortController().signal);
      await Promise.all([userLease.release(), projectLease.release()]);
      const scheduler = createKeyedMutationScheduler();
      await Promise.all([
        scheduler.run([{ scope: user, plugin: "same@marketplace" as never }], async () => {}, new AbortController().signal),
        scheduler.run([{ scope: project, plugin: "same@marketplace" as never }], async () => {}, new AbortController().signal),
      ]);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });
});
